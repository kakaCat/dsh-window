# ADR-0007：重复开窗先观测、不拦截

- 状态：**已实现（观测阶段）**
- 日期：2026-11-01
- 关联：ADR-0005 / ADR-0006、REQ G-1（独立插件）

## 一、要解决的问题

`window_open` 每成功一次就建一个会话 + 一条 run + 一份 seed。若模型在超时/报错后重发同一个请求，就会白开一个窗口、白跑一条任务，还会多一条回调。

但「按内容去重」有真实代价：同一 origin 故意并行两个同文案分支（A/B 对比、两边各试一种做法）是合理用法，按内容合并会直接吃掉其中一条。

**所以先不写规则，先拿数据。**

## 二、决策：只观测

- 每个 branch run 记录一个 `openKey`：`sha256(origin, scenario, mode, seedText, title, targetWorkspace, topicId, topicScope)` 的 20 位前缀；
- 建窗前查一次「同源 + 同 `openKey` + 仍活动（pending/running，且未被 stop/orphan/drain）」的 run；
- 命中时：
  - 新 run 记 `duplicateOf: [runId…]`（最多 5 条）；
  - 开窗回执带 `duplicate_of` 与 `duplicate_note`（说明本次**仍照常创建**、以及可选的收口动作）；
  - **不拦截、不合并、不自动收口**；
- 查询失败（run 记录读不出来）一律当作「没有重复」：探针不能影响建窗；
- 只对 `branch` 生效：`continuation` 没有 run，也没有回调可重复。

## 三、怎么读这批数据

- 单条：`window_status(run_id)` 回执里的 `duplicate_of`；
- 全量：`grep -l '"duplicateOf"' $DSH_HOME/storages/dsh-window/runs/*/run.json`；
- 发生率 = 带 `duplicateOf` 的 run 数 ÷ 新建 branch run 数。

## 四、决策判据（拿到数据之后）

- 若重复开窗是常态（例如每周都会出现、且确认为误重发而非 A/B），再做「同键去重」：
  命中活动 run 时直接返回既有 run（`reused: true`），并提供显式 `force_new` 逃生口；
- 若极少发生，保持观测即可，不为此增加一条会误杀并行分支的规则。

## 五、边界

- 不改变 `window_open` 的成败、返回值形状（只增字段）与建窗副作用；
- `openKey` 只用于比较，不用于鉴权、不做路径、不参与去重以外的任何逻辑；
- 观测本身不得抛错、不得阻塞建窗。

## 六、验收

- `test/openWindow.test.ts`：同源同 seed 第二次开窗带 `duplicate_of` 且两条 run 都在；seed/origin 不同不报；首条已终态不报；`list()` 抛错照常开窗；
- `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
