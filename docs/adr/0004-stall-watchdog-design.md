# ADR-0004：子窗口停滞检测（设计稿，未实现）

- 状态：**提议／待批**（本 ADR 只记录设计，不改状态机）
- 日期：2026-10-18
- 关联：REQ L51（G-2）、L54（G-5）、L67、L742、L895；ADR-0003 第 5 条

## 一、要解决的问题（事故形状）

一次真实事故：两个 child run 各自陷入「读 → 压缩 → 再读」的循环（A：67 次工具调用全是读、37 次压缩、0 次写；B：82 读 / 49 压缩 / 0 写），**从未调用 `window_complete`**。

- 墙上时间：seed 13:24:41 → 投递 guidance 13:59:11（34.5 分钟）→ 人手动 `interrupt(mode=run)` 14:37:21（再 38.2 分钟），合计 72.7 分钟。
- origin 期间 6 次 `window_inspect(include_history=true)`、1 次 `window_send`（`accepted`），但**没有任何信号告诉它「这个 child 停住了」**。

结论：**恢复通道全都在（send / interrupt / dispatch / retry），缺的是判据**。人在 72 分钟后才发现，因为插件从不输出「停滞」这个判定。

## 二、本次已落地的（A+B，属诊断面，不是检测面）

| 层 | 改动 | 作用 |
| --- | --- | --- |
| A | REQ L742 / `ports.ts` 文档：`lastActivityAt` **不随每个回合刷新** | 说清它不可作停滞判据，堵住后续误用 |
| B1 | `runStore.readIndexRaw()` 逐行补齐 `lastActivityAt ?? updatedAt ?? createdAt ?? 0`；`listRuns` 同口径兜底 | 旧索引行不再让 `RunStatusRow.lastActivityAt` 变成 `undefined`（类型此前在说谎） |
| B2 | `window_wait` 超时回执带 `hint`（值 + output schema + 摘要渲染） | 超时那一刻直接告诉模型「超时≠停滞」与下一步，而不是让它自己猜 |
| B3 | `window_inspect` 回执带 `run_status`/`lifecycle_state`，摘要对 `running=false` 且 `run` 仍 `pending|running` 报「不一致」 | 把「会话不在线、run 却在跑」这个此前无法区分的关键交叉信号显式化 |

B2/B3 只加文字与只读事实，**不改任何状态、不写 callback、不触发 lifecycle**。

## 三、为什么不能直接用 `lastActivityAt` 做 watchdog（核心陷阱）

`lastActivityAt` 记录的是**写入/投递时间**，不是**消费时间**：

- `sendGuidance.ts` 在投递成功后就刷新它 —— 即使 child 从未消费；
- `openWindow.ts` 在 seed 时写；
- `interruptRun.ts` 在控制操作时写。

因此「`lastActivityAt` 超过 N 分钟 → 判定停滞」的 watchdog **会被自己的投递动作重置**：越频繁地救，越检测不到「没救活」。ADR-0003 第 5 条（重投幂等）也是同一类教训。

**任何 C 方案必须挂在 child 自己的消费/推进信号上**，例如宿主侧的 turn 边界事件（`tools/pre-execute`、`tools/result` 之类按 agent 归属的事件），而不是 `lastActivityAt`。

## 四、C 方案设计（两段，可分别批复）

### C-1 每回合 touch（喂给判据的原料）

- 在 `tools/result`（`this: Scoped<ToolRuntime>`，带 `exec.agent`）里按 `windowKeyOf(exec)` 取 child 身份，`withLock` 写 `lastActivityAt`（或新增独立字段 `lastTurnAt`，**推荐后者**，避免与「投递时间」语义打架）。
- 节流：同一 run 至多每 N 秒（建议 30s）写一次，避免热路径写放大（每次工具调用都写 `run.json` + 索引是不可接受的）。
- 只对 `status === 'running'` 的 run 写。

已知阻塞点（必须先验）：

1. `PluginContextLike`（`src/index.ts`）目前只暴露 `logger/inject/provide/effect`，**没有 `on`**，要接事件需扩类型并 typecheck。
2. `dsh-scope` 未安装，`Scoped<ToolRuntime>` 的取用方式需确认。
3. `tools/result` 是全局热路径，失败必须完全吞掉，绝不能影响工具本身。

### C-2 有界看门狗（只提醒，不自动改状态）

- 由一个低频计时器（建议 60s，与 `waitRuns` 的轮询完全分离）扫描 `running` 且 `lastTurnAt` 超阈值（建议 15 分钟）的 run。
- **只做一件事**：给 origin 投一条提醒，比如「run X 已 15 分钟没有推进，可能停住了；`window_inspect` 看 `running`、`window_send` 追加引导、或 `interrupt(mode=run)` 后 `window_dispatch`」。
- 同一 run 的提醒按退避发（如 15/45/120 分钟），**每 run 至多 3 次**，之后静默。
- **绝不**：自动 `window_complete`、自动写 result、自动改 callback、自动 `markOrphaned`、自动重投 seed。

### 明确不做（P0 红线不破）

REQ L67 的「不做基于回合/内容推断的自动完成」与 L895 的「lifecycle stop/orphan 只能由 origin 或 Host 内部对账触发」保持不变；FR-8 的 `unknown` 永不自动重投保持不变；`orphanTimeoutMs`（默认 24h）语义不变。

## 五、验收判据（若日后实现 C）

1. 一个「只读不写」的 run 在两倍阈值内必然收到提醒，且提醒里含 run id 与三个可选动作。
2. 一个正常推进的 run **永不**收到提醒（用「每回合 touch」验证，而不是靠投递）。
3. 投递 guidance 后 child 仍不消费 → 提醒照旧触发（证明不被自身的投递重置）。
4. 热路径：`tools/result` 写失败 300 次，工具结果不受影响，run 状态不被污染。
5. 全量测试 + `test/reverseProbes.test.ts` L147（「插件根本不订阅宿主事件」）随实现一并更新。

## 六、当前建议

先只上线 A+B（已做，见 §二）——它们让「停住」在 1 次 `window_inspect` / 1 次 `window_wait` 超时内即可被看见，成本是 0 状态改动。C 需要动插件事件面与热路径写，建议单独批复、单独验收。
