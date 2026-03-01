# Agent Module Design (`src/agent`)

## 1. Responsibilities

Agent 模块实现 coding-agent-loop 的核心执行语义：

1. 维护会话状态与历史（user/assistant/tool_results/steering）。
2. 构建 LLM 请求（系统提示 + 历史消息 + 工具定义）。
3. 执行工具调用并把结果回注到下一轮上下文。
4. 提供事件流用于日志与外部观测。
5. 提供本地执行环境抽象（文件、命令、搜索）。

## 2. Main Components

1. `session.ts`
- `Session.submit()`：主入口
- 工具循环：assistant tool_calls -> execute tools -> tool results -> next turn
- loop detection、turn limit、subagent

2. `providers.ts`
- provider profile（openai/anthropic/gemini）
- 系统提示构建
- core tools 注册（含 openclaw 风格别名）

3. `execution-environment.ts`
- `LocalExecutionEnvironment`
- `read/write/list/exec/grep/glob`
- 命令执行与超时控制、环境变量过滤

4. `tool-registry.ts` / `truncation.ts`
- 工具参数校验与输出截断

## 3. Message and Tool Loop Contract

关键约束：

1. assistant 消息不仅包含 text，还包含 `tool_calls`。  
2. tool result 必须带 `tool_call_id`，并与 assistant tool call 对齐。  
3. 下一轮请求必须同时保留：
- assistant tool call 记录
- 对应 tool result 消息

这样才能与 `pi-ai` 的上下文转换逻辑一致，保证工具调用链不丢失。

## 4. Built-in Tools

默认工具分组：

1. 文件工具  
- `read_file`, `write_file`, `edit_file`, `apply_patch`
- 别名：`read`, `write`, `edit`

2. 搜索与目录  
- `grep`, `glob`, `ls`
- 别名：`search`, `find`, `list_dir`

3. 命令执行  
- `shell`
- 别名：`exec`, `bash`, `process(run)`

4. 子 agent 控制  
- `spawn_agent`, `send_input`, `wait`, `close_agent`

## 5. Safety and Reliability

1. 工具参数在执行前校验，不合法直接返回 error ToolResult。  
2. 工具输出会截断，避免上下文爆炸。  
3. 命令执行有 timeout，并支持进程组终止。  
4. 执行环境默认过滤敏感环境变量。  
5. loop detection 提示模型改变策略，降低“重复调用工具”死循环风险。

## 6. Observability

Session 通过 `SessionEvent` 对外暴露关键生命周期事件：

- `USER_INPUT`
- `ASSISTANT_TEXT_END`
- `TOOL_CALL_START`
- `TOOL_CALL_END`
- `LOOP_DETECTION`
- `ERROR`

CLI 层消费这些事件并输出 trace 日志。

## 7. Design Trade-offs

1. 采用“简单同步轮询式”循环而非复杂调度器  
优点：行为清晰，易调试。  
代价：并发控制能力有限（仅在 provider 声明支持时并行工具调用）。

2. 本地执行环境集成较多能力  
优点：开箱可用，降低集成成本。  
代价：默认权限较强，生产环境可考虑沙箱替换实现。

