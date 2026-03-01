export type SessionState = "IDLE" | "PROCESSING" | "AWAITING_INPUT" | "CLOSED";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

export interface LLMUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface LLMResponse {
  id?: string;
  text: string;
  tool_calls: ToolCall[];
  reasoning?: string;
  usage?: LLMUsage;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  is_error?: boolean;
}

export interface LLMRequest {
  model: string;
  provider: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  tool_choice: "auto";
  reasoning_effort?: string | null;
  provider_options?: Record<string, unknown> | null;
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface SessionConfig {
  max_turns: number;
  max_tool_rounds_per_input: number;
  default_command_timeout_ms: number;
  max_command_timeout_ms: number;
  reasoning_effort: string | null;
  tool_output_limits: Record<string, number>;
  tool_line_limits: Record<string, number | null>;
  enable_loop_detection: boolean;
  loop_detection_window: number;
  max_subagent_depth: number;
}

export interface SessionEvent {
  kind:
    | "SESSION_START"
    | "SESSION_END"
    | "USER_INPUT"
    | "ASSISTANT_TEXT_END"
    | "TOOL_CALL_START"
    | "TOOL_CALL_END"
    | "STEERING_INJECTED"
    | "TURN_LIMIT"
    | "LOOP_DETECTION"
    | "ERROR";
  timestamp: string;
  session_id: string;
  data: Record<string, unknown>;
}

export interface UserTurn {
  kind: "user";
  content: string;
  timestamp: string;
}

export interface AssistantTurn {
  kind: "assistant";
  content: string;
  tool_calls: ToolCall[];
  reasoning?: string;
  usage?: LLMUsage;
  response_id?: string;
  timestamp: string;
}

export interface ToolResultsTurn {
  kind: "tool_results";
  results: ToolResult[];
  timestamp: string;
}

export interface SystemTurn {
  kind: "system";
  content: string;
  timestamp: string;
}

export interface SteeringTurn {
  kind: "steering";
  content: string;
  timestamp: string;
}

export type Turn = UserTurn | AssistantTurn | ToolResultsTurn | SystemTurn | SteeringTurn;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (
    args: Record<string, unknown>,
    env: ExecutionEnvironment,
    session?: SessionToolContext,
  ) => Promise<string> | string;
}

export interface SessionToolContext {
  spawnSubAgent(args: Record<string, unknown>): Promise<string>;
  sendSubAgentInput(args: Record<string, unknown>): Promise<string>;
  waitSubAgent(args: Record<string, unknown>): Promise<string>;
  closeSubAgent(args: Record<string, unknown>): Promise<string>;
}

export interface ProviderProfile {
  id: string;
  model: string;
  toolRegistry: ToolRegistry;
  buildSystemPrompt(environment: ExecutionEnvironment, projectDocs: string): Promise<string> | string;
  tools(): ToolDefinition[];
  providerOptions(): Record<string, unknown> | null;
  supports_reasoning: boolean;
  supports_streaming: boolean;
  supports_parallel_tool_calls: boolean;
  context_window_size: number;
}

export interface ToolRegistry {
  register(tool: RegisteredTool): void;
  unregister(name: string): void;
  get(name: string): RegisteredTool | undefined;
  definitions(): ToolDefinition[];
  names(): string[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number | null;
}

export interface ExecutionEnvironment {
  readFile(path: string, offset?: number | null, limit?: number | null): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  listDirectory(path: string, depth: number): Promise<DirEntry[]>;
  execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string | null,
    envVars?: Record<string, string> | null,
  ): Promise<ExecResult>;
  grep(pattern: string, path: string, options?: Record<string, unknown>): Promise<string>;
  glob(pattern: string, path: string): Promise<string[]>;
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
  workingDirectory(): string;
  platform(): string;
  osVersion(): string;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_turns: 0,
  max_tool_rounds_per_input: 0,
  default_command_timeout_ms: 10_000,
  max_command_timeout_ms: 600_000,
  reasoning_effort: null,
  tool_output_limits: {},
  tool_line_limits: {},
  enable_loop_detection: true,
  loop_detection_window: 10,
  max_subagent_depth: 1,
};
