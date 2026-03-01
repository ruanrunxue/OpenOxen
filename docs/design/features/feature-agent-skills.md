# Feature Design: Agent Skills Integration

## 1. 背景与目标

OpenOxen 的 agent 具备工具调用能力，但缺少“可复用技能包”机制。该特性引入本地 Skills 支持，使 agent 能在任务中检索并加载结构化技能说明，减少重复提示编写，并提升复杂任务执行一致性。

目标：

1. 兼容 agentskills.io 常见目录格式（技能目录 + `SKILL.md`）。
2. 为模型提供标准技能检索与读取工具：`search_skills`、`get_skill`。
3. 不破坏现有 `attractor -> agent -> llm-client` 调用链。

## 2. 适用范围

模块范围：

- `src/agent/skills.ts`
- `src/agent/providers.ts`
- `src/agent/index.ts`

默认扫描路径：

- `<cwd>/.openoxen/skills`
- `<cwd>/.codex/skills`

可选路径：

- `OPENOXEN_SKILLS_DIRS`
- `OPENOXEN_ENABLE_HOME_SKILLS=1`

## 3. 实现方案

### 3.1 Skills 发现与解析

- 扫描技能根目录，识别包含 `SKILL.md` 或 `skill.md` 的目录。
- 解析 frontmatter（如 `name`、`description`）。
- 合并可选 `skill.json`/`agent-skill.json` 元数据。
- 构建技能索引：`id/name/description/files/instructions`。

### 3.2 Skills 工具

- `search_skills`
  - 输入：`query`、`limit`
  - 输出：匹配技能索引（JSON）
- `get_skill`
  - 输入：`id|name`，可选 `file_path`、`include_files`
  - 输出：技能正文（默认 `SKILL.md`），可读取指定附加文件

### 3.3 Prompt 集成

- Provider 在 system prompt 中注入 Skills 摘要块（数量、索引、根路径）。
- 不直接注入全部技能正文，避免上下文膨胀。
- 通过工具按需读取技能详情。

## 4. 失败路径与恢复

- skills 目录不存在：返回空索引，不中断 agent。
- 单个技能解析失败：记录 warning，跳过该技能，其他技能继续可用。
- `get_skill` 参数缺失或找不到技能/文件：返回明确错误文本，交由模型重试。

## 5. 观测与调试

- 通过既有 `TOOL_CALL_START/TOOL_CALL_END` 事件可见 skills 工具调用。
- `search_skills` 输出 roots/total/results，便于定位“为何未命中”。
- `get_skill` 输出技能目录与文件列表，便于确认加载来源。

## 6. 验证

新增测试：

- `tests/agent-skills.test.ts`
  - skills 发现与 frontmatter 解析
  - 搜索相关性排序
  - session 中 `search_skills/get_skill` 真实执行
