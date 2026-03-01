# LLM Client Module Design (`src/llm-client`)

## 1. 职责

`llm-client` 是模型适配层，负责把 agent 的统一接口转换到具体 SDK。当前内置实现为 `pi-ai`。

主要职责：

1. provider/model 映射与默认策略。
2. `LLMRequest` -> `pi context` 的结构转换。
3. `pi response` -> `LLMResponse` 的标准化。
4. OAuth 登录与凭证存储。
5. 为 Attractor 提供基于 agent 的 codergen backend。

## 2. 关键 API

- `createPiAiClientAdapterFromEnv()`
- `createPiAiClientAdapter(client)`
- `buildPiContext(request)`
- `loginPiWithOauthFromEnv(provider)`
- `createPiAiCodergenBackend(client, options)`

## 3. 上下文映射

`buildPiContext` 会保留：
- system prompt
- user/assistant 文本
- assistant tool calls
- tool result 与 tool_call_id 的关联

该映射保证 agent loop 的工具调用链在 pi 上可追踪。

## 4. OAuth 与凭证

默认凭证位置：
- `~/.openoxen/config/auth.json`

可配置：
- `OPENOXEN_AUTH_FILE`
- `OPENOXEN_HOME`

支持 provider（按当前实现）：
- `openai-codex`
- `anthropic`
- `github-copilot`
- `google-gemini-cli`
- `google-antigravity`

## 5. 观测能力

- `OPENOXEN_TRACE_PI=1` 时，打印适配层请求/响应摘要。
- 敏感字段会脱敏后再输出。

## 6. 设计取舍

1. 默认依赖 `@mariozechner/pi-ai`
- 优点：provider 统一、OAuth 流程成熟。
- 代价：需持续跟进上游 API 变更。

2. 在本模块内提供 codergen backend 工厂
- 优点：上层接入简单。
- 代价：本层同时承担 SDK 适配与 backend 组装职责。
