# Feature: Concise Colored Logging

## 1. 背景与目标

- 背景：早期日志输出过多，包含长 prompt/system prompt，关键信息被淹没，定位问题效率低。
- 目标：将运行日志压缩为“每轮摘要 + 关键状态彩色提示”，同时保留故障定位所需的最小信息。
- 非目标：替代完整落盘日志（详细信息仍在 `~/.openoxen/logs/...` 中）。

## 2. 触发条件与适用范围

- 触发条件：执行 `openoxen dev`（默认 trace 打开，`--quiet` 可关闭）。
- 适用范围：CLI 控制台输出层（`src/cli/dev.ts`、`src/cli/main.ts`）。
- 不适用场景：日志文件落盘内容（不在该特性中压缩）。

## 3. 实现设计

- 涉及模块：
  - `src/cli/dev.ts`
  - `src/cli/main.ts`
- 关键策略：
1. 每轮 LLM 调用只打印一条摘要。
2. 不打印 system prompt。
3. stage 输入/输出只打印长度与简短摘要。
4. test 节点结果按状态打印彩色摘要。
5. pipeline 总结成功/失败使用彩色输出。
- 颜色约定：
  - 绿色：成功
  - 红色：失败
  - 黄色：警告/回退
  - 青色：trace 摘要

## 4. 失败路径与恢复策略

- 失败类型：输出终端不支持 ANSI 颜色
  - 恢复：自动降级为纯文本（`NO_COLOR=1` 或 `TERM=dumb`）。
- 失败类型：关键日志缺失导致排障困难
  - 恢复：启用 `--verbose` 并结合 `~/.openoxen/logs/...` 中阶段产物排查。

## 5. 观测与调试

- 关键观测点：
  - `[trace][dot][round N]`
  - `[trace][pipeline][round N]`
  - `[test_i] SUCCESS/FAIL`
  - `Pipeline completed successfully.` / `Pipeline failed.`
- 补充调试：
  - `OPENOXEN_TRACE_PI=1` 查看 llm-client 适配层摘要。

## 6. 测试与验证

- 回归测试：`tests/cli.test.ts`（`--quiet` 行为与主流程状态码）
- 全量回归：`npm test`
- 手动验证：
  - `openoxen dev "<需求>" --verbose`
  - `openoxen dev "<需求>" --quiet`
