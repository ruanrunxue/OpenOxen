# OpenOxen

OpenOxen 是基于 [strongdm/attractor](https://github.com/strongdm/attractor) 设计思想实现的本地工程化编排系统，核心包含 5 个模块：

- `src/cli`：命令行入口（`openoxen dev` / `openoxen login` / `openoxen skills`）
- `src/attractor`：DOT 解析、校验、执行引擎、checkpoint
- `src/agent`：agent loop、工具调用、执行环境
- `src/llm-client`：统一 LLM client 适配层（当前默认 `pi-ai`）
- `src/openoxen`：本地状态路径与目录布局（`~/.openoxen`）定义

关键调用链：`attractor -> agent -> llm-client(pi-ai)`。

Agent 支持本地 Skills（兼容 agentskills.io 目录格式），可通过工具调用：

- `search_skills`：检索可用技能
- `get_skill`：读取指定技能的 `SKILL.md` 与附加文件

## 快速开始

```bash
npm install
npm test
```

本地运行：

```bash
npm run cli -- dev "实现一个网页版贪吃蛇小游戏"
```

OAuth 登录（默认 `openai-codex`）：

```bash
npm run cli -- login
```

## CLI 用法

```bash
openoxen dev "<需求>" [--task <name>] [--quiet|--verbose]
openoxen login [--provider <name>]
openoxen skills list [--query <text>] [--limit <n>] [--json]
openoxen skills get <id> [--file <path>] [--include-files] [--max-chars <n>] [--json]
openoxen skills install <github-url|skill-name> [--dest <dir>] [--json]
```

### `openoxen dev` 行为

1. 生成 DOT（优先由 agent 生成，失败时使用 fallback 模板）。
2. DOT 保存到命令执行目录：
- 默认：`openoxen.pipeline.<timestamp>.dot`
- 指定 `--task`：`<task>.dot`
3. 立即执行 Attractor。
4. 运行日志写入：`~/.openoxen/logs/<project>-<hash>/pipeline.<timestamp>/`。

默认流程：
- `write_tests -> develop -> review -> test`
- 测试失败最多 5 轮后进入 `human_intervention`。

### `openoxen skills` 行为

- `skills list`：列出可发现技能，可用 `--query` 检索、`--limit` 限制数量。
- `skills get <id>`：查看技能详情（默认输出 `SKILL.md`），可用 `--file` 读取指定文件。
- `skills install <source>`：安装技能到本地目录（默认 `~/.openoxen/skills`）。
- `source` 是 GitHub 地址时：直接按地址安装。
- `source` 是技能名时：先远端搜索，再安装匹配结果。

## 日志输出（已精简）

`--verbose`（或默认未关闭）下：
- 每轮仅输出一条 LLM 往返摘要（不打印 system prompt）
- 输出 stage 输入/输出长度摘要
- 输出测试阶段结果摘要

颜色规则：
- 绿色：关键成功
- 红色：关键失败
- 黄色：回退/警告
- 青色：trace 摘要

可用 `--quiet` 或 `OPENOXEN_VERBOSE=0` 关闭 trace。

## 测试阶段自动自愈

`test_*` 节点支持失败识别与自动修复重试（默认开启）：

- 缺模块：自动尝试安装依赖
- 缺 Playwright 浏览器：自动尝试 `npx playwright install`
- 端口占用：自动清理占用进程

可通过图属性覆盖：
- `auto_test_repair`
- `auto_test_repair_max_attempts`
- `repair_missing_module_command`
- `repair_missing_browser_command`
- `repair_port_in_use_command`
- `repair_tests_failed_command`
- `repair_generic_error_command`

## 常用环境变量

- `OPENOXEN_HOME`：覆盖 OpenOxen 状态根目录（默认 `~/.openoxen`）
- `OPENOXEN_MODEL`：覆盖默认模型
- `OPENOXEN_AUTH_FILE`：OAuth 凭证文件（默认 `~/.openoxen/config/auth.json`）
- `OPENOXEN_PI_PROVIDER`：覆盖 provider 映射
- `OPENOXEN_SKILLS_DIRS`：自定义 skills 根目录（多目录用系统 path 分隔符，如 macOS/Linux 用 `:`）
- `OPENOXEN_ENABLE_HOME_SKILLS=1`：额外加载 `~/.codex/skills` 和 `~/.codex/superpowers/skills`
- `OPENOXEN_SKILL_INSTALLER_DIR`：覆盖 skill-installer 脚本目录（默认 `~/.codex/skills/.system/skill-installer/scripts`）
- `OPENOXEN_VERBOSE=0`：默认关闭 trace
- `OPENOXEN_TRACE_PI=1`：打印 llm-client -> pi-ai 适配层 trace（敏感字段脱敏）
- `OPENOXEN_NO_BROWSER=1`：登录时不自动打开浏览器
- `OPENOXEN_FAKE_PI=1`：使用本地 fake pi（调试/测试）

## OpenOxen 状态目录结构

默认状态目录：`~/.openoxen`（可由 `OPENOXEN_HOME` 覆盖）

```text
~/.openoxen/
  config/
    auth.json
    config.json
  memory/
    global.md
  skills/
    <skill-name>/
      SKILL.md
      ...
  logs/
    <project>-<hash>/
      pipeline.<timestamp>/
        manifest.json
        checkpoint.json
        <node-id>/
          prompt.md
          response.md
          status.json
  cache/
  tmp/
```

## Skills 目录格式（agentskills.io 兼容）

默认扫描目录：

- `~/.openoxen/skills/*/SKILL.md`

技能目录最小结构示例：

```text
~/.openoxen/skills/snake-game/
  SKILL.md
  references/checklist.md
  scripts/setup.sh
```

`SKILL.md` 支持 frontmatter（如 `name`、`description`），Agent 会在系统提示中公布技能索引，并通过 `search_skills/get_skill` 按需加载详情。

## 架构图

```mermaid
flowchart LR
  U[User]
  CLI[src/cli]
  ATTR[src/attractor]
  AG[src/agent]
  LLM[src/llm-client]
  PI[@mariozechner/pi-ai]
  FS[(Workspace / Shell)]

  U --> CLI
  CLI --> ATTR
  ATTR -->|CodergenBackend| AG
  AG -->|LLMClient| LLM
  LLM --> PI
  AG --> FS
  ATTR --> FS
```

## 文档索引

- 设计总览：`docs/design/openoxen-overall-design.md`
- 模块设计：`docs/design/module-*.md`
- 特性设计：`docs/design/features/feature-*.md`
- 文档维护规范：`docs/design/documentation-policy.md`
- 规格对齐说明：`docs/spec-parity-notes.md`
