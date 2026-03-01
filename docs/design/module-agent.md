# Agent Module Design (`src/agent`)

## 1. 职责

Agent 模块实现 coding agent loop，负责：

1. 会话状态与历史维护。
2. 组装 LLM 请求（system prompt + history + tools）。
3. 工具调用执行与结果回注。
4. 事件输出（供 CLI trace 使用）。
5. 本地执行环境抽象。

## 2. 关键组件

- `session.ts`
  - `Session.submit()` 主循环
  - tool round、loop detection、turn limit
- `providers.ts`
  - provider profile
  - core tools、skills tools、系统提示构建
- `execution-environment.ts`
  - 文件读写、命令执行、搜索、目录遍历
- `skills.ts`
  - skills 发现（目录扫描）
  - agentskills.io 风格 `SKILL.md` frontmatter 解析
  - skills 搜索与详情读取
- `tool-registry.ts` / `truncation.ts`
  - 工具定义校验与输出截断

## 3. 消息循环契约

每轮流程：
1. 构建 `LLMRequest`
2. 调用 `llmClient.complete`
3. 若有 tool_calls：执行工具并写入 `tool_results`
4. 进入下一轮

关键约束：
- assistant `tool_calls` 必须在下一轮上下文中保留。
- tool result 必须携带 `tool_call_id` 以保持关联。

## 4. 内置工具

- 文件：`read_file/write_file/edit_file/apply_patch`，别名 `read/write/edit`
- 搜索：`grep/glob`，别名 `search/find`
- 目录：`ls/list_dir`
- 命令：`shell`，别名 `exec/bash/process`
- 子代理：`spawn_agent/send_input/wait/close_agent`
- Skills：`search_skills/get_skill`

### Skills 能力说明

- 目标：让 Agent 能复用外部技能包中的流程说明与辅助文件。
- 兼容格式：agentskills.io 常见目录结构（技能目录内含 `SKILL.md`，可带 frontmatter）。
- 默认扫描路径：
  - `<cwd>/.openoxen/skills`
  - `<cwd>/.codex/skills`
- 可选扩展：
  - `OPENOXEN_SKILLS_DIRS` 自定义根目录（多目录）
  - `OPENOXEN_ENABLE_HOME_SKILLS=1` 追加 `~/.codex/skills`、`~/.codex/superpowers/skills`

`search_skills` 返回技能索引（id/name/description/files）；`get_skill` 返回技能主体（`SKILL.md`）并支持按文件读取。

## 5. 可靠性与安全

- 工具参数执行前校验。
- 命令执行支持 timeout 与进程清理。
- 工具输出长度截断，避免上下文膨胀。
- loop detection 在重复工具模式下发出提示。
- skills 加载失败时记录 warning，不阻断主流程。

## 6. 观测事件

- `USER_INPUT`
- `ASSISTANT_TEXT_END`
- `TOOL_CALL_START` / `TOOL_CALL_END`
- `LOOP_DETECTION`
- `ERROR`

CLI 侧消费这些事件并做精简摘要展示。
