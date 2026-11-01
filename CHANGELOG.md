# 变更记录

本仓遵循语义化版本；0.x 阶段工具面与存储格式仍可能变动，升级前读对应小节。

## 0.2.0 — 2026-11-01

主题：**投递可靠性、子窗口契约与并发安全阀**。四个 ADR：0005~0009。

### 新增

- **回调自动重试**：失败的 branch 回调按 2s 起指数退避、封顶 60s 自动重投；
  `unknown` / `not_requested` 与 origin 主动取消永不自动重投（ADR-0005）。
- **读回执 `callback.read_at`**：`delivered` 只代表进收件箱；订阅宿主 `session/event`
  观测到消息进入 origin 历史才记已读并停止重投。超过宽限期仍无回执时对账三态
  （历史 / 收件箱 / 都不在→补投一次），只对 7 天内送达的回调生效。
- **child 心跳 `last_turn_at`**：`agent/status` + `session/event` 驱动、按 run 节流，
  与会被自身投递重置的 `last_activity_at` 分开。
- **回调正文上限**：内联正文 4000 字符截断 + `window_status(run_id)` 指针（ADR-0006）。
- **`window_list` 的 `attention` 聚合**：分页/筛选前统计 failed / unknown / unread /
  orphaned，`hint` 给行动建议；`total=0` 时不给提示（ADR-0006）。
- **重复开窗观测**：branch run 记录 `open_key`，同源同内容仍有活动 run 时回执带
  `duplicate_of` 与处置建议，**只观测不拦截**（ADR-0007）。
- **常驻分支契约**：给活动 branch child 的 system prompt 注入 `dsh-window-branch`
  section（run_id + 完成必须 `window_complete` + 回调字数上限），agent 销毁时释放；
  插件晚启用时回填已在线的 agent（ADR-0008）。
- **origin 级并发上限**：`maxActiveRunsPerOrigin`（缺省 16），超限时 `window_open` /
  `window_dispatch` 返回 `WINDOW_ORIGIN_BUSY` 并给出活动读数与收口建议；拒绝不排队（ADR-0009）。
- **三行拆分**：对话组 `dsh-window` / 管控组 `dsh-window/control` / 协作组
  `dsh-window/topic`，插件页可逐行开关，关掉的行工具根本不注册。

### 修复

- `window_wait` 的 output schema 缺 `last_turn_at`，含心跳的 run 整条回执被宿主拒收。
- `window_list` 的 `callback.readAt` 输出为 camelCase，与 schema 的 `read_at` 不一致。
- 分支契约初版只挂在 `agent/created`：宿主在该事件之前就创建了 agent，契约从未生效；
  改为 run 落盘后立即挂载。

### 升级注意

- 新增配置：`callbackRetryMs`、`activityTouchMs`、`callbackGraceMs`、
  `callbackReceiptWindowMs`、`maxActiveRunsPerOrigin`（均只由对话组读取）。
- 三行的 `dataRoot` 必须同值，否则 run 与 topic 互相看不见。
- 旧 run 记录无需迁移：`open_key` / `last_turn_at` / `read_at` / `contract_attached`
  缺失时按「无观测」处理。
- 行为变化：回调失败不再停在 `failed` 等人工；并发开窗超过上限会被拒绝。

### 文档

- ADR-0005 回调投递可靠性、ADR-0006 正文上限与注意力聚合、
  ADR-0007 重复开窗观测、ADR-0008 常驻分支契约、ADR-0009 origin 并发上限。
- README 新增读数对照表（每个字段什么时候该信）；E2E 指南新增 H（冒烟）与 I（契约探针）。

### 测试

278 条（vitest），`tsc --noEmit` 与 `tsdown` 构建通过；关键路径有一次真实宿主验收记录。
