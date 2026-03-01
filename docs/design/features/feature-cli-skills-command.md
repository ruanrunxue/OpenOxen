# Feature Design: CLI Skills Commands

## 1. 背景与目标

在引入 Agent Skills 后，需要一个可直接在终端调试 skills 的入口，方便用户确认 skills 是否被正确发现、内容是否可读取。

目标：

1. 提供 `openoxen skills list` 查看技能索引。
2. 提供 `openoxen skills get` 查看技能详情与文件内容。
3. 提供 `openoxen skills install`，支持 GitHub 地址安装或按名称搜索安装。
4. 输出支持人读与 JSON 两种模式。

## 2. 命令定义

- `openoxen skills list [--query <text>] [--limit <n>] [--json]`
- `openoxen skills get <id> [--file <path>] [--include-files] [--max-chars <n>] [--json]`
- `openoxen skills install <github-url|skill-name> [--dest <dir>] [--json]`

## 3. 实现方案

- CLI 层复用 `src/agent/skills.ts` 的能力：
  - `discoverSkills`
  - `searchSkills`
  - `getSkillById`
  - `readSkillFile`
- 通过 `CliDeps.discoverSkillsCatalog` 保持可测试性（可注入替身）。
- 远端安装通过 `.system/skill-installer` 脚本：
  - `list-skills.py --format json` 获取远端列表（curated/experimental）
  - `install-skill-from-github.py` 执行安装
- 技能名安装流程：
  - 先远端搜索
  - 匹配单一最佳候选后安装
  - 歧义候选返回错误并提示候选列表
- 默认安装目录：`~/.openoxen/skills`（可由 `OPENOXEN_HOME` 覆盖）。

## 4. 失败路径

- 参数错误：打印 usage，返回非 0。
- `skills get` 的 skill 不存在：返回非 0。
- `--file` 指定文件不存在：抛出错误并返回非 0。
- `skills install` 远端搜索失败或安装失败：返回非 0。

## 5. 验证

测试覆盖：

- `tests/cli.test.ts`
  - `openoxen skills list prints discovered skills`
  - `openoxen skills get prints skill content`
  - `openoxen skills install with github url delegates to installer`
  - `openoxen skills install by name resolves from remote skills list`
