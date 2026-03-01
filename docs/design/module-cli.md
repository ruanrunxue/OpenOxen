# CLI Module Design (`src/cli`)

## 1. Responsibilities

CLI 模块负责用户入口与运行编排，不负责业务决策与模型细节：

1. 参数解析与命令分发（`dev` / `login`）。
2. DOT 文件命名与保存（当前目录）。
3. 触发 Attractor 执行并输出运行结果。
4. 透传日志开关（`--quiet` / `--verbose`）。

## 2. Main Components

1. `main.ts`
- `runCli(argv, deps)`：统一入口
- `parseDevArgs`：解析需求、taskName、verbose
- `parseLoginArgs`：解析 provider
- `defaultDeps`：绑定默认依赖（pi-ai adapter、DOT 生成与运行）

2. `dev.ts`
- `generateDotWithAgent`：通过 agent 生成 DOT
- `runDotImmediately`：即时执行 DOT pipeline
- `buildFallbackDot`：模型输出无效 DOT 时的兜底模板
- trace helpers：输出调用链路细节

## 3. Command Behavior

### `openoxen dev "<需求>" [--task <name>] [--quiet|--verbose]`

1. 解析参数并创建 LLMClient。
2. 调用 `generateDotWithAgent` 生成 DOT。
3. 以 `<task>.dot` 或 `openoxen.pipeline.<ts>.dot` 写入当前目录。
4. 立即调用 `runDotImmediately` 运行 Attractor。
5. 输出 `Run logs` 路径与最终状态码。

### `openoxen login [--provider <name>]`

1. 调用 `loginPiWithOauthFromEnv(provider)`。
2. 输出 OAuth 进度、结果或错误。

## 4. Error Handling

1. 参数错误：返回 usage + exit code 1。  
2. 未知命令：返回 usage + exit code 1。  
3. 登录/运行异常：捕获后输出错误字符串，返回非零。  
4. DOT 无效：输出原因并使用 fallback DOT，避免流程中断。

## 5. Logging and Observability

CLI 层默认提供两层日志：

1. Pipeline trace（`OPENOXEN_VERBOSE` / `--verbose`）
- OpenOxen -> Agent
- Agent -> LLM
- LLM -> Agent
- Tool call start/end + output

2. Adapter trace（`OPENOXEN_TRACE_PI=1`）
- `llm-client` 发给 `@mariozechner/pi-ai` 的上下文与选项摘要

## 6. Design Trade-offs

1. CLI 即时执行 DOT，而不是“只生成不运行”  
优点：用户一条命令即可端到端执行。  
代价：对交互式输入（人工介入）环境有要求。

2. 通过 `deps` 注入依赖  
优点：单元测试可 mock；降低 IO/网络耦合。  
代价：入口函数签名较长。

