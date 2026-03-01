# Feature Design: OpenOxen Home Layout

## 1. 背景与目标

OpenOxen 早期把部分状态写在项目目录（例如本地 logs、skills），导致跨项目管理和清理成本高。该特性统一把 OpenOxen 运行状态放到 `~/.openoxen`，避免污染工作区并提升可维护性。

目标：

1. 统一默认状态根目录到 `~/.openoxen`。
2. 让 auth/config/memory/skills/logs 都在同一目录树下。
3. 保持可覆盖能力（`OPENOXEN_HOME`、`OPENOXEN_AUTH_FILE` 等）。

## 2. 目录结构

默认结构：

```text
~/.openoxen/
  config/
    auth.json
    config.json
  memory/
    global.md
  skills/
  logs/
  cache/
  tmp/
```

项目运行日志路径：

`~/.openoxen/logs/<project>-<hash>/pipeline.<timestamp>/`

## 3. 实现方案

- 新增统一路径模块：`src/openoxen/paths.ts`
  - 解析根目录（`OPENOXEN_HOME` 或 `~/.openoxen`）
  - 定义各子目录路径
  - 生成项目作用域日志目录
- `agent/skills` 默认扫描 `~/.openoxen/skills`
- `cli` 的 skills 安装默认目标改为 `~/.openoxen/skills`
- `llm-client` OAuth 默认凭证改为 `~/.openoxen/config/auth.json`

## 4. 兼容与回退

- 自定义路径优先级：
  - `OPENOXEN_AUTH_FILE` 覆盖 auth 文件路径
  - `OPENOXEN_SKILLS_DIRS` 覆盖 skills 根目录
  - `OPENOXEN_HOME` 覆盖统一根目录
- 若用户需要读取 `~/.codex/skills`，可通过 `OPENOXEN_ENABLE_HOME_SKILLS=1` 开启兼容扫描。

## 5. 验证

- `tests/openoxen-paths.test.ts`
  - `OPENOXEN_HOME` 解析
  - 布局目录创建
  - logs 路径构建
- `tests/agent-skills.test.ts`
  - 在 `OPENOXEN_HOME` 下的 skills 发现与调用
- `tests/cli.test.ts`
  - skills install 默认目标目录迁移验证
