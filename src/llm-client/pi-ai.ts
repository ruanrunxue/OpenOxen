import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";

import type { CodergenBackend } from "../attractor/handlers.ts";
import type { NodeSpec } from "../attractor/model.ts";
import type { PipelineContext } from "../attractor/context.ts";
import { createAnthropicProfile, createGeminiProfile, createOpenAIProfile } from "../agent/providers.ts";
import { LocalExecutionEnvironment } from "../agent/execution-environment.ts";
import { Session } from "../agent/session.ts";
import type {
  ExecutionEnvironment,
  LLMClient,
  LLMRequest,
  LLMResponse,
  ProviderProfile,
  SessionConfig,
  SessionEvent,
  ToolCall,
} from "../agent/types.ts";

type PiAiLikeResponse = Record<string, unknown>;

export interface PiAiLikeClient {
  complete?: (request: LLMRequest) => Promise<unknown>;
  responses?: {
    create?: (request: Record<string, unknown>) => Promise<unknown>;
  };
  generate?: (request: Record<string, unknown>) => Promise<unknown>;
}

export interface PiOauthLoginResult {
  provider: string;
  status: "ok";
  raw?: unknown;
}

interface PiAiPackage {
  getModel: (provider: string, model: string) => unknown;
  complete: (
    model: unknown,
    context: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  getOAuthApiKey?: (provider: string, credentials: Record<string, unknown>) => Promise<
    | {
        newCredentials: Record<string, unknown>;
        apiKey: string;
      }
    | null
  >;
  loginOpenAICodex?: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  loginAnthropic?: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  loginGitHubCopilot?: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  loginGeminiCli?: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  loginAntigravity?: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".openoxen", "auth.json");

interface NormalizedOauthAuthInfo {
  url?: string;
  instructions?: string;
}

function piTraceEnabled(): boolean {
  return process.env.OPENOXEN_TRACE_PI === "1";
}

function shortenForTrace(input: string, maxChars = 2_000): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}\n...[truncated ${input.length - maxChars} chars]`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function tracePi(label: string, payload: unknown): void {
  if (!piTraceEnabled()) {
    return;
  }
  const rendered = shortenForTrace(safeStringify(payload), 8_000);
  console.log(`[trace][pi] ${label}\n${rendered}`);
}

function toToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ToolCall[] = [];
  for (const call of value) {
    if (!call || typeof call !== "object") {
      continue;
    }
    const raw = call as Record<string, unknown>;
    const id = String(raw.id ?? raw.tool_call_id ?? `tool-${Math.random().toString(16).slice(2)}`);
    const name = String(raw.name ?? raw.tool_name ?? raw.function ?? "");
    let args: Record<string, unknown> = {};
    const rawArgs = raw.arguments ?? raw.args ?? raw.input ?? {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = { raw: rawArgs };
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs as Record<string, unknown>;
    }
    if (name) {
      out.push({ id, name, arguments: args });
    }
  }
  return out;
}

function normalizeResponse(raw: PiAiLikeResponse): LLMResponse {
  const text =
    (typeof raw.text === "string" && raw.text) ||
    (typeof raw.output_text === "string" && raw.output_text) ||
    (typeof raw.content === "string" && raw.content) ||
    "";
  const toolCalls =
    toToolCalls(raw.tool_calls) ||
    toToolCalls(raw.tools) ||
    toToolCalls((raw as { output?: unknown }).output) ||
    [];
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    text,
    tool_calls: toolCalls,
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
  };
}

export function createPiAiClientAdapter(client: PiAiLikeClient): LLMClient {
  return {
    async complete(request: LLMRequest): Promise<LLMResponse> {
      let raw: unknown;
      if (client.complete) {
        raw = await client.complete(request);
      } else if (client.responses?.create) {
        raw = await client.responses.create(request as unknown as Record<string, unknown>);
      } else if (client.generate) {
        raw = await client.generate(request as unknown as Record<string, unknown>);
      } else {
        throw new Error("pi-ai client does not expose a supported completion method");
      }
      if (!raw || typeof raw !== "object") {
        return { text: String(raw ?? ""), tool_calls: [] };
      }
      return normalizeResponse(raw as PiAiLikeResponse);
    },
  };
}

function authFilePath(): string {
  return process.env.OPENOXEN_AUTH_FILE ?? DEFAULT_AUTH_FILE;
}

async function loadAuthStore(): Promise<Record<string, unknown>> {
  try {
    const file = authFilePath();
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

async function saveAuthStore(store: Record<string, unknown>): Promise<void> {
  const file = authFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

async function loadPiAiPackage(): Promise<PiAiPackage> {
  try {
    return (await import("@mariozechner/pi-ai")) as unknown as PiAiPackage;
  } catch (error) {
    throw new Error(
      `Cannot load @mariozechner/pi-ai. Install it with \`npm install @mariozechner/pi-ai\`. Cause: ${String(error)}`,
    );
  }
}

function mapProviderForPi(provider: string): string {
  if (process.env.OPENOXEN_PI_PROVIDER) {
    return process.env.OPENOXEN_PI_PROVIDER;
  }
  if (provider === "openai") {
    return "openai-codex";
  }
  if (provider === "gemini") {
    return "google";
  }
  return provider;
}

function fallbackModel(provider: string): string {
  if (provider === "openai-codex") {
    return process.env.OPENOXEN_CODEX_MODEL ?? "codex-mini-latest";
  }
  if (provider === "anthropic") {
    return "claude-sonnet-4-5";
  }
  if (provider === "google") {
    return "gemini-2.5-flash";
  }
  return "gpt-4o-mini";
}

function toPiToolSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  return parameters;
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

function toPiToolCallBlock(call: ToolCall): Record<string, unknown> {
  return {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.arguments,
  };
}

export function buildPiContext(request: LLMRequest): Record<string, unknown> {
  const contextMessages: Array<Record<string, unknown>> = [];
  const toolCallNameById = new Map<string, string>();
  let systemPrompt = "";
  let timestamp = Date.now();

  for (const message of request.messages) {
    if (message.role === "system") {
      if (!systemPrompt) {
        systemPrompt = message.content;
      } else {
        systemPrompt = `${systemPrompt}\n\n${message.content}`;
      }
      continue;
    }

    if (message.role === "user") {
      contextMessages.push({
        role: "user",
        content: [textBlock(message.content)],
        timestamp,
      });
      timestamp += 1;
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (message.content.trim().length > 0) {
        content.push(textBlock(message.content));
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        toolCallNameById.set(call.id, call.name);
        content.push(toPiToolCallBlock(call));
      }
      if (content.length === 0) {
        continue;
      }
      contextMessages.push({
        role: "assistant",
        content,
        timestamp,
      });
      timestamp += 1;
      continue;
    }

    if (message.role === "tool") {
      const toolCallId = message.tool_call_id ?? `tool_${timestamp}`;
      contextMessages.push({
        role: "toolResult",
        toolCallId,
        toolName: message.tool_name ?? toolCallNameById.get(toolCallId) ?? "tool",
        content: [textBlock(message.content)],
        isError: Boolean(message.is_error ?? false),
        timestamp,
      });
      timestamp += 1;
    }
  }

  const tools = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toPiToolSchema(tool.parameters),
  }));

  return {
    systemPrompt,
    messages: contextMessages,
    tools,
  };
}

function extractResponseText(response: Record<string, unknown>): { text: string; toolCalls: ToolCall[]; reasoning?: string } {
  const content = Array.isArray(response.content) ? (response.content as Array<Record<string, unknown>>) : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    const type = String(block.type ?? "");
    if (type === "text") {
      textParts.push(String(block.text ?? ""));
      continue;
    }
    if (type === "thinking") {
      reasoningParts.push(String(block.text ?? ""));
      continue;
    }
    if (type === "toolCall") {
      toolCalls.push({
        id: String(block.id ?? block.toolCallId ?? `tool-${Math.random().toString(16).slice(2)}`),
        name: String(block.name ?? block.toolName ?? ""),
        arguments:
          typeof block.arguments === "object" && block.arguments !== null
            ? (block.arguments as Record<string, unknown>)
            : typeof block.args === "object" && block.args !== null
              ? (block.args as Record<string, unknown>)
            : {},
      });
    }
  }

  if (textParts.length === 0 && typeof response.text === "string") {
    textParts.push(response.text);
  }
  if (textParts.length === 0 && typeof response.output_text === "string") {
    textParts.push(response.output_text);
  }

  return {
    text: textParts.join("\n").trim(),
    toolCalls,
    reasoning: reasoningParts.length ? reasoningParts.join("\n") : undefined,
  };
}

const OAUTH_PROVIDERS = new Set([
  "openai-codex",
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
]);

async function resolveOauthApiKey(
  pi: PiAiPackage,
  provider: string,
): Promise<string | undefined> {
  if (!OAUTH_PROVIDERS.has(provider)) {
    return undefined;
  }
  if (!pi.getOAuthApiKey) {
    throw new Error("@mariozechner/pi-ai does not export getOAuthApiKey in this version.");
  }

  const auth = await loadAuthStore();
  const result = await pi.getOAuthApiKey(provider, auth);
  if (!result) {
    throw new Error(
      `No OAuth credentials for provider '${provider}'. Run: openoxen login --provider ${provider}`,
    );
  }
  auth[provider] = { type: "oauth", ...result.newCredentials };
  await saveAuthStore(auth);
  return result.apiKey;
}

export async function createPiAiClientAdapterFromEnv(): Promise<LLMClient> {
  if (process.env.OPENOXEN_FAKE_PI === "1") {
    return createPiAiClientAdapter({
      async complete(request) {
        const last = request.messages[request.messages.length - 1];
        return {
          id: "fake-pi",
          text: `[FAKE-PI] ${String(last?.content ?? "")}`,
          tool_calls: [],
        };
      },
    });
  }

  const pi = await loadPiAiPackage();

  return {
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const provider = mapProviderForPi(request.provider);
      const requestedModel = process.env.OPENOXEN_MODEL ?? request.model;
      let model: unknown;
      try {
        model = pi.getModel(provider, requestedModel);
      } catch {
        model = pi.getModel(provider, fallbackModel(provider));
      }

      const context = buildPiContext(request);
      const options: Record<string, unknown> = {};
      const oauthApiKey = await resolveOauthApiKey(pi, provider);
      if (oauthApiKey) {
        options.apiKey = oauthApiKey;
      }
      if (request.reasoning_effort) {
        options.reasoningEffort = request.reasoning_effort;
      }
      if (request.provider_options && typeof request.provider_options === "object") {
        Object.assign(options, request.provider_options);
      }

      const modelLabel =
        typeof model === "object" && model !== null && typeof (model as { id?: unknown }).id === "string"
          ? String((model as { id: string }).id)
          : requestedModel;
      tracePi("request.meta", {
        provider,
        model: modelLabel,
        messageCount: Array.isArray((context as { messages?: unknown }).messages)
          ? ((context as { messages: unknown[] }).messages.length ?? 0)
          : 0,
        toolCount: Array.isArray((context as { tools?: unknown }).tools)
          ? ((context as { tools: unknown[] }).tools.length ?? 0)
          : 0,
        hasApiKey: typeof options.apiKey === "string" && String(options.apiKey).length > 0,
      });
      tracePi("request.context", context);
      tracePi("request.options", { ...options, apiKey: options.apiKey ? "[REDACTED]" : undefined });

      const response = await pi.complete(model, context, options);
      tracePi("response.raw", response);
      const extracted = extractResponseText(response);
      const usageRaw =
        typeof response.usage === "object" && response.usage !== null
          ? (response.usage as Record<string, unknown>)
          : undefined;
      const inputTokens =
        typeof usageRaw?.inputTokens === "number"
          ? usageRaw.inputTokens
          : typeof usageRaw?.promptTokens === "number"
            ? usageRaw.promptTokens
            : undefined;
      const outputTokens =
        typeof usageRaw?.outputTokens === "number"
          ? usageRaw.outputTokens
          : typeof usageRaw?.completionTokens === "number"
            ? usageRaw.completionTokens
            : undefined;

      return {
        id: typeof response.id === "string" ? response.id : undefined,
        text: extracted.text,
        tool_calls: extracted.toolCalls,
        reasoning: extracted.reasoning,
        usage:
          inputTokens !== undefined || outputTokens !== undefined
            ? {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              }
            : undefined,
      };
    },
  };
}

async function promptUser(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(`${message} `)).trim();
  } finally {
    rl.close();
  }
}

export function normalizeOauthAuthInfo(info: unknown): NormalizedOauthAuthInfo {
  if (typeof info === "string") {
    return { url: info };
  }
  if (!info || typeof info !== "object") {
    return {};
  }
  const obj = info as Record<string, unknown>;
  const url = typeof obj.url === "string" ? obj.url : undefined;
  const instructions = typeof obj.instructions === "string" ? obj.instructions : undefined;
  return { url, instructions };
}

function browserOpenCommand(url: string): { cmd: string; args: string[] } {
  if (process.platform === "darwin") {
    return { cmd: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { cmd: "cmd", args: ["/c", "start", "", url] };
  }
  return { cmd: "xdg-open", args: [url] };
}

async function openUrlInBrowser(url: string): Promise<boolean> {
  if (!url || process.env.OPENOXEN_NO_BROWSER === "1") {
    return false;
  }
  const { cmd, args } = browserOpenCommand(url);
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function loginFnByProvider(pi: PiAiPackage, provider: string): ((opts?: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined {
  if (provider === "openai-codex") {
    return pi.loginOpenAICodex;
  }
  if (provider === "anthropic") {
    return pi.loginAnthropic;
  }
  if (provider === "github-copilot") {
    return pi.loginGitHubCopilot;
  }
  if (provider === "google-gemini-cli") {
    return pi.loginGeminiCli;
  }
  if (provider === "google-antigravity") {
    return pi.loginAntigravity;
  }
  return undefined;
}

export async function loginPiWithOauthFromEnv(provider = "openai-codex"): Promise<PiOauthLoginResult> {
  if (process.env.OPENOXEN_FAKE_PI === "1") {
    return { provider, status: "ok", raw: { fake: true } };
  }

  const pi = await loadPiAiPackage();
  const loginFn = loginFnByProvider(pi, provider);
  if (!loginFn) {
    throw new Error(
      `Unsupported OAuth provider '${provider}'. Supported: openai-codex, anthropic, github-copilot, google-gemini-cli, google-antigravity`,
    );
  }

  const credentials = await loginFn({
    onAuth: (authInfo: unknown) => {
      const normalized = normalizeOauthAuthInfo(authInfo);
      if (normalized.url) {
        console.log(`Open: ${normalized.url}`);
        void openUrlInBrowser(normalized.url).then((opened) => {
          if (!opened) {
            console.log("Could not open browser automatically. Open the URL manually.");
          }
        });
      } else {
        console.log(`Open: ${String(authInfo)}`);
      }
      if (normalized.instructions) {
        console.log(normalized.instructions);
      }
    },
    onPrompt: async (prompt: { message?: string } | string) => {
      const message =
        typeof prompt === "string" ? prompt : String(prompt?.message ?? "Enter OAuth code:");
      return promptUser(message);
    },
    onProgress: (message: string) => {
      if (message) {
        console.log(message);
      }
    },
  });

  const auth = await loadAuthStore();
  auth[provider] = { type: "oauth", ...credentials };
  await saveAuthStore(auth);
  return { provider, status: "ok", raw: credentials };
}

interface CodergenBackendOptions {
  model?: string;
  provider?: string;
  reasoning_effort?: string | null;
  providerProfile?: ProviderProfile;
  executionEnv?: ExecutionEnvironment;
  sessionConfig?: Partial<SessionConfig>;
  reuseSession?: boolean;
  onSessionEvent?: (event: SessionEvent) => void;
  onAgentInput?: (payload: { nodeId: string; prompt: string }) => void;
  onAgentOutput?: (payload: { nodeId: string; responseText: string }) => void;
}

function resolveProviderProfile(options: CodergenBackendOptions): ProviderProfile {
  if (options.providerProfile) {
    return options.providerProfile;
  }
  const provider = options.provider ?? "openai";
  const model = options.model;
  if (provider === "anthropic") {
    return createAnthropicProfile(model ?? "claude-sonnet-4-5");
  }
  if (provider === "gemini") {
    return createGeminiProfile(model ?? "gemini-2.5-pro");
  }
  return createOpenAIProfile(model ?? "gpt-5.2-codex");
}

export function createPiAiCodergenBackend(
  client: LLMClient,
  options: CodergenBackendOptions,
): CodergenBackend {
  const providerProfile = resolveProviderProfile(options);
  const executionEnv =
    options.executionEnv ??
    new LocalExecutionEnvironment({
      workingDir: process.cwd(),
    });
  const reuseSession = options.reuseSession ?? true;
  let cachedSession: Session | undefined;

  function session(): Session {
    if (!reuseSession || !cachedSession) {
      cachedSession = new Session({
        providerProfile,
        executionEnv,
        llmClient: client,
        config: {
          ...(options.sessionConfig ?? {}),
          reasoning_effort: options.reasoning_effort ?? options.sessionConfig?.reasoning_effort ?? null,
        },
        onEvent: options.onSessionEvent,
      });
    }
    return cachedSession;
  }

  return {
    async run(node: NodeSpec, prompt: string, _context: PipelineContext): Promise<string> {
      options.onAgentInput?.({ nodeId: node.id, prompt });
      const result = await session().submit(
        `Attractor codergen stage: ${node.id}\n\n${prompt}\n\nRespond with the best direct answer for this stage.`,
      );
      options.onAgentOutput?.({ nodeId: node.id, responseText: result.text });
      return result.text;
    },
  };
}
