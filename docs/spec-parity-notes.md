# OpenOxen Spec Parity Notes (2026-03-01)

本文件记录当前实现与上游规范的对齐情况。

参考规范：
- `attractor-spec.md`
- `coding-agent-loop-spec.md`
- `unified-llm-spec.md`（按项目决策不单独实现，改为 `llm-client` + `pi-ai`）

## 1. Attractor 对齐情况

已实现（`src/attractor`）：
- DOT 解析：digraph、node/edge attrs、链式边、默认 attrs、子图扁平化、注释处理
- 校验：start/exit、可达性、边目标存在性、条件表达式语法
- 条件求值：`=` / `!=` / `&&`
- 运行引擎：节点执行、路由选择、重试与 backoff、goal gate、checkpoint
- 处理器：start/exit/codergen/wait.human/conditional/parallel/fan_in/tool/manager_loop
- codergen 产物落盘：`prompt.md`/`response.md`

当前增强（相对基础规范）：
- test 节点输出解析，识别“exit code 为 0 但测试实际失败”
- test 节点自动自愈重试（依赖缺失、浏览器缺失、端口占用）

已知简化：
- `parallel`/`fan_in` 为轻量实现，不是完整并行调度器
- `stack.manager_loop` 当前是 no-op
- 未实现 HTTP/SSE server mode

## 2. Coding Agent Loop 对齐情况

已实现（`src/agent`）：
- 会话主循环：`LLM -> tools -> LLM` 直到自然收敛
- provider profiles（openai/anthropic/gemini）
- core tools + openclaw 风格别名
- skills 能力（agentskills.io 风格目录解析 + `search_skills/get_skill`）
- 本地执行环境（文件/命令/搜索）
- tool 参数校验、输出截断
- steering/follow-up/loop detection
- subagent 工具接口

已知简化：
- `apply_patch` 为最小可用实现，不是完整 v4a 语义
- 未实现流式 token/tool delta

## 3. Unified LLM Client 处理策略

按项目决策：不单独实现 unified-llm 规范。

当前方案：
- 统一接口由 `src/llm-client` 提供
- 默认实现使用 `@mariozechner/pi-ai`
- Attractor 通过 `agent` 间接调用 llm-client

## 4. CLI 行为对齐补充

已实现（`src/cli`）：
- `openoxen dev "<需求>"` 生成并立即执行 DOT
- `--task` 指定输出文件名
- 默认 5 轮 test fail 后进入人工介入
- `openoxen skills list/get` 本地技能查询
- `openoxen skills install`（GitHub URL 或按名称远端搜索后安装）
- 精简日志：每轮摘要，不打印 system prompt
- 关键成功/失败彩色输出

## 5. 测试与验证

全量测试命令：

```bash
npm test
```

当前结果：
- 55 passed
- 0 failed
