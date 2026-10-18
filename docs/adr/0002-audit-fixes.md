# ADR-0002：审核发现的缺陷修复与语义变化

- 状态：已采纳
- 日期：2026-10-16
- 背景：六维度审计（安全/正确性/测试/文档/工程/架构）+ 高危项对抗复核，共约 50 条发现

## 背景

对已交付的 15 工具 + Host Service + Topic Ledger 做了一次独立审计。总体质量可接受（安全红线基本落实、分层干净、155 个测试是真测试），但存在 2 个安全授权洞、4 个正确性缺陷（其中「lifecycle 绕过 per-run 锁」与「陈旧索引」被两个维度独立命中）以及若干契约/文档漂移。

## 决策（按类）

### 1. 安全：堵住两条越权通道

- **`window_topic_append` 的 `runId` 归属校验**：带 `runId` 时必须是该 run 的 origin 或 child，否则 `WINDOW_RUN_FORBIDDEN`。原先任何主题参与者都能填他人 `run_id`（`active_run_ids` 是公开读数）触发 `releaseClaimsForRun`，代他人释放占用。
- **`completionId` 不可由模型指定**：移除 `window_topic_append` 的 `completion_id` 参数；completion 的 ID 只由插件按 `run_id` 确定性派生（`cmp_<runId>`）。同时在 `appendEntry` 的幂等命中处加**归属 + 内容**双重校验：他人同 `entryId`/同 `completionId`、或同 ID 异内容 → `WINDOW_TOPIC_CONFLICT`。原先的「静默幂等返回」可被用来抢占真实 completion，让受害 run 的完成摘要永不入账。
- **`stopForOrigin` 身份约束**（Host Service 契约变化，见下）。

### 2. 正确性

- **lifecycle 全路径锁化**：orphan 标记、回调重投、stop、drain 兜底循环全部经 `RunStorePort.withLock`，并在锁内**重读**后再写。原先与持锁的 `complete`/`interrupt` 并发会丢更新。
- **orphan 判定加 origin 在线否决**：只有 `alive !== true` 且超过 `orphanTimeoutMs` 才 orphan。FR-19 原文是「origin 不可用**超过**阈值」；上一版实现只看闲置时长，会误杀「origin 在线、child 在跑长任务」的 run。
- **`drainActiveRunsSync` 改原子写**：`writeJsonAtomicSync`（temp+fsync+rename），不再直写 `run.json`。
- **`list()` 按条隔离损坏**：单条 `run.json` 半截/非法 JSON 改名 `run.corrupt-<ts>.json` 后跳过，不再让 list/reconcile/wait 整体瘫痪。
- **`RunListIndex` 新鲜度校验**：runId 集合 + `run.json` mtime 与索引文件对比，陈旧即重建（原先只在索引为空时重建，两次独立写之间崩溃会让索引永久陈旧）。
- **topic 存储错误收敛**：根/manifest/journal 层面失败统一抛 `WINDOW_TOPIC_STORAGE_UNAVAILABLE`，不再透出裸 `Error`。

### 3. 回调终态

- **`unknown` 可落盘**：回调状态写盘失败时把 `unknown` 也**再尝试落盘一次**，盘上不再停在 `pending` 被 reconcile 盲重投。
- **reconcile 只重投 `pending`/`failed`**，`unknown` 不自动重发。
- **`retryCallback` 拦截**：`unknown` → `WINDOW_CALLBACK_UNKNOWN`（要求先对账同一 callbackId），`not_requested` → `WINDOW_CALLBACK_NOT_REQUESTED`（新增码）。
- **`interrupt(mode='run')` 写 lifecycle 并释放 claim**，与 stop 路径口径一致。

### 4. 契约变化（调用方需注意）

- **Host Service `stopForOrigin(originId, why, exec?)`**：新增第三参 `exec`。
  - 传 `exec`：调用者必须就是该 origin（自己停自己）；
  - 不传 `exec`（宿主生命周期/对账路径）：仅当该 origin **确实离线**才允许代停，在线则 `WINDOW_RUN_FORBIDDEN`。
  - 影响：业务插件不能再用它去取消「owner 仍在线」的 run；那种场景应由该窗口自己 `window_interrupt(mode='run')`。
- **`delivery` 增字段**：`window_open` 回执的 `delivery` 增加 `run_error` / `topic_note`（原先多个失败原因都写 `reason` 会互相覆盖）；`window_dispatch` 增加 `run_error`。
- **`window_status` 增字段**（向后兼容）：`scenario` / `created_by` / `topic_id` / `started_topic_revision` / `last_activity_at`，补齐 REQ §6.3 早已承诺但未实现的面。
- **错误码增删**：新增 `WINDOW_CALLBACK_NOT_REQUESTED`；移除从未落地的 `WINDOW_LIFECYCLE_UNAVAILABLE`（生命周期存储失败复用 `WINDOW_RUN_STORE_UNAVAILABLE`）；§9 表补齐 5 个已在用的码。
- **`window_topic_append` 新增 `idempotency_key`**：同窗口 + kind + key 命中同一 entry，供「写入已提交但响应丢失」的重试。

### 5. 工程纪律

- `tsconfig` 开启 `noUnusedLocals` / `noUnusedParameters`；
- 删除死导出 `isWindowError` / `hasTopicStore`（第二轮才真正删除声明，第一轮只摘掉了 `index.ts` 的再导出——当时文档写成"已删除"属不实，已在 ADR-0003 更正）；`exec` 形状读取在 **application 层**集中到 `src/application/execView.ts`（原先散落 3 处）；装配层 `src/index.ts` 仍读 `exec.agent.id/status` 做身份校验，属装配职责，不在收敛范围内；
- `AgentControl.cancelTurn` 空原因改为返回 `accepted:false`，与「永不抛」契约自洽；
- 刷新 `index.ts` 头注释、`cordis.patch.yml` 说明、README 配置项、REQ §7.4 目录树。

## 影响与代价

- `stopForOrigin` 的约束会改变业务插件语义（不能再代停在线 origin）——这是有意的安全收紧，代价是调用方需要改走 `window_interrupt`。
- lifecycle 锁化会让 orphan/stop 在极端并发下变慢（等待在途 complete 落盘），换来不丢更新。
- `unknown` 拦截意味着「投递状态不明」时必须人工对账，牺牲自动化换取不重复投递。

## 验证

- 单测从 155 增至 **182（27 个文件）**（第二轮审核修复后为 194）：新增 unknown 态、真并发 complete/dispatch、AgentMessenger 适配器、REQ §6 契约字面断言、title>200、wait `my_active` 正路径、权限位、topic 新安全语义、drain 原子性等用例；`pnpm typecheck / test / build` 全绿；
- 每项修复在完成清单 B9 段落有对应勾选；安全语义（越权 runId、completionId 抢占、幂等键）有专门用例。
