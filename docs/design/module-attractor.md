# Attractor Module Design (`src/attractor`)

## 1. Responsibilities

Attractor 模块负责“流程图即执行计划”的编排执行：

1. 解析 DOT 到可执行图结构（`GraphSpec`）。
2. 校验图合法性（start/exit/reachability/condition 语法）。
3. 执行节点并基于 outcome 路由到下一节点。
4. 维护运行上下文、checkpoint、日志产物。

它不直接负责 LLM 调用实现，LLM 节点通过 `CodergenBackend` 抽象委托给上层。

## 2. Core Data Model

1. `GraphSpec`
- `id`, `attrs`, `nodes`, `edges`

2. `NodeSpec`
- `id`, `attrs`
- `shape` 映射 handler 类型

3. `Outcome`
- `status`（`success/fail/retry/partial_success/skipped`）
- `context_updates`, `preferred_label`, `suggested_next_ids`

4. `PipelineContext`
- 键值上下文容器，支持更新、快照、克隆

## 3. Runtime Architecture

1. `createDefaultRuntime`
- 注册 handler：`start/exit/codergen/wait.human/conditional/parallel/tool/...`

2. `runPipeline`
- 校验图
- 初始化 manifest/context
- 从 start 开始循环执行
- 节点执行支持 retry/backoff
- 按 condition/label/suggested_next_ids 选边
- 终止时检查 goal gate
- 写入 `status.json` 与 `checkpoint.json`

## 4. Node Handling Strategy

1. `box` -> `CodergenHandler`
- 写入 `prompt.md`
- 调用 `CodergenBackend.run`
- 写入 `response.md`
- 回填上下文摘要

2. `parallelogram` -> `ToolHandler`
- 执行 `tool_command`
- 成功写 tool output 到上下文，失败返回 fail

3. `hexagon` -> `WaitForHumanHandler`
- 读取可选边标签生成选项
- 通过 interviewer 获取用户选择
- 输出 `preferred_label/suggested_next_ids`

## 5. Reliability and Recovery

1. 结构性校验前置，防止运行期不可预测错误。  
2. 每节点 outcome 落盘，便于定位失败节点。  
3. checkpoint 支持 resume。  
4. retry + backoff 可配置，避免瞬时失败直接终止。  
5. goal gate 不满足可回跳到 retry target。

## 6. Extensibility

1. 新节点类型  
- 在 `handlers.ts` 增加 handler  
- 在 runtime registry 注册映射  

2. 新路由语义  
- 扩展 `condition.ts` 语法与 `evaluateCondition`  

3. 新执行策略  
- 自定义 runtime 或替换默认 handler 实现

## 7. Design Trade-offs

1. 使用 shape 到 handler 的映射而非硬编码节点名  
优点：DOT 结构更灵活。  
代价：需要维护 shape/type 约定。

2. 引擎内只依赖 `CodergenBackend` 接口  
优点：编排层与模型层彻底解耦。  
代价：跨层调试需要结合运行 trace。

