# OpenOxen Design Docs

本文档集描述 OpenOxen 的整体架构、模块职责与关键运行机制，面向维护和扩展该项目的工程师。

## 阅读顺序

1. [OpenOxen Overall Design](./openoxen-overall-design.md)
2. [CLI Module Design](./module-cli.md)
3. [Attractor Module Design](./module-attractor.md)
4. [Agent Module Design](./module-agent.md)
5. [LLM Client Module Design](./module-llm-client.md)
6. [OpenOxen Core Module Design](./module-openoxen.md)
7. [Feature Designs](./features/README.md)
8. [Documentation Policy](./documentation-policy.md)

## 源码对应关系

- `src/cli` -> `module-cli.md`
- `src/attractor` -> `module-attractor.md`
- `src/agent` -> `module-agent.md`
- `src/llm-client` -> `module-llm-client.md`
- `src/openoxen` -> `module-openoxen.md`
- 重要特性 -> `docs/design/features/feature-*.md`

## 维护要求（强制）

- 任何代码变更都必须同步更新相关文档。
- 新增模块（新顶级目录或新核心子系统）必须新增对应 `docs/design/module-<name>.md`。
- 新增或显著变更“重要特性”必须新增或更新 `docs/design/features/feature-<name>.md`。
- 新增模块文档后，必须更新本索引和 `openoxen-overall-design.md` 的模块映射。
