# Feature Design Docs

本目录存放“重要特性”的设计文档。

命名规范：
- `feature-<short-name>.md`
- 示例：`feature-test-auto-repair.md`

## 当前特性文档

1. [Test Auto Repair](./feature-test-auto-repair.md)
2. [Concise Colored Logging](./feature-concise-colored-logging.md)
3. [Agent Skills Integration](./feature-agent-skills.md)
4. [CLI Skills Commands](./feature-cli-skills-command.md)
5. [OpenOxen Home Layout](./feature-openoxen-home-layout.md)

## 何时新增特性文档

满足以下任一条件需新增文档：

- 用户可见行为有显著变化（命令语义、默认流程、关键输出）
- 失败恢复机制变化（重试/回退/自愈/人工介入）
- 需要跨 2 个及以上核心模块协作实现

## 模板

- [Feature Design Template](./feature-template.md)
