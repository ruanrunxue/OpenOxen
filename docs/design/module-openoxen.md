# OpenOxen Core Module Design (`src/openoxen`)

## 1. 职责

`src/openoxen` 提供 OpenOxen 跨模块共享的核心基础能力。当前主要负责本地状态目录与路径规范：

1. 解析 OpenOxen 根目录（默认 `~/.openoxen`）。
2. 定义 config/memory/skills/logs/cache/tmp 的标准路径。
3. 生成按项目隔离的 pipeline 日志目录。
4. 提供状态目录初始化能力。

## 2. 关键组件

- `paths.ts`
  - `resolveOpenOxenHome()`
  - `getOpenOxenPaths()`
  - `ensureOpenOxenLayout()`
  - `resolvePipelineLogsRoot()`

## 3. 路径契约

- 默认根目录：`~/.openoxen`
- 可覆盖：`OPENOXEN_HOME`
- 默认凭证文件：`~/.openoxen/config/auth.json`
- 默认 skills 根目录：`~/.openoxen/skills`
- 默认 logs 根目录：`~/.openoxen/logs`

日志目录结构：

`~/.openoxen/logs/<project>-<hash>/pipeline.<timestamp>/`

## 4. 设计取舍

1. 统一状态目录而不是散落在工作区
- 优点：跨项目状态管理与清理更简单。
- 代价：需要显式区分“工作区产物”（如 DOT）与“状态产物”（如 logs）。

2. 使用 `OPENOXEN_HOME` 覆盖默认根目录
- 优点：测试、CI、隔离环境配置更灵活。
- 代价：路径问题排查需要关注环境变量。
