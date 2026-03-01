# Feature: Test Auto Repair

## 1. 背景与目标

- 背景：测试命令在某些环境下会出现“命令退出码不可靠”或“环境依赖缺失”（如 Playwright 浏览器缺失、模块缺失、端口占用）的问题，导致 pipeline 卡住或误判。
- 目标：在 `test_*` 节点提供可控的自动自愈与重试机制，提高 pipeline 收敛率并降低人工介入频率。
- 非目标：不尝试自动修复业务逻辑错误（断言失败、功能不满足需求）。

## 2. 触发条件与适用范围

- 触发条件：`test_*` 节点输出命中已知失败特征（`Cannot find module`、`Executable doesn't exist`、`EADDRINUSE`、`N failed` 等）。
- 适用范围：Attractor `ToolHandler` 执行 `test_*` 节点时。
- 不适用场景：非测试节点；需要人工判断的复杂业务失败。

## 3. 实现设计

- 涉及模块：`src/attractor/handlers.ts`
- 关键流程：
1. 执行测试命令。
2. 分析 stdout/stderr 判定是否存在失败特征。
3. 根据失败类型选择修复命令（默认或 graph attrs 覆盖）。
4. 执行修复命令并重跑测试（受最大次数限制）。
5. 输出最终 `success/fail`，并写入 `test.auto_repair_log`。
- 关键配置：
  - `auto_test_repair`
  - `auto_test_repair_max_attempts`
  - `repair_missing_module_command`
  - `repair_missing_browser_command`
  - `repair_port_in_use_command`
  - `repair_tests_failed_command`
  - `repair_generic_error_command`

## 4. 失败路径与恢复策略

- 失败类型：缺少测试依赖模块
  - 恢复：默认尝试安装依赖（可覆盖命令）
- 失败类型：缺少 Playwright 浏览器可执行文件
  - 恢复：默认执行 `npx playwright install`（可覆盖命令）
- 失败类型：端口占用
  - 恢复：默认清理占用端口进程（可覆盖命令）
- 失败类型：业务测试断言失败
  - 恢复：不进行“逻辑修复”，返回 fail，进入 develop/review 迭代

## 5. 观测与调试

- 日志与上下文：
  - `test.last_status`
  - `test.last_failure`
  - `test.auto_repair_log`
- 排障入口：
  - `.openoxen.logs.<timestamp>/<test_node>/status.json`
- 典型步骤：
1. 查看 `failure_reason`。
2. 查看 `test.auto_repair_log` 是否执行过修复命令。
3. 判断是环境失败还是业务失败。

## 6. 测试与验证

- 单元测试：`tests/attractor-engine.test.ts` 中 auto-repair 与失败识别用例。
- 全量回归：`npm test`
- 手动验证：
  - `openoxen dev "<需求>" --verbose`
