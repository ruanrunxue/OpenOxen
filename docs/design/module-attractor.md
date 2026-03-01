# Attractor Module Design (`src/attractor`)

## 1. 职责

Attractor 模块是 OpenOxen 的流程编排内核，负责：

1. 解析 DOT 为可执行图结构。
2. 校验图结构、边条件语法和可达性。
3. 执行节点并按 outcome 路由。
4. 记录阶段产物、状态与 checkpoint。

## 2. 核心数据结构

- `GraphSpec`：图级属性、节点、边
- `NodeSpec`：节点 id 与 attrs
- `Outcome`：节点执行结果（status、context_updates、failure_reason）
- `PipelineContext`：运行时键值上下文

## 3. 引擎执行流程

`runPipeline()` 主循环：

1. `validateOrRaise(graph)`
2. 初始化 manifest 与 graph attrs 到 context
3. 从 start 节点循环执行
4. `executeWithRetry()` 执行节点（支持重试/backoff）
5. 记录 `status.json` 与 `checkpoint.json`
6. `selectEdge()` 选择下一跳
7. 到终止节点后返回 run result

## 4. Handler 体系

- `StartHandler` / `ExitHandler`
- `CodergenHandler`：写 prompt/response 产物，支持从输出中提取 `TEST_COMMAND`
- `ToolHandler`：执行命令并更新上下文
- `WaitForHumanHandler`：人工分支选择
- `Conditional/Parallel/FanIn/ManagerLoop`：扩展占位

## 5. ToolHandler 关键行为

### 5.1 命令解析

- 支持 `$test_command` / `${test_command}` 占位符。
- 来源优先级：`context.test.command` > `graph.default_test_command`。

### 5.2 测试失败识别

`test_*` 节点不仅依赖 exit code，还会解析输出中的失败信号，例如：
- `N failed`
- `Cannot find module`
- `browserType.launch: Executable doesn't exist`
- `EADDRINUSE`

### 5.3 自动自愈与重试

对 `test_*` 节点默认开启自动修复（可配置）：
- 缺模块 -> 安装依赖
- 缺浏览器 -> `npx playwright install`
- 端口占用 -> 清理占用端口

可配置 graph attrs：
- `auto_test_repair`
- `auto_test_repair_max_attempts`
- `repair_missing_module_command`
- `repair_missing_browser_command`
- `repair_port_in_use_command`
- `repair_tests_failed_command`
- `repair_generic_error_command`

## 6. 落盘与可恢复性

每个阶段目录下至少包含：
- `status.json`
-（codergen 节点）`prompt.md`、`response.md`

图级落盘：
- `manifest.json`
- `checkpoint.json`

可用 `resume` 模式从 checkpoint 恢复。

## 7. 设计取舍

1. DOT 驱动 + 明确路由条件
- 优点：流程语义可读且可复用。
- 代价：需要对生成 DOT 做严格校验。

2. 编排层不直接接模型 SDK
- 优点：保持抽象稳定。
- 代价：调试时需结合 agent/llm-client 日志。
