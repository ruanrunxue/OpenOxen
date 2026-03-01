# Feature Design: CLI Skills Commands

## 1. 背景与目标

在引入 Agent Skills 后，需要一个可直接在终端调试 skills 的入口，方便用户确认 skills 是否被正确发现、内容是否可读取。

目标：

1. 提供 `openoxen skills list` 查看技能索引。
2. 提供 `openoxen skills get` 查看技能详情与文件内容。
3. 输出支持人读与 JSON 两种模式。

## 2. 命令定义

- `openoxen skills list [--query <text>] [--limit <n>] [--json]`
- `openoxen skills get <id> [--file <path>] [--include-files] [--max-chars <n>] [--json]`

## 3. 实现方案

- CLI 层复用 `src/agent/skills.ts` 的能力：
  - `discoverSkills`
  - `searchSkills`
  - `getSkillById`
  - `readSkillFile`
- 通过 `CliDeps.discoverSkillsCatalog` 保持可测试性（可注入替身）。

## 4. 失败路径

- 参数错误：打印 usage，返回非 0。
- `skills get` 的 skill 不存在：返回非 0。
- `--file` 指定文件不存在：抛出错误并返回非 0。

## 5. 验证

测试覆盖：

- `tests/cli.test.ts`
  - `openoxen skills list prints discovered skills`
  - `openoxen skills get prints skill content`
