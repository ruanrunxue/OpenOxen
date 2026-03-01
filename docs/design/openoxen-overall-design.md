# OpenOxen Overall Design

## 1. Design Goals

OpenOxen 的目标是将“需求 -> 代码实现 -> 测试验证”的流程标准化为可执行的 pipeline，并通过 agent-loop 与统一 LLM client 实现可替换模型能力。

核心设计目标：

1. 与 Attractor 和 Coding Agent Loop 规范保持语义一致。
2. 明确分层，避免 `attractor` 直接依赖具体 LLM SDK。
3. 默认可观测，运行时可追踪 prompt、tool call、阶段输出。
4. 默认安全，工具执行在本地受控环境中进行。
5. 易扩展，可替换 provider、tool、runtime 组件。

## 2. Design Principles

1. Single Responsibility  
每个模块只负责一个抽象层：`cli` 负责交互入口，`attractor` 负责流程编排，`agent` 负责推理与工具循环，`llm-client` 负责模型协议适配。

2. Interface First  
模块之间通过稳定接口协作：
- `CodergenBackend`：attractor 对 agent 的依赖面
- `LLMClient`：agent 对模型调用的依赖面
- `ExecutionEnvironment`：agent 对执行环境的依赖面

3. Deterministic Pipeline + Non-deterministic Intelligence  
流程路由尽量确定（DOT + 条件 + retry + human gate），智能不确定性仅存在于 codergen/agent 阶段。

4. Observable by Default  
`openoxen dev` 默认输出关键链路日志；可通过环境变量进一步看到 `llm-client -> pi-ai` 的真实请求上下文。

5. Fail Explicitly  
测试失败、条件不满足、路由缺失、无效 DOT 等都明确失败，不做静默吞错。

## 3. High-level Architecture

```mermaid
flowchart LR
  U[User] --> CLI[src/cli]
  CLI --> ATTR[src/attractor]
  ATTR -->|CodergenBackend| AG[src/agent]
  AG -->|LLMClient.complete| LLM[src/llm-client]
  LLM --> PI[@mariozechner/pi-ai]
  AG --> ENV[LocalExecutionEnvironment]
  ATTR --> LOGS[Run Logs / Checkpoints]
```

关键约束：
- `attractor` 不直接调用 `@mariozechner/pi-ai`。
- `attractor -> agent -> llm-client -> pi-ai` 是唯一模型调用路径。

## 4. Core Runtime Flow (`openoxen dev`)

1. CLI 解析需求、任务名与日志级别。  
2. 使用 agent 生成 DOT（若不合法则回退模板）。  
3. DOT 文件落地到用户当前目录（时间戳或 `--task` 文件名）。  
4. Attractor 立即执行 DOT。  
5. box 节点由 codergen backend 调用 agent 执行；parallelogram 节点执行测试命令。  
6. 默认链路：`write_tests -> develop -> review -> test`。  
7. 测试失败最多 5 轮，进入人工介入（继续或停止）。  
8. 所有阶段产物与状态写入 `.openoxen.logs.<timestamp>`。

## 5. Data and Control Contracts

1. DOT/Graph Contract  
- `Mdiamond`：start
- `Msquare`：done/exit
- `box`：codergen
- `parallelogram`：tool command（通常为测试命令）

2. Agent Request/Response Contract  
- Request 包含 `messages + tools + model/provider`
- Response 包含 `text + tool_calls`
- 工具循环时必须保留 assistant `tool_calls` 与后续 `toolResult` 配对关系

3. Outcome Contract  
每个节点输出 `status`（`success/fail/retry/...`）及可选 `context_updates`，由引擎用于下一步路由。

## 6. Reliability Strategy

1. DOT 结构与条件语法校验（启动即失败）。  
2. 节点级 retry/backoff（含上限和 partial 策略）。  
3. human gate 提供人工兜底。  
4. checkpoint 支持 resume。  
5. CLI 对最终结果做二次判定：测试节点失败即整体失败。

## 7. Observability Strategy

默认观测内容：
- OpenOxen -> Agent 的阶段输入
- Agent -> LLM 的消息与工具暴露
- LLM -> Agent 的文本与 tool calls
- Tool call 开始/结束和输出

增强观测：
- `OPENOXEN_TRACE_PI=1` 输出 `llm-client` 发给 `pi-ai` 的 context/options（敏感字段脱敏）。

## 8. Extensibility

1. 新模型提供商：扩展 `llm-client` 实现并保持 `LLMClient` 接口。  
2. 新工具：在 `agent/providers.ts` 注册 tool definition + execute。  
3. 新 pipeline runtime：替换/扩展 `createDefaultRuntime` handler registry。  
4. 新交互模式：在 `src/cli` 增加子命令，不影响核心引擎。

## 9. Non-goals

1. 不在 `attractor` 中实现具体模型 SDK 细节。  
2. 不保证一次生成即完成，允许迭代与人工干预。  
3. 不绑定单一供应商模型，`pi-ai` 只是当前默认实现之一。

