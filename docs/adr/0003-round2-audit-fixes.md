# ADR-0003：第二轮审核修复（含一处上轮修复引入的反向漏洞）

- 状态：已采纳
- 日期：2026-10-17
- 背景：第一轮修复完成后，对**修复后的代码**重跑六维度审计 + 8 组修复的对抗验证

## 对抗验证结论（先给结论）

上一轮的 8 组修复经逐条对抗核验，**全部 `held`**（无 `partial`/`not_held`/`regressed`）：topicAppend 归属与 completionId 派生、`appendEntry` 幂等归属/内容校验、lifecycle 四处锁化、orphan 在线否决、drain 原子写 + 损坏隔离 + 索引新鲜度、unknown 落盘 + reconcile 分流 + retry 双拦截 + interrupt lifecycle/claim、status 字段 + delivery 分字段 + 幂等键、stopForOrigin 身份约束 + execView + 死导出 + 严格项 + 错误码表。

## 二轮新发现的高危（5 条）与修法

1. **completionId 抢占防护的反向漏洞（上轮修复引入）**
   上轮把 completion 的归属放宽为「origin 或 child」，于是 **origin 能抢先**用 child 的 `run_id` 写一条 completion：它占住确定性派生的 `cmp_<runId>`，之后 child 真正的 `window_complete` 因「同 ID 异窗口」被硬拒 → **run 永久卡 running**，且这次 append 还释放了 child 的占用。
   修法：`kind='completion'` 且带 `runId` 时**只允许该 run 的 child**（真正的完成者）写；origin/child 的宽授权仅适用于非 completion 的引用类写入。
2. **`sendGuidance` 无锁 `runStore.update` 覆盖终态**
   `FsRunStore.update` 是非锁定读改写；`sendGuidance` 未持锁调用它，与 `completeRun` 持锁写 result 并发时用旧快照把终态抹回 running（真实 FsRunStore 重放：终态被覆盖 143/300，持锁对照 0/300）。
   修法：该写路径改为 `store.withLock(runId, ...)`。
3. **`openWindow` 武装回调的两步写未持锁**
   与 `stop`/`drain` 并发时会把已落 `cancelled + not_requested` 的 run 写回 `running + armed`。
   修法：同一锁内重读，终态即不写。
4. **`interrupt(mode='turn')` 静默清空 child 收件箱**
   宿主的 `Agent.cancel` 默认丢弃排队输入，而回执承诺「收件箱与后续引导保留」（宿主停止按钮传 `keepInbox`，`session-stop` 才故意不传）。
   修法：`cancelTurn` 传 `keepInbox: true`，让回执与行为一致。
5. **重投不做 `callbackId` 对账 → 重复回调**
   宿主 inbox 以 `message.id` 去重，重复投递抛「already pending」；旧实现把它记为 `failed`，等首条被消费后再 reconcile/retry 就投出**第二条**重复回调。
   修法：`AgentMessenger` 把「同一 messageId 已在收件箱」收敛为**已投递**（该逻辑消息恰好一次在队列里），不再记为 failed。

## 其余修复（中/低）

- **存储**：`settle()` 改为等**所有** key 的排队写入（此前只等索引锁，drain 回执的「已落定」不成立）；`run.json` 增加必需字段形状校验（缺字段按损坏隔离，避免 NaN 比较流入用例）；JSONL 逐行容错（半行不再让整份留痕消失）；`writeJsonAtomicSync` 补目录 fsync；`rebuildIndex` 走 `INDEX_LOCK`；`listIndex` 新鲜度改为「按有 run.json 的目录 + mtime」判定（此前按目录计数，损坏隔离后每次都全量重建）。
- **生命周期**：`reconcile` 接入主题台账 `cleanup()`（此前是死端口，`projects/` 下 `.tmp` 永不清）；`FsTopicStore.cleanup` 不再走 `ready()`——清理是恢复动作，不能被坏 journal/manifest 挡住，也不该为清理而 bootstrap 存储根；reconcile 重投「投递成功但状态写回失败」时降级落 `unknown`（与 complete/retry 同口径），避免下次对账重复投递。
- **安全**：`stopForOrigin` 改为 **fail-closed**（`isWindowAlive` 未装配/抛错/无法判定/在线 一律拒绝代停）；`reason` 必填且 ≤500；`topicClaim` 的 `run_id` 补归属校验（共享投影 `active_run_ids` 可被他人读到）；`AgentMessenger.createMessage` 显式拒绝 `kind='user'`（红线不再靠调用点自觉）；`cancelTurn` 只认热窗口，不再冷恢复离线 child 后谎报「已请求取消」。
- **契约**：回调消息 `source` 补 `childSessionId`/`callbackId`（FR-7）；`window_status` 的 `result` 补 `topic_revision`；Host Service `open` 的 `delivery` 补 `runError`/`topicNote`；`AgentMessenger` 热/冷路径失败原因并列保留。
- **可观测性**：非法 `runId` 改抛结构化 `WINDOW_INVALID_INPUT`（原为裸 `Error`）；`AgentMessenger.describe` 保留宿主 `{error:...}` 的真实原因（原压成 `object`）；`window_complete` 摘要不再把 `unknown` 误述为「回调未送达」（unknown = 可能已送达、状态未落盘）。
- **文档**：§7.2 不变量 11 与 §6 口径统一为「确定性 completionId + 幂等收敛（无共享事务）」；§9 去掉重复的 `WINDOW_CALLBACK_UNKNOWN` 行、把 title 上限归到 `WINDOW_OPEN_FAILED`、把 `WINDOW_SEED_DELIVERY_FAILED` 标注为「保留码，当前不抛出」；§6.18 写明 `reconcile()`/生命周期原语是宿主特权入口；e2e 指南修正「普通完成没有 lifecycle」；`window_open` 的 `callback_armed` 描述去掉「阶段 1」残留；**真正删除**死导出 `isWindowError`/`hasTopicStore`（上一轮只在 `index.ts` 摘掉再导出，文档却声称已删）。

## 二轮修复的对抗验证（10 组 → 4 held / 6 未通过，已全部再修）

对二轮修复本身又跑了一次对抗验证，结果**并不全 held**——这正是上一轮"修复引入反向漏洞"的教训：

| 被验证项 | 首轮判定 | 问题 | 处置 |
|---|---|---|---|
| cancelTurn 传 keepInbox | **not_held** | 宿主签名是 `cancel(cause, options)`，`keepInbox` 在**第二个参数**；把它塞进 cause 等于没传，收件箱仍被清空（回执继续撒谎） | 两个位置都传（旧签名兜底），运行时复验通过 |
| 存储健壮性 | partial | 索引新鲜度只比 mtime、未要求「有 run.json 必在索引里」：索引被清空/损坏后旧 run 因 mtime 更早而**永久缺席**；`list()` 把 EACCES 也当损坏、会改名毁掉合法记录 | 未入索引但存在 run.json → 判不新鲜；只有解析/形状损坏（`CorruptRunRecord`）才隔离，其它 I/O 错误如实抛出 |
| 主题与消息安全语义 | partial | `describe` 对 `{message}` 仍得 `[object Object]` | `reasonOf` 解包 `.message` |
| 生命周期与存储恢复 | partial | reconcile 在**投递本身失败**时也降级 `unknown`（把"没投"说成"不确定"）；topic cleanup 扫整个 root（越界到 runs/） | 只有 `delivered` 才降级 unknown；cleanup 只扫 `projects/` 与 `_journal/` |
| sendGuidance 锁化 | partial | 锁体内缺"重读"护栏（与 openWindow/lifecycle 不一致） | 补锁内重读 |
| 文档一致性 | partial | §9 表把 `WINDOW_OPEN_FAILED` 列了两行 | 合并为一行并写明 title 上限归属 |

复核证据：`cancelTurn` 双参数、`describe` 结构化、索引收回旧 run、cleanup 作用域四项在 dist 上运行时复验通过；另有 194 个单测（新增 3 例覆盖上述行为）。

## 已知不修（明确记录）

- `available()` 仍恒 `true`：未做真实可用性探测，改为在存储错误处统一映射为 `*_STORAGE_UNAVAILABLE`（topic 侧已做）。
- application 层 6 处 `setTimeout/setInterval` 不可注入：影响测试可控性，不影响行为。
- `ports.ts` 单文件承载四层类型、`FsTopicStore` 单把全局锁 + 每次写入全量重读 L3、`releaseClaimsForRun` 全库扫描：规模天花板，属重构而非缺陷。
- `dispatchTask` 以 child 会话 id 作锁键：这是**承重**语义（并发第二路 dispatch 必须判 `CHILD_BUSY`），不是 bug。
- 两处 `as never`（`structured`/`output_schema` 适配 dsh-tools 的 `{type:'json'}` 推断）：运行时有 schema 校验兜底。
- `RunStorePort.readAudit` 当前无内部消费者：保留为审计读 API（§8 留痕复盘）。
- Host Service 的主题方法返回 `Promise<unknown>` 且透出应用的 snake_case 回执，与其余方法的 camelCase 具名类型不一致：属契约风格债，改动会破坏既有调用方，留待统一版本处理。
- 索引新鲜度的 mtime 判定用严格 `>`：若 run.json 与 index.json 落在同一毫秒时间片且恰在两次写之间崩溃，理论上会漏判一次陈旧（下一条 run 变更会自愈）；概率极低，未引入版本号字段。
- application 层 6 处 `setTimeout/setInterval`、`ports.ts` 单文件四层类型、`FsTopicStore` 全量重读与 `releaseClaimsForRun` 全库扫描：同上，属重构而非缺陷。
