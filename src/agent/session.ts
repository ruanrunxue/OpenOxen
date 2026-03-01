import { randomUUID } from "node:crypto";

import { buildProjectDocs } from "./providers.ts";
import { validateToolArguments } from "./tool-registry.ts";
import { truncateToolOutput } from "./truncation.ts";
import {
  DEFAULT_SESSION_CONFIG,
  type AssistantTurn,
  type ExecutionEnvironment,
  type LLMClient,
  type LLMMessage,
  type LLMRequest,
  type ProviderProfile,
  type SessionConfig,
  type SessionEvent,
  type SessionState,
  type SteeringTurn,
  type ToolCall,
  type ToolResult,
  type ToolResultsTurn,
  type Turn,
  type UserTurn,
} from "./types.ts";

interface SubAgentHandle {
  id: string;
  session: Session;
  status: "running" | "completed" | "failed";
  completion: Promise<{ text: string }>;
}

interface SessionOptions {
  providerProfile: ProviderProfile;
  executionEnv: ExecutionEnvironment;
  llmClient: LLMClient;
  config?: Partial<SessionConfig>;
  depth?: number;
  onEvent?: (event: SessionEvent) => void;
}

function now(): string {
  return new Date().toISOString();
}

function hashCall(call: ToolCall): string {
  const args = JSON.stringify(call.arguments ?? {});
  return `${call.name}:${args}`;
}

function defaultConfig(override: Partial<SessionConfig> | undefined): SessionConfig {
  return {
    ...DEFAULT_SESSION_CONFIG,
    ...override,
    tool_output_limits: {
      ...DEFAULT_SESSION_CONFIG.tool_output_limits,
      ...(override?.tool_output_limits ?? {}),
    },
    tool_line_limits: {
      ...DEFAULT_SESSION_CONFIG.tool_line_limits,
      ...(override?.tool_line_limits ?? {}),
    },
  };
}

export class Session {
  readonly #id = randomUUID();
  readonly #providerProfile: ProviderProfile;
  readonly #executionEnv: ExecutionEnvironment;
  readonly #llmClient: LLMClient;
  readonly #config: SessionConfig;
  readonly #onEvent?: (event: SessionEvent) => void;
  #state: SessionState = "IDLE";
  #history: Turn[] = [];
  #events: SessionEvent[] = [];
  #steeringQueue: string[] = [];
  #followupQueue: string[] = [];
  #subagents = new Map<string, SubAgentHandle>();
  #depth: number;

  constructor(options: SessionOptions) {
    this.#providerProfile = options.providerProfile;
    this.#executionEnv = options.executionEnv;
    this.#llmClient = options.llmClient;
    this.#config = defaultConfig(options.config);
    this.#onEvent = options.onEvent;
    this.#depth = options.depth ?? 0;
    this.emit("SESSION_START", {});
  }

  state(): SessionState {
    return this.#state;
  }

  history(): Turn[] {
    return [...this.#history];
  }

  events(): SessionEvent[] {
    return [...this.#events];
  }

  config(): SessionConfig {
    return this.#config;
  }

  steer(message: string): void {
    this.#steeringQueue.push(message);
  }

  followUp(message: string): void {
    this.#followupQueue.push(message);
  }

  async submit(userInput: string): Promise<{ text: string }> {
    if (this.#state === "CLOSED") {
      throw new Error("Session is closed");
    }
    return this.processInput(userInput);
  }

  close(): void {
    this.#state = "CLOSED";
    this.emit("SESSION_END", { state: this.#state });
  }

  #appendTurn(turn: Turn): void {
    this.#history.push(turn);
  }

  #countTurns(): number {
    return this.#history.filter((t) => t.kind === "assistant" || t.kind === "user" || t.kind === "tool_results")
      .length;
  }

  emit(kind: SessionEvent["kind"], data: Record<string, unknown>): void {
    const event: SessionEvent = { kind, data, timestamp: now(), session_id: this.#id };
    this.#events.push(event);
    if (this.#onEvent) {
      try {
        this.#onEvent(event);
      } catch {
        // Event sinks must never break session execution.
      }
    }
  }

  async processInput(userInput: string): Promise<{ text: string }> {
    this.#state = "PROCESSING";
    const userTurn: UserTurn = { kind: "user", content: userInput, timestamp: now() };
    this.#appendTurn(userTurn);
    this.emit("USER_INPUT", { content: userInput });

    await this.#drainSteering();
    let rounds = 0;
    let lastText = "";

    while (true) {
      if (this.#config.max_tool_rounds_per_input > 0 && rounds >= this.#config.max_tool_rounds_per_input) {
        this.emit("TURN_LIMIT", { round: rounds });
        break;
      }
      if (this.#config.max_turns > 0 && this.#countTurns() >= this.#config.max_turns) {
        this.emit("TURN_LIMIT", { total_turns: this.#countTurns() });
        break;
      }
      const request = await this.#buildRequest();
      const response = await this.#llmClient.complete(request);
      lastText = response.text ?? "";

      const assistantTurn: AssistantTurn = {
        kind: "assistant",
        content: response.text ?? "",
        tool_calls: response.tool_calls ?? [],
        reasoning: response.reasoning,
        usage: response.usage,
        response_id: response.id,
        timestamp: now(),
      };
      this.#appendTurn(assistantTurn);
      this.emit("ASSISTANT_TEXT_END", {
        text: response.text ?? "",
        reasoning: response.reasoning ?? "",
      });

      if (!response.tool_calls?.length) {
        break;
      }

      rounds += 1;
      const results = await this.#executeToolCalls(response.tool_calls);
      const toolTurn: ToolResultsTurn = { kind: "tool_results", results, timestamp: now() };
      this.#appendTurn(toolTurn);

      await this.#drainSteering();
      if (this.#config.enable_loop_detection && this.#detectLoop(this.#config.loop_detection_window)) {
        const warning =
          `Loop detected: the last ${this.#config.loop_detection_window} tool calls follow a repeating pattern. ` +
          "Try a different approach.";
        const steeringTurn: SteeringTurn = { kind: "steering", content: warning, timestamp: now() };
        this.#appendTurn(steeringTurn);
        this.emit("LOOP_DETECTION", { message: warning });
      }
    }

    if (this.#followupQueue.length > 0) {
      const next = this.#followupQueue.shift()!;
      await this.processInput(next);
    }

    this.#state = "IDLE";
    this.emit("SESSION_END", { state: this.#state });
    return { text: lastText };
  }

  async #buildRequest(): Promise<LLMRequest> {
    const projectDocs = await buildProjectDocs(this.#executionEnv, this.#providerProfile.id);
    const systemPrompt = await this.#providerProfile.buildSystemPrompt(this.#executionEnv, projectDocs);
    const messages: LLMMessage[] = [{ role: "system", content: systemPrompt }];
    const toolCallNameById = new Map<string, string>();
    for (const turn of this.#history) {
      if (turn.kind === "user" || turn.kind === "steering" || turn.kind === "system") {
        messages.push({ role: "user", content: turn.content });
      } else if (turn.kind === "assistant") {
        for (const call of turn.tool_calls) {
          toolCallNameById.set(call.id, call.name);
        }
        if (turn.content || turn.tool_calls.length > 0) {
          messages.push({
            role: "assistant",
            content: turn.content,
            tool_calls: turn.tool_calls,
          });
        }
      } else if (turn.kind === "tool_results") {
        for (const result of turn.results) {
          messages.push({
            role: "tool",
            content: result.content,
            tool_call_id: result.tool_call_id,
            tool_name: toolCallNameById.get(result.tool_call_id),
            is_error: result.is_error,
          });
        }
      }
    }
    return {
      model: this.#providerProfile.model,
      provider: this.#providerProfile.id,
      messages,
      tools: this.#providerProfile.tools(),
      tool_choice: "auto",
      reasoning_effort: this.#config.reasoning_effort,
      provider_options: this.#providerProfile.providerOptions(),
    };
  }

  async #drainSteering(): Promise<void> {
    while (this.#steeringQueue.length) {
      const message = this.#steeringQueue.shift()!;
      const turn: SteeringTurn = { kind: "steering", content: message, timestamp: now() };
      this.#appendTurn(turn);
      this.emit("STEERING_INJECTED", { content: message });
    }
  }

  async #executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    if (this.#providerProfile.supports_parallel_tool_calls && toolCalls.length > 1) {
      return Promise.all(toolCalls.map((call) => this.#executeSingleTool(call)));
    }
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      results.push(await this.#executeSingleTool(call));
    }
    return results;
  }

  async #executeSingleTool(call: ToolCall): Promise<ToolResult> {
    this.emit("TOOL_CALL_START", { tool_name: call.name, call_id: call.id });
    const registered = this.#providerProfile.toolRegistry.get(call.name);
    if (!registered) {
      const error = `Unknown tool: ${call.name}`;
      this.emit("TOOL_CALL_END", { call_id: call.id, error });
      return { tool_call_id: call.id, content: error, is_error: true };
    }
    const args = typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {};
    const valid = validateToolArguments(registered.definition, args);
    if (!valid.valid) {
      const error = `Tool argument error (${call.name}): ${valid.error}`;
      this.emit("TOOL_CALL_END", { call_id: call.id, error });
      return { tool_call_id: call.id, content: error, is_error: true };
    }
    try {
      const raw = await registered.execute(args, this.#executionEnv, {
        spawnSubAgent: (params) => this.#spawnSubAgent(params),
        sendSubAgentInput: (params) => this.#sendSubAgentInput(params),
        waitSubAgent: (params) => this.#waitSubAgent(params),
        closeSubAgent: (params) => this.#closeSubAgent(params),
      });
      const truncated = truncateToolOutput(String(raw), call.name, this.#config);
      this.emit("TOOL_CALL_END", { call_id: call.id, output: String(raw) });
      return { tool_call_id: call.id, content: truncated, is_error: false };
    } catch (error) {
      const errorMsg = `Tool error (${call.name}): ${String(error)}`;
      this.emit("TOOL_CALL_END", { call_id: call.id, error: errorMsg });
      return { tool_call_id: call.id, content: errorMsg, is_error: true };
    }
  }

  #extractToolSignatures(limit: number): string[] {
    const signatures: string[] = [];
    for (const turn of this.#history) {
      if (turn.kind !== "assistant") {
        continue;
      }
      for (const call of turn.tool_calls) {
        signatures.push(hashCall(call));
      }
    }
    return signatures.slice(-limit);
  }

  #detectLoop(windowSize: number): boolean {
    const recent = this.#extractToolSignatures(windowSize);
    if (recent.length < windowSize) {
      return false;
    }
    for (const patternLen of [1, 2, 3]) {
      if (windowSize % patternLen !== 0) {
        continue;
      }
      const pattern = recent.slice(0, patternLen).join("||");
      let allMatch = true;
      for (let i = patternLen; i < recent.length; i += patternLen) {
        if (recent.slice(i, i + patternLen).join("||") !== pattern) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return true;
      }
    }
    return false;
  }

  async #spawnSubAgent(args: Record<string, unknown>): Promise<string> {
    if (this.#depth >= this.#config.max_subagent_depth) {
      throw new Error("Subagent depth limit exceeded");
    }
    const task = String(args.task ?? "");
    const child = new Session({
      providerProfile: this.#providerProfile,
      executionEnv: this.#executionEnv,
      llmClient: this.#llmClient,
      config: this.#config,
      depth: this.#depth + 1,
    });
    const id = randomUUID();
    const handle: SubAgentHandle = {
      id,
      session: child,
      status: "running",
      completion: child
        .submit(task)
        .then((result) => {
          handle.status = "completed";
          return result;
        })
        .catch((error) => {
          handle.status = "failed";
          throw error;
        }),
    };
    this.#subagents.set(id, handle);
    return JSON.stringify({ agent_id: id, status: handle.status });
  }

  async #sendSubAgentInput(args: Record<string, unknown>): Promise<string> {
    const id = String(args.agent_id ?? "");
    const message = String(args.message ?? "");
    const handle = this.#subagents.get(id);
    if (!handle) {
      throw new Error(`Subagent not found: ${id}`);
    }
    const result = await handle.session.submit(message);
    return JSON.stringify({ agent_id: id, accepted: true, latest: result.text });
  }

  async #waitSubAgent(args: Record<string, unknown>): Promise<string> {
    const id = String(args.agent_id ?? "");
    const handle = this.#subagents.get(id);
    if (!handle) {
      throw new Error(`Subagent not found: ${id}`);
    }
    const result = await handle.completion;
    return JSON.stringify({
      output: result.text,
      success: handle.status === "completed",
    });
  }

  async #closeSubAgent(args: Record<string, unknown>): Promise<string> {
    const id = String(args.agent_id ?? "");
    const handle = this.#subagents.get(id);
    if (!handle) {
      throw new Error(`Subagent not found: ${id}`);
    }
    handle.session.close();
    this.#subagents.delete(id);
    return JSON.stringify({ agent_id: id, status: "closed" });
  }
}
