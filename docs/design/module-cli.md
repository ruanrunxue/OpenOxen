# CLI Module Design (`src/cli`)

## 1. 职责

CLI 模块负责：

1. 解析命令参数并分发子命令。
2. 调用 agent 生成 DOT，失败时回退模板。
3. 保存 DOT 到当前目录并立即执行 Attractor。
4. 提供本地 skills 命令（list/get/install）。
5. 输出运行结果与关键日志（含颜色）。

## 2. 主要入口

- `src/cli/main.ts`
  - `runCli()`：总入口
  - `dev` / `login` / `skills` 子命令分发
- `src/cli/dev.ts`
  - `generateDotWithAgent()`：DOT 生成 + 校验 + fallback
  - `runDotImmediately()`：执行 pipeline 并汇总 test 节点结果

## 3. 命令语义

### `openoxen dev "<需求>" [--task <name>] [--quiet|--verbose]`

执行顺序：
1. 推断测试命令（`guessTestCommand`）。
2. 生成 DOT 并校验合约。
3. 保存 DOT 文件。
4. 立即执行 Attractor。
5. 输出日志目录和最终状态码。

输出文件命名：
- 默认：`openoxen.pipeline.<timestamp>.dot`
- 指定 `--task`：`<task>.dot`

### `openoxen login [--provider <name>]`

调用 `llm-client/pi-ai` 的 OAuth 登录流程并持久化凭证。

### `openoxen skills list [--query <text>] [--limit <n>] [--json]`

- 从本地 skills 目录加载目录索引并输出。
- `--query` 启用关键词匹配排序。
- `--json` 输出机器可读结果。

### `openoxen skills get <id> [--file <path>] [--include-files] [--max-chars <n>] [--json]`

- 读取指定 skill 的 `SKILL.md` 或指定附加文件。
- `--include-files` 会拼接输出 skill 目录下其他文件内容。

### `openoxen skills install <github-url|skill-name> [--dest <dir>] [--json]`

- 当参数是 GitHub URL：直接调用 skill-installer 按 URL 安装。
- 当参数是 skill 名称：先拉取远端技能列表（curated/experimental）搜索，再安装匹配项。
- 默认安装目录：`~/.openoxen/skills`（可由 `OPENOXEN_HOME` 覆盖）。

## 4. 日志策略（当前实现）

- pipeline 落盘日志统一写入 `~/.openoxen/logs/<project>-<hash>/pipeline.<timestamp>/`。

### Trace 日志

- 默认开启（`OPENOXEN_VERBOSE!=0`），可用 `--quiet` 关闭。
- 每轮仅一条摘要：
  - provider/model/messages/tools 计数
  - 最近输入摘要
  - 输出摘要 + tool_call 计数
- 不打印 system prompt。

### 关键状态彩色输出

- 绿色：成功
- 红色：失败
- 黄色：警告/回退
- 青色：trace 标题

## 5. 错误处理

1. 参数错误：打印 usage，返回非 0。
2. DOT 无效：打印原因并 fallback。
3. pipeline 失败：返回非 0。
4. login 失败：打印错误并返回非 0。
5. skills 参数错误、skill 不存在或安装失败：返回非 0。

## 6. 设计取舍

1. `dev` 默认“生成即执行”
- 优点：单命令闭环。
- 代价：需要具备运行与交互环境。

2. `deps` 注入设计
- 优点：测试可替换 I/O 与网络依赖。
- 代价：入口函数参数结构更复杂。
