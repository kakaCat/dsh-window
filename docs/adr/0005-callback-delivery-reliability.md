# ADR-0005：回调投递可靠性（自动重试 + 读回执 + child 心跳）

- 状态：**已实现**
- 日期：2026-11-01
- 关联：REQ G-5（可恢复、可诊断）、FR-5（完成回调）、FR-8（`unknown` 不盲重投）、ADR-0004（停滯检测：本 ADR 只做它的 C-1「原料」，不做 C-2 看门狗）

## 一、要解决的问题

`window_complete` 之前的投递模型是「尝试一次 → 落盘 → 等人工或等下一次插件启动」：

- 运行期间 origin 冷一分钟，结果就停在 `callback=failed`，直到有人 `window_retry_callback` 或重启插件才可能送到；
- `callback.status='delivered'` 只代表宿主收件箱收下了消息。origin 的回合若在把消息写进历史之前被取消/崩溃，消息就静默消失，而盘上永远记着 `delivered`，既不会重投，也没有任何读数暴露它；
- `lastActivityAt` 是插件自己的写入/投递时间，会被「越救越新」的投递动作重置（ADR-0004 §三），无法回答「child 最近有没有真的推进」。

## 二、决策

### 1. 运行期自动重投（`src/application/callbackDelivery.ts`）

- 只由**对话组**启动一个调度器（与 reconcile/drain 同所有权），缺省每 2s 扫一遍；
- 只重投 `pending`/`failed` 且 `nextAttemptAt <= now` 的回调；退避 2s 起、翻倍、封顶 60s；
- `delivered` / `unknown` / `not_requested` 永不自动重投（保持 FR-8）；
- 每次重投与 `window_complete`、`window_retry_callback`、启动 reconcile 共用同一个 `attemptCallback`，同一 `callbackId` 幂等；
- 重投**不写** `lastActivityAt`：它是 orphan 判据的输入，不能被插件自己的投递重置。

新增配置：`callbackRetryMs`（缺省 2s）。

### 2. 读回执（`callback.readAt`）

- 订阅宿主 `session/event`，看进入历史的消息 `source.callbackId`；命中某 run 的回调即写 `readAt`，并清掉 `nextAttemptAt`；
- 状态机不变（`delivered` 仍是终态之一），`readAt` 是「已读」的证明：没有 `readAt` 的 `delivered` 只是收件箱回执；
- 超过 `callbackGraceMs`（缺省 60s）仍无 `readAt` 时做一次对账（每 run 至少间隔 5 分钟）：
  - `history` → 落 `readAt`；
  - `inbox` → 仍在排队，什么都不做；
  - `absent` → 既不在历史也不在收件箱，判定为被丢弃，改回 `pending` 并立刻到期补投一次（每个进程最多补投一次，跨进程各一次，`callbackId` 幂等）；
  - `unknown` → 判定不了就保持原状，绝不猜。

### 3. child 心跳（`lastTurnAt`）

- 订阅 `agent/status`（running）与 `session/event`，按 run 节流写 `lastTurnAt`（缺省 30s 一次）；
- 与 `lastActivityAt` 分工：后者是写入/投递时间，前者只随 child 的消费/推进刷新；
- `window_status` / `window_list` 暴露 `last_turn_at`；`window_wait` 超时提示改为「两者都旧才可疑」。

新增配置：`activityTouchMs`（30s）、`callbackGraceMs`（60s）。

## 三、边界（刻意不做）

- 订阅**只用于观测**：不自动完成 run、不写 result、不改 run 状态（反向探针 `test/reverseProbes.test.ts` 守着这条）；
- 不做 ADR-0004 的 C-2 看门狗（提醒/停滞判定），本次只铺它需要的 `lastTurnAt` 原料；
- 不改 `orphanTimeoutMs` 语义，不把 child 心跳混进 orphan 判据；
- 不引入数据库/事务队列：状态仍以 `run.json` 为唯一权威，调度器只是它的读扫描器。

## 四、验收

- `test/callbackDelivery.test.ts`：退避值、到期重投、未到期不投、单条失败不阻塞、终态不重投、读回执三分支、宽限期、调度器 tick/stop；
- `test/sessionActivity.test.ts`：事件折算、无宿主能力时降级、`locate` 四态、心跳节流、终态不写心跳、读回执纠正 `failed`、写失败被吞；
- 反向探针：`index.ts` 仍不直接订阅、观测层不得调用 `completeRun` 或写 `status:'completed'`；
- `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
