# ADR-0006：回调正文上限与 `window_list` 注意力聚合

- 状态：**已实现**
- 日期：2026-11-01
- 关联：ADR-0005（投递可靠性）、REQ G-5、哲学「尽量少占人的注意力」

## 一、要解决的问题

ADR-0005 让结果能可靠送到 origin，但没解决「送到多少」与「谁需要人看」：

- `window_complete` 的 `content` 没有上限。child 交一份几万字的报告，回调就整段写进 origin 的历史，直接吃掉 origin 自己的可用上下文——投递越可靠，这个代价越大；
- `window_list` 只逐条给 `callback.status`。要判断「有没有东西卡住了」，模型（或人）得逐条读、必要时再 `window_status`；分页之后更看不见全貌；
- seed 消息 id 是随机 UUID：同一条 run 一次投递失败后无法按 id 对账，也不能体现「同一 run 的 seed 最多一份」。

## 二、决策

### 1. 回调正文内联上限（`formatCallbackText`）

- 超过 4000 字符：截断到 4000 + `…`，并加一行「正文已截断：完整 N 字符，用 window_status(run_id) 读取」；
- 完整正文**始终**完整保存在 run 记录里（`result.content`），截断只发生在投递文本上；
- 不截断 `structured`（它是契约结果，单独有 schema 校验），也不改回调状态机。

代价：origin 收到的是「结论 + 指针」而不是全文。这与 ADR-0005 的读回执配套——origin 读了摘要，需要细节时用 `window_status` 拉全文。

### 2. `window_list` 的 `attention` 聚合

- 统计范围：**本窗口可见**的全部 run，先算聚合，再做 status / topic / 时间窗过滤与分页；
- 每一行按最高优先级只计一次：`unknown` > `failed` > `delivered` 且无 `read_at`；`orphaned` 独立累加；
- `total` = 命中的 run 数（并集，不是计数相加），`hint` 用一句话说清「该做什么」；
- `total = 0` 时不给 `hint`：没有需要人看的东西，就不占用注意力。

刻意没有加入的项：`child_offline`（冷会话 ≠ 死会话，误报成本高）、`retrying`（当前策略下所有 `failed` 都会重投，字段冗余）。

### 3. seed 消息 id：`seed-<runId>`

- `window_open` / `window_dispatch` 的 seed 消息 id 由 runId 派生，不再随机；
- 同一条 run 的 seed 天然幂等；日志、收件箱与 run 记录可以按同一个 id 对账。

## 三、边界

- 不改变 `window_complete` 的完成语义与结果存储；
- 不因 `attention.total > 0` 自动做任何动作（不自动重试、不自动收口、不自动完成）；
- 聚合只读，不影响 `rows` 的排序、分页与既有字段。

## 四、验收

- `test/callbackDelivery.test.ts`：超限截断、未超限原样；
- `test/listRuns.test.ts`：四类各计一次、并集 `total`、status/分页不影响聚合、他人 run 不计入、全正常时无 `hint`；
- `test/callbackReliability.integration.test.ts`：真实文件存储下 `seedMessageId === seed-<runId>`；
- `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
