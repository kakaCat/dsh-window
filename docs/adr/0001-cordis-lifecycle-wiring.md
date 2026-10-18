# ADR-0001：Cordis 生命周期接线（启动对账与卸载排空）

- 状态：已采纳
- 日期：2026-10-16
- 背景来源：实机验收 F 用例（真实 DSH 宿主）

## 背景

`dsh-window` 需要两个生命周期动作：

1. **启动对账**（FR-19）：恢复未送达 callback、清理半截写入、按 `orphanTimeoutMs` 标记 orphan；
2. **卸载排空**（FR-19）：卸载时等待已接受的控制操作落盘，并把 active run 记为 `drained`。

最初实现假设 Cordis 会发 `ready` / `dispose` / `session-stop` 事件：

```ts
if (typeof ctx.on === 'function') {
  ctx.on('ready', runReconcile)
  ctx.on('session-stop', …)
  ctx.on('dispose', () => void drainLifecycle(deps))
} else {
  queueMicrotask(runReconcile)   // 兜底分支
}
```

## 问题

实机重启后观察对象毫无变化：无 `kind='orphan'`、无 `kind='drain'`，`lifecycle` 为空。

根因：Cordis 的 `Events` 接口（`@deepseek-ai/cordis` 的 `events.d.ts`）**只声明了 `internal/*` 事件**，并不存在 `ready` / `dispose` / `session-stop`。由于 Cordis `Context` 一定有 `.on`，判断恒为真，于是永远走订阅分支，兜底分支永不执行 —— 对账与排空实际上从未运行。

## 决策

1. **启动对账**：不依赖任何事件，插件装载后无条件 `queueMicrotask(runReconcile)`。
2. **卸载排空**：用 Cordis 正牌清理机制 `ctx.effect(execute, label)`；`execute` 返回的 disposer 会在 fiber 卸载时被调用（异步 disposer 会被 await）：

   ```ts
   ctx.effect(() => async () => { await drainLifecycle(deps) }, 'dsh-window: drain')
   ```

3. **不依赖 `session-stop` 事件**：origin 停止/归档由宿主或业务插件通过 Host Service `stopForOrigin(originId, reason)` 显式驱动（§6.5 已提供该方法）。
4. **同步兜底**：实机证实宿主**退出时不 await 异步 disposer**，故新增 `RunStorePort.drainActiveRunsSync(reason, at)`：用同步 fs 写 `lifecycle.state='drained'`、追加 `kind='drain'` 控制记录、同步重建 `runs/index.json`；`drainLifecycle` 先走同步路径，再 await `settle` 与兜底异步循环（幂等，不重复写）。
5. **orphan 判定收紧**：FR-19 要求「origin 不可用**超过** `orphanTimeoutMs`」；原实现「一不在线即判死」会在每次启动误判大批 run 为孤儿。现改为**必须先超过阈值**，是否在线只用于补充 `reason` 文案。

## 验证

- 实机：run `b6096ff0…` 在 origin 离线且超阈值后 → `status='orphaned'` + `control.jsonl kind='orphan'`；
- 实机：run `2b8a2d50…` 在宿主退出后 → `lifecycle.state='drained'` + `control.jsonl kind='drain'`（时间戳在退出前约 3 秒）；
- 单测：`test/runStore.test.ts` 覆盖 `drainActiveRunsSync`（幂等 + 索引投影）；`test/lifecycle.test.ts` 覆盖「未超阈值不 orphan」；`test/plugin.test.ts` 断言 drain 注册为 effect；
- 门禁：`pnpm typecheck / test / build` 全绿（147 测试）。

## 影响与代价

- 卸载排空改为同步写：会短暂阻塞退出路径，但 run 数量有限且只在卸载时发生；
- 宿主**不保证**在强杀进程时调用 disposer：同步兜底只能覆盖「disposer 被调用但进程随后立刻退出」的情形；强杀场景仍可能无 drain 记录，此时由下次启动的 `reconcile` 兜底（orphan 判定基于超时，不会误伤）。
