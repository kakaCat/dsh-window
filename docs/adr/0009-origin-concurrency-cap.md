# ADR-0009：origin 级并发上限（拒绝，不排队）

- 状态：**已实现**
- 日期：2026-11-01
- 关联：ADR-0005（投递可靠性）、ADR-0007（重复开窗观测）、REQ 非目标「不做完整调度器」

## 一、要解决的问题

一个 origin 窗口可以无限开 branch 子窗。每个 child 都是真实成本：一个会话、独立的模型调用、
磁盘与侧栏窗口。一次模型重试循环，或一段没写好的批量脚本，可以在几分钟内开出几十个，
而 origin 自己看不到全貌。

先说实话：本机现有数据里**没有失控事故**（4 个 origin 的累计 run 是 16 / 8 / 6 / 1，
同一秒并发最多 2 条）。所以这是**安全阀**，不是 bug 修复。

## 二、决策：拒绝，不排队

- 新配置 `maxActiveRunsPerOrigin`（缺省 16）；
- 统计口径：`originSessionId` 相同、`status` 为 `pending`/`running`、且生命周期未被
  `stop`/`orphan`/`drain` 的 run；终态不计入；
- `window_open` 与 `window_dispatch` 在**建会话/建 run 之前**判定：超限时抛
  `WINDOW_ORIGIN_BUSY`，回执带 `active` / `limit` / `active_run_ids`（最多 20 条）与
  「先 `window_wait` 收口，或 `window_interrupt(mode='run')` 取消不再需要的」；
- **不排队**：排队需要持久队列、超时、取消、公平性，会把本插件变成调度器，与既有边界冲突。
  真需要节流时，模型自己「收一个再开一个」即可（`window_wait` 已经提供这个原语）。

## 三、与其它规则的关系

| 规则 | 管什么 | 冲突时 |
|---|---|---|
| `window_dispatch` 单 child 单活动 run | 一个 child 上的并发 | 先报 `WINDOW_CHILD_BUSY`（更具体） |
| origin 级上限 | 一个 origin 跨多个 child 的总量 | 报 `WINDOW_ORIGIN_BUSY` |
| 重复开窗观测（ADR-0007） | 同源同内容 | 只观测，不拦截；与上限互不影响 |

三者互不替代，也不互相吞并。

## 四、边界与降级

- 读不到运行记录时**放行**：额度是安全阀，不该因为一次读失败把正常开窗打死；真读不到时
  后续 `runStore.create` 也会响亮失败；
- `continuation` 没有 run，不受额度影响；
- 不自动收口、不自动取消、不改变任何 run 状态；
- 上限只由配置改变，不接受模型参数覆盖（避免「把上限调大再开」这种自解锁）。

## 五、验收

- `test/openWindow.test.ts`：达上限拒绝且不建会话/不落 run；错误读数；终态/已停/他人 run
  不占额度；continuation 不受影响；
- `test/dispatchTask.test.ts`：达上限拒绝派单且不投递 seed；上限之下照常；
- `test/config.test.ts`：缺省 16、可配、非法值装配期失败；
- `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
