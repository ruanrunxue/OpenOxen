# Documentation Policy

本文件定义 OpenOxen 的文档维护约束。该约束是仓库级开发规范。

## 1. 变更即更新

任何代码变更（行为、接口、参数、错误处理、可观测性）都必须在同一批提交中更新相关文档。

至少检查：
- `README.md`
- `docs/design/openoxen-overall-design.md`
- 对应模块文档 `docs/design/module-*.md`
- 对应特性文档 `docs/design/features/feature-*.md`（若影响重要特性）
- `docs/spec-parity-notes.md`（若影响规格覆盖或限制）

## 2. 新增模块必须有设计文档

当新增核心模块（例如新增 `src/<module>`）时，必须新增：

- `docs/design/module-<module>.md`

并同步更新：
- `docs/design/README.md`（阅读索引）
- `docs/design/openoxen-overall-design.md`（架构与模块映射）

## 3. 重要特性必须有设计文档

当满足任一条件时，视为“重要特性”：

- 用户可见行为发生变化（CLI 命令语义、默认流程、关键日志行为）
- 失败处理与恢复机制发生变化（重试、回退、自愈、人工介入）
- 新增跨模块能力（需要同时修改 `cli/attractor/agent/llm-client` 其中 2 个及以上模块）

必须新增或更新：

- `docs/design/features/feature-<name>.md`

并同步更新：

- `docs/design/features/README.md`（特性索引）
- `docs/design/openoxen-overall-design.md`（关键策略章节，如有影响）

## 4. 文档内容最低要求

模块设计文档至少包含：
- 模块职责
- 关键组件与入口
- 数据/控制流
- 错误处理与恢复机制
- 观测与日志
- 扩展点

特性设计文档至少包含：
- 背景与目标
- 触发条件/适用范围
- 实现方案与关键流程
- 失败路径与恢复策略
- 观测与调试方法

## 5. 提交前检查

提交前必须确认：
- 文档没有过期参数或行为描述
- 示例命令可执行
- 目录结构与文档引用一致
- 不提交运行日志、构建产物、临时文件
