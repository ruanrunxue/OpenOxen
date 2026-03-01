# OpenOxen Overall Design

## 1. 设计目标

OpenOxen 将“需求 -> 代码生成/修改 -> 测试验证 -> 人工介入”落地为可执行 pipeline，并保证：

1. 分层清晰，避免跨层耦合。
2. 默认可观测，便于定位失败节点。
3. 失败显式化，避免静默误判。
4. 在测试阶段提供有限自动自愈能力。
5. 支持可复用本地 Skills（agentskills.io 兼容格式）。

## 2. 模块边界

- `src/cli`
  - 命令入口、参数解析、DOT 保存、运行结果输出。
- `src/attractor`
  - DOT 解析/校验、节点执行、路由、checkpoint、阶段产物。
- `src/agent`
  - agent loop、工具调用、provider profile、本地执行环境、skills 能力。
- `src/llm-client`
  - 统一 LLM 适配层，当前默认 `pi-ai`。

唯一模型调用链：
- `attractor -> agent -> llm-client -> pi-ai`

## 3. 高层架构

```mermaid
flowchart LR
  U[User] --> CLI[src/cli]
  CLI --> ATTR[src/attractor]
  ATTR -->|CodergenBackend| AG[src/agent]
  AG -->|LLMClient.complete| LLM[src/llm-client]
  LLM --> PI[@mariozechner/pi-ai]
  AG --> ENV[LocalExecutionEnvironment]
  ATTR --> LOGS[Artifacts + Checkpoint]
```

## 4. 运行主流程（`openoxen dev`）

1. CLI 解析需求与选项（`--task` / `--quiet` / `--verbose`）。
2. 通过 agent 生成 DOT；若非法则 fallback 到内置模板。
3. DOT 写入当前目录并立即执行。
4. Attractor 从 `start` 开始逐节点执行。
5. `box` 节点通过 codergen backend 走 agent loop。
6. `test_*` 节点执行测试命令并根据结果路由。
7. 失败最多 5 轮，进入 `human_intervention`。

补充命令：

- `openoxen skills list/get` 用于本地 skills 发现与调试，不触发 Attractor 流程。

## 5. 关键策略

### 5.1 路由与收敛

- 测试节点要求显式 `outcome=success` / `outcome=fail` 路由。
- 生成 DOT 时会校验 dev/review/test 合约，不满足则 fallback。

### 5.2 测试结果判定

- 不仅看 exit code，也解析 stdout/stderr 关键失败信号（如 `N failed`、`Cannot find module`、`Executable doesn't exist`）。
- 避免“命令返回 0 但测试实际上失败”的误判。

### 5.3 自动自愈（test 节点）

- 默认开启，按错误类型执行修复命令并重试。
- 支持通过 graph attrs 覆盖修复命令。
- 所有修复步骤写入 `test.auto_repair_log` 上下文。

### 5.4 可观测性

- `--verbose` 下每轮仅输出一次摘要，不打印 system prompt。
- 关键成功/失败信息使用颜色区分。
- 每阶段产物落盘：`prompt.md`、`response.md`、`status.json`。

### 5.5 Skills 复用（agent）

- Agent 支持加载本地 skills 目录（`SKILL.md` + 附加文件）。
- 通过 `search_skills/get_skill` 工具按需检索与读取技能内容。
- system prompt 只注入技能索引摘要，避免上下文膨胀。

## 6. 设计取舍

1. 编排层与模型层严格解耦
- 优点：替换模型 SDK 成本低。
- 代价：跨层调试需要结合多级日志。

2. 工具执行优先本地环境
- 优点：开箱即用，闭环快。
- 代价：依赖宿主机环境一致性。

3. 自动自愈只覆盖高频故障
- 优点：稳定收敛，复杂度可控。
- 代价：无法替代人工处理所有复杂失败。

## 7. 设计文档组织

当前采用两层设计文档结构：

1. 模块级设计（`docs/design/module-*.md`）
- 关注模块边界、接口、依赖关系。

2. 特性级设计（`docs/design/features/feature-*.md`）
- 关注重要特性的目标、流程、失败恢复与观测策略。

约束：
- 任何重要特性变更都必须同步更新对应 feature design 文档。
- 新增重要特性必须新增 feature design 文档并更新索引。
