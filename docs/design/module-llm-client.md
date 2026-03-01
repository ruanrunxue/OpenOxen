# LLM Client Module Design (`src/llm-client`)

## 1. Responsibilities

`llm-client` 负责把 agent 的统一请求模型适配到具体 LLM SDK。当前默认实现是 `pi-ai`：

1. provider/model 映射（OpenOxen -> pi provider）。
2. 消息结构转换（agent request -> pi context）。
3. 响应结构转换（pi response -> agent response）。
4. OAuth 登录与凭证存储。
5. 为 Attractor 提供基于 agent 的 codergen backend 封装。

## 2. Core APIs

1. `createPiAiClientAdapterFromEnv()`
- 读取环境变量与 OAuth 凭证
- 懒加载 `@mariozechner/pi-ai`
- 返回符合 `LLMClient` 接口的实例

2. `buildPiContext(request)`
- 把 `LLMRequest` 转换为 `pi-ai Context`
- 支持 system/user/assistant/toolResult
- 保留 assistant `toolCall` 与 toolResult 关联

3. `loginPiWithOauthFromEnv(provider)`
- 调用 `pi-ai` 的登录函数
- 存储刷新后的 OAuth 凭证

4. `createPiAiCodergenBackend(client, options)`
- 通过内部 `Session` 复用 agent-loop 能力
- 给 Attractor 提供 `CodergenBackend`

## 3. Context Mapping Strategy

映射关键点：

1. `LLMMessage.system` -> `Context.systemPrompt`  
2. `LLMMessage.user` -> `Context.messages(role=user)`  
3. `LLMMessage.assistant`
- 文本转 `text` block
- `tool_calls` 转 `toolCall` block
4. `LLMMessage.tool`
- 转 `toolResult`，包含 `toolCallId/toolName/isError`

这保证了与 `pi-ai`/`pi-mono` 工具循环语义一致。

## 4. Response Normalization

`extractResponseText` 从 `pi.complete()` 结果中提取：

1. 文本输出（`text` blocks 或兼容字段）。  
2. `toolCall` blocks 转 `ToolCall[]`。  
3. reasoning 文本。  
4. usage 字段在不同 provider 返回形态下做统一。

## 5. OAuth Design

1. 凭证文件默认：`~/.openoxen/auth.json`（可由 `OPENOXEN_AUTH_FILE` 覆盖）。  
2. 支持 provider：
- `openai-codex`
- `anthropic`
- `github-copilot`
- `google-gemini-cli`
- `google-antigravity`
3. 支持自动尝试打开浏览器（可关闭）。

## 6. Observability

1. 业务 trace（CLI 层）展示 agent 与工具链路。  
2. 适配层 trace（`OPENOXEN_TRACE_PI=1`）展示：
- provider/model 元信息
- 实际发送的 pi context
- options（敏感字段脱敏）
- 原始响应摘要

## 7. Design Trade-offs

1. 当前以 `pi-ai` 为默认实现  
优点：统一 provider 能力与 OAuth 能力。  
代价：与 `pi-ai` 版本耦合较强，需要关注 API 变更。

2. 在 `llm-client` 内提供 codergen backend 工厂  
优点：上层使用简单，直接接到 Attractor。  
代价：`llm-client` 同时承担“SDK 适配 + backend 组装”两类职责，后续可按规模再拆分。

