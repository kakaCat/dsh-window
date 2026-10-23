# dsh-window 完成清单

> 依据：[REQ-DSH-WINDOW-001.md](./REQ-DSH-WINDOW-001.md) 的 FR-1～FR-22 与第 13 节实施计划（B0～B6）+ B8 条款补齐 + B9 审核修复 + B10 跨工作区父子窗口 + B11 全局主题与跨工作区消息。
> 状态基线：2026-10-23，B0～B6 + B8 已完成、B9（审核发现的缺陷与测试债）已修复、B10～B11 跨工作区能力已交付。

## 已完成（不用再动，回归即可）

- [x] B-工程骨架：package.json / tsconfig / tsdown / cordis.patch / README
- [x] `window_open`：continuation/branch 双场景、scenario 校验、默认 mode、create 落点、继承三态、seed 自署投递、诚实降级
- [x] `window_complete`：显式完成、先落结果再回调、幂等与冲突、run/callback 状态分离
- [x] `window_status`：origin/child 只读查询
- [x] `window_retry_callback`：origin 手动重试、同一 callbackId
- [x] `window_dispatch`：复用 child 再派任务、单 child 单活动 run、委派关系授权
- [x] `window_list`：分页摘要、status/topic/time_window 过滤、origin/child 授权、不返回 result 正文
- [x] `window_inspect`：inspect 元数据 + page 分页历史、run 关系授权、不可信标记、只读
- [x] `window_send`：活动 run 前置、running→steer / 空闲→queue、guidance 自署、不改 runStatus、控制留痕
- [x] `window_interrupt`：turn 只停当前轮 / run 落 cancelled + not_requested、仅 origin、离线拆分回报
- [x] `window_wait`：run_ids / my_active / topic_id 目标解析、all/any、timeout 快照、AbortSignal、不消费 callback
- [x] 结构化结果：output_schema/result_required 创建期校验并持久化、complete 校验 structured、status 回读
- [x] branch 生命周期：reconcile（orphan/回调重投/清理）、origin 停止 stop、drain 排空
- [x] Topic Ledger：`window_topic_create/join/get/append/claim` + 分层存储 + CAS/claim/conflict + open/complete 接入
- [x] `window` Host Service：`ctx.provide('window', { open, stopForOrigin })`（外部插件可选注入）
- [x] 反向探针（AC-17）：continuation 假回调 / branch 重复回调 / turn-end 假完成 / 已取消或孤儿补完成都必须失败
- [x] 基础存储：`runs/<runId>/run.json` 原子写、RunRecord（result/callback）

## B0 公共基础设施（先行）

- [x] `RunListIndex`：`runs/index.json` 可重建投影（runId/origin/child/status/callbackStatus/callbackAttempts/lastActivityAt），索引缺失/损坏时按 run.json 重建
- [x] 过滤：status/topic_id/time_window 在 `listRuns` 用例层实现（store 只提供 listIndex/list 事实源）
- [x] `lastActivityAt` 字段进 RunRecord，并在 open/complete/dispatch/retry 的每次 update 写入
- [x] `RunControlEvent` 写入口：`control.jsonl` append-only（kind ∈ send/interrupt-turn/interrupt-run/stop/orphan/drain）
- [x] Agent 能力探测：独立 `AgentControl` 适配器检查 `steer`/`cancel`/`followup` 存在性，缺失如实降级
- [x] Config schema：`dataRoot`/`orphanTimeoutMs`/`waitPollMs`，装配期校验、非法 `WINDOW_CONFIG_INVALID`
- [x] 测试：索引重建、control 追加读取、能力探测降级、config 校验

## B1 发现 → AC-24

### window_list

- [x] use case `listRuns`：读 RunListIndex，陈旧重建
- [x] 过滤：`status`（active/terminal/all）、`topic_id`、`time_window`、cursor/limit 分页
- [x] 授权：origin 只见自己派出的；child 只见分配给自己的；其他窗口结果为空（不越权返回）
- [x] 默认不返回 result.content / structured
- [x] 工具注册 + 提示词（与 window_status 分工写清：list=分页摘要，status=单条详情）
- [x] 测试：过滤/分页/授权/索引重建/不含正文

### window_inspect

- [x] `sessionController.inspect` 读元数据（标题/cwd/parent/origin/预设/模型/running）
- [x] `sessionController.page` 按需分页历史（role/time/source.kind/有界文本）
- [x] 默认仅元数据；`include_history=true` 才分页历史
- [x] 授权：本人 / 对该窗口有 run 关系的 origin；历史标记为不可信数据
- [x] 无任何写操作（不 rename/cancel/prompt）
- [x] 测试：默认元数据、历史分页、未授权拒绝、不可信标记、端口缺失/会话不可读

## B2 控制 → AC-26 / AC-27

### window_send

- [x] use case `sendGuidance`：活动 run 前置（无活动 run → `WINDOW_RUN_NOT_ACTIVE`，提示用 dispatch）
- [x] 目标 running → `steer`（最近 step 边界）；空闲 → `followup` 排队
- [x] 消息自署 `source.kind='dsh-window-guidance'`，正文带“非用户新指令”声明
- [x] 不创建 run、不改 runStatus、不写 result/callback
- [x] RunMessage 摘要（messageId/djb2 摘要，不存敏感全文）+ RunControlEvent
- [x] 工具注册 + 提示词（与 dispatch 分工：send=引导同一 run；dispatch=新 run）
- [x] 测试：steer/queue、无活动 run、无关窗口 FORBIDDEN、留痕

### window_interrupt

- [x] use case `interruptRun`：`mode='turn'` 只 `agent.cancel({kind:'hook', reason})`，run 保持 running
- [x] `mode='run'`：取消当前轮 + runStatus=cancelled + `result={status:'cancelled', content:原因, completedBy:origin}` + callback=not_requested
- [x] 目标离线：turn 如实报“未执行”；run 仍可落盘取消 + 尽力取消（拆分回报）
- [x] 授权：仅 origin；child/sibling/无关 `WINDOW_RUN_FORBIDDEN`
- [x] 控制事件留痕（不冒充 completed、不伪造 callback）
- [x] 同 origin 重复取消幂等
- [x] 测试：turn/run 两态、离线拆分、越权、不回调 origin

## B3 等待 → AC-28

- [x] use case `waitRuns`：目标集合解析（run_ids / my_active / topic_id）
- [x] `mode='all'|'any'`；优先 `RunStorePort.watch` 事件驱动，缺 watch 走 config 约束的有界轮询
- [x] `timeout_ms` 到点返回快照 + `timed_out=true`；不把 running 当完成
- [x] 观察 `exec.signal` 取消返回 `aborted` 快照；不消费 callback、不改 run
- [x] 返回结构与 window_list 行一致；默认不含 result 正文
- [x] 测试：all/any/超时/取消/授权/callback 未被消费

## B4 结构化结果 → AC-29

- [x] `window_open` / `window_dispatch` 收 `output_schema` + `result_required`
- [x] 创建时用 `@deepseek-ai/dsh-tools` JSON Schema 校验器校验（非法 → `WINDOW_OUTPUT_SCHEMA_INVALID`，不建 run）
- [x] `result_required=true` 且无 schema → `WINDOW_OUTPUT_SCHEMA_INVALID`
- [x] schema 随 run 持久化（`outputSchema/resultRequired` 字段）
- [x] `window_complete` 落结果前校验 structured：缺 → `WINDOW_STRUCTURED_RESULT_REQUIRED`；不符 → `WINDOW_STRUCTURED_RESULT_INVALID`（均不落盘不回调）
- [x] failed/cancelled 可不带 structured，content 必填；未声明 schema 不接受 structured
- [x] `window_status` 返回 output_schema 与 structured
- [x] topic completion entry 只存 completionId + 有界摘要（B6 已接入；completeRun 落 completion 指针不复制 structured）
- [x] 测试：schema 非法、必填缺失、结果不符、合法通过、status 回读、幂等不重复回调
- [x] 附加：全部 16 个工具的回执按各自 output schema 校验通过（toolOutputs.test.ts）

## B5 branch 生命周期 → AC-30

- [x] `reconcile()`：恢复未送达 callback、清理半截 `.tmp`、按 `orphanTimeoutMs`/origin 不在线标记 orphaned（topic claim 释放留 B6 接口）
- [x] `onOriginStopped`：origin 停止/归档由 Host Service `stopForOrigin` 驱动（Cordis 无 `session-stop` 事件；函数已导出），active run → stop，尽力取消 child
- [x] `drain()`：卸载时等待存储内部写入落定（`RunStorePort.settle`），超时如实报告
- [x] runStatus 扩展 `orphaned`；RunLifecycle 记录（state/reason/at）；callback 状态含 `not_requested`
- [x] stop/orphan 不伪造 completed、不写虚假 callback；orphan 保留原 callback，child 不能再“完成”
- [x] RunListIndex / window_list 能列出 orphaned（`isTerminalRun('orphaned')=true`）
- [x] 测试：启动 reconcile、超时/origin 离线 orphan、origin 停止联动、回调重投、drain 三态、清理计数

## B6 Topic Ledger → AC-18～AC-23

- [x] 分层存储：`$DSH_HOME/storages/dsh-window` 下 `index.json / projects/<hash>/project.json / topics/<hash>/{topic,summary}.json / participants|entries|claims|conflicts/`，`_journal/` 事务恢复
- [x] `window_topic_create`：幂等创建/按 ID 打开，目标不一致 → conflict
- [x] `window_topic_join`：本人加入、首份快照、同 scenario 幂等
- [x] `window_topic_get`：省略 topic_id → L0/L1；提供 → L2 + 最近 L3；cursor/limit 分页
- [x] `window_topic_append`：progress/decision/completion/conflict/resolution，revision CAS（base_revision），candidate + unresolved conflict，supersedes/resolution 关联
- [x] `window_topic_claim`：acquire/renew/release，scope 唯一未过期占用，过期接管，历史保留
- [x] L1/L2 汇总投影与重建（明细为准）
- [x] 接入点：`window_open(topic_id)` 参与登记、continuation 手工 completion、branch complete 自动 completion（completionId 指针，不复制 structured 正文）
- [x] 测试：共享读取、金字塔分层、CAS 并发、claim 过期、冲突解决、重启恢复、路径归属、A/B/C 同一 L0/L1 一致性
- [x] `window` Host Service（§6.5）：`ctx.provide('window', ...)`，方法面覆盖全部工具用例 + `reconcile` + `stopForOrigin`

## B8 需求条款差距补齐（2026-10-16 审计后）

- [x] §6.5 Host Service 全方法面：`open/complete/get/retryCallback/list/inspect/dispatch/send/interrupt/wait/topicCreate/join/get/append/claim/reconcile/stopForOrigin`
- [x] FR-17 / §6.16：`window_wait` 支持 `status` 过滤
- [x] §7.5：`RunMessage` 独立留痕（`messages.jsonl`，只存摘要，`window_send` 写入）
- [x] §7.5 / FR-19：`RunLifecycle.state` 增加 `drained`；`drain()` 写控制记录与 drained 状态
- [x] FR-16：`window_status` 返回 `lifecycle` / `control`（最近 20 条，最新在前）/ `messages`；`window_list` 行带 `lifecycle_state`
- [x] §8：`window_inspect` 成功读取写 `audit.jsonl` 访问留痕
- [x] §6.12：`window_inspect` 历史给工具名摘要（`[tool: name]`），不返回工具日志全文
- [x] §6.9：claim 租约上下限改为插件配置（`leaseMinMs` / `leaseMaxMs`，缺省 1s / 24h）
- [x] FR-20：窗口标题策略（显式 `title` > 任务派生 > 源标题递增 > `skipped`；跳过协议行 / 去列表符 / 折叠空白 / 36 字符截断；半角与全角编号递增；三态回报，`rename` 失败不撤销会话、不影响预设与模型）
- [x] 测试：新增 [completionGaps.test.ts](test/completionGaps.test.ts) 覆盖以上 8 项

## B10 跨工作区父子窗口（FR-21 第一阶段）

- [x] `window_open(target_workspace)`：workspace id / 绝对路径 / 标题三级唯一命中；未命中 / 歧义 / 注册表缺失分别 `WINDOW_WORKSPACE_NOT_FOUND` / `AMBIGUOUS` / `UNAVAILABLE`，三者都不建窗、不投递 seed
- [x] 仅 `mode=create`：fork（含 branch 默认 fork）与 `topic_id` 组合都在开窗前返回 `WINDOW_WORKSPACE_UNSUPPORTED`
- [x] 回执 `target_workspace: { id, title, path? }` + seed 落点行；跨区子窗的 seed / guidance / complete / wait 复用既有 origin→child 授权，不新增任意窗口投递
- [x] 测试：`test/crossWorkspaceTarget.test.ts`（寻址/歧义/候选/注册表缺失/create 透传）+ `test/openWindow.test.ts` 跨区用例
- [x] 下一阶段（B11）：全局主题与跨工作区消息，已放开 `target_workspace` + `topic_scope=global` 的组合

## B11 全局主题与跨工作区消息（FR-22 第二阶段）

- [x] `topic_scope='project'|'global'` 贯穿 `window_topic_create/join/get/append/claim/send` 与 `window_open`；缺省 project，完全向后兼容
- [x] 全局主题固定落在保留命名空间 `@global`，真实 workspaceId/cwd 不得占用；L0 重建保留 global 来源，删除索引后可恢复
- [x] 不同 workspace 的窗口可加入同一全局主题并读写；项目内主题仍按项目隔离（跨项目 join 返回 `WINDOW_TOPIC_NOT_FOUND`）
- [x] `window_topic_send`：先落 `kind='message'` entry，再向其他 active 参与者投递 `dsh-window-topic-message`；发送者排除、参与者去重、逐目标 delivered/failed、单次上限 50（超出 skipped）
- [x] `window_topic_append` 拒绝 `kind='message'`（必须走 send，避免写进台账却没投递）
- [x] `window_open(mode=create,target_workspace=…,topic_scope=global)` 跨区子窗与 origin 登记进同一全局主题；项目内 topic 仍拒绝与 target_workspace 组合
- [x] 测试：`test/topicStore.test.ts`（global 归一/保留命名空间/重建/message entry）+ `test/topicTools.test.ts`（跨项目 join、send 逐目标、跨区 open、L1 全局清单）

## 收口验收（全部批次完成后）

- [ ] AC-1～AC-3、AC-5～AC-30、AC-32、AC-33 全过（含反向探针：continuation 假回调、branch 重复回调、turn/end 假完成必须失败）
  > dsh-window 侧 AC-1～AC-3、AC-5～AC-14、AC-16、AC-18～AC-30、AC-32、AC-33 已有测试覆盖；**AC-17 的反向探针已落地**（[reverseProbes.test.ts](test/reverseProbes.test.ts)：continuation 无 run 且拒绝完成、branch 同结果不重复回调/改内容被拒、seed 后保持 running 且对账不回调、已取消/孤儿 run 不能补完成）。
  > 仍缺：AC-8 冷窗口 resume 的真实宿主路径需实机验证。
- [x] `pnpm typecheck / test / build` 全绿（dsh-window：**220 测试 / 28 文件**，2026-10-23 跨工作区父子窗口与全局主题后）
- [x] 依赖扫描无 `dsh-pmboard / pm-* / tool-pm`（`src/` 与 `package.json`；boundary 测试为反向探针）
- [ ] 实机：continuation 续接不回调；branch 完成回调原窗口；冷窗口与失败重试有证据
  > **已实测（2026-10-16，真实 DSH 宿主）**：
  > A continuation：开窗回执无 `run_id`，`runs/` 无记录，origin 全程零回调 ✅
  > B branch：run `512cd016…` `completed`、`callback=delivered`（attempts=1）；`result.structured={"summary":"e2e-ok"}` 与 `outputSchema/resultRequired=true` 落盘；回调消息**真实出现在 origin 会话上下文中**（`[DSH Window 分支结果] … 不是用户新指令`），子窗口会话 0 命中 ✅
  > D 控制：`dispatch` 新 run、`send` steered 且 `messages.jsonl` 只存摘要、`interrupt(turn)` 保持 running、`interrupt(run)` 落 `cancelled` + `callback.not_requested` 且不回调 origin；`control.jsonl` 三条留痕齐全；`window_inspect` 写 `audit.jsonl` ✅
  > E 主题：`create`→rev1、`append(progress)`→rev2 `effective=true`；L0/L1 读取正常；磁盘金字塔 `index/manifest/projects/<hash>/topics/<hash>` 全 hash 段 ✅
  > F 生命周期：启动对账实机生效 —— run `b6096ff0…` 在 origin 离线且超阈值后标 `orphaned` + `control.jsonl kind='orphan'`；宿主退出时 run `2b8a2d50…` 标 `lifecycle.state='drained'` + `control.jsonl kind='drain'` ✅
  > F 实机中发现并修复：① Cordis 无 `ready`/`dispose`/`session-stop` 公共事件，原订阅恒不触发 → 改为无条件 `queueMicrotask` 对账 + `ctx.effect` drain；② orphan 判定改为必须先超 `orphanTimeoutMs`（原先一不在线即判死）；③ 新增 `drainActiveRunsSync` 同步兜底（宿主退出不 await 异步 disposer）。
  > **仍缺**：C 的「失败→重试成功」需安全制造一次投递失败（单测已覆盖）；F 的 origin 归档 stop 需宿主会话停止事件（Host Service `stopForOrigin` 已提供，单测覆盖）。
- [x] 文档（FR/接口/错误码/本清单）与实现一致（含 §6.18 Host Service 契约与 §13 状态表刷新）
  > 本轮审核后重新对齐：§9 错误码表补齐 `WINDOW_CONFIG_INVALID` / `WINDOW_INVALID_INPUT` / `WINDOW_RUN_STORE_UNAVAILABLE` / `WINDOW_TOPIC_PROJECT_REQUIRED` / `WINDOW_TOPIC_CLAIM_NOT_FOUND` / `WINDOW_CALLBACK_NOT_REQUESTED`，移除未落地的 `WINDOW_LIFECYCLE_UNAVAILABLE`；§7.4 目录树补 `messages.jsonl` / `audit.jsonl`；`delivery` 增 `run_error` / `topic_note`；§6.11 注明扁平 `from`/`to`；README 补 `leaseMinMs`/`leaseMaxMs`。

## B10 第二轮审核修复（2026-10-17）

> 第一轮修复后重跑六维度审计 + 8 组修复对抗验证：**8/8 held**（无 not_held/regressed）。二轮新发现 5 条高危已修，详见 [ADR-0003](../adr/0003-round2-audit-fixes.md)。

- [x] **反向漏洞**：`kind='completion'` 带 `runId` 时只允许该 run 的 **child** 写（origin 抢先写会占住 completionId 令真实完成永久被拒）
- [x] `sendGuidance` 与 `openWindow` 的 `runStore.update` 全部改走 `withLock`（非锁定读改写会覆盖终态；真实 FsRunStore 重放：无锁 143/300 覆盖 → 持锁 0/300）
- [x] `interrupt(mode='turn')` 传 `keepInbox: true`（不再静默清空 child 收件箱，回执与行为一致）
- [x] 回调重复投递收敛：宿主 inbox 以 message.id 去重抛 "already pending" 时按**已投递**处理（否则首条消费后会补发第二条重复回调）
- [x] `settle()` 等所有 key 的排队写入（drain 回执的「已落定」才成立）
- [x] `run.json` 必需字段形状校验（缺字段按损坏隔离，不再让 NaN 比较流入用例）；JSONL 逐行容错（半行不再丢整份留痕）
- [x] `listIndex` 新鲜度改按「有 run.json 的目录 + mtime」判定（此前按目录计数，损坏隔离后每次全量重建）
- [x] `writeJsonAtomicSync` 补目录 fsync；`rebuildIndex` 走 `INDEX_LOCK`
- [x] `reconcile` 接入主题台账 `cleanup()`（死端口接线，`projects/` 下 `.tmp` 不再永留）；`FsTopicStore.cleanup` 不再走 `ready()`（坏 journal 不能挡住恢复动作）
- [x] reconcile 重投「投递成功但写回失败」降级落 `unknown`（与 complete/retry 同口径，避免重复投递）
- [x] `stopForOrigin` **fail-closed**：`isWindowAlive` 未装配/抛错/无法判定/在线一律拒绝代停；`reason` 必填 ≤500
- [x] `topicClaim` 的 `run_id` 补归属校验；`createMessage` 显式拒绝 `kind='user'`；`cancelTurn` 只认热窗口（不再冷恢复后谎报已取消）
- [x] 回调 `source` 补 `childSessionId`/`callbackId`（FR-7）；`window_status.result` 补 `topic_revision`；Host Service `open.delivery` 补 `runError`/`topicNote`
- [x] 文档口径：§7.2 不变量 11、§9 重复行与 title 归属、§9 保留码标注、§6.18 宿主特权入口、e2e 指南 lifecycle、`window_open` 的 `callback_armed` 文案
- [x] **真正删除**死导出 `isWindowError`/`hasTopicStore`（上一轮只在 index.ts 摘掉再导出，文档却声称已删）
- [x] 非法 `runId` 抛结构化 `WINDOW_INVALID_INPUT`；`describe` 保留宿主结构化 error；`window_complete` 摘要不再把 `unknown` 说成「未送达」
- [x] 二轮新增回归用例：重复 messageId 收敛、`kind='user'` 拒绝、热窗口才取消、非法 runId、run.json 形状校验、JSONL 半行容错、索引不再每次重建
- [x] 二轮修复自身的对抗验证（10 组 → 4 held / 6 未通过）后复修：`cancelTurn` 的 `keepInbox` 改传宿主真正的第二参数（`cancel(cause, options)`）；索引新鲜度要求「有 run.json 必在索引里」（索引损坏后旧 run 不再永久缺席）；`list()` 只隔离解析/形状损坏、EACCES 等如实抛出；`describe`/`reasonOf` 解包 `.message`；reconcile 仅在 `delivered` 时降级 unknown；topic cleanup 只扫 `projects/`+`_journal/`；§9 去掉重复行


## B9 审核修复（2026-10-16 六维度审计 + 对抗复核）

### 安全

- [x] `window_topic_append` 带 `runId` 时校验该 run 存在且调用方是其 origin/child，堵住「借他人 run_id 释放占用」（`WINDOW_RUN_FORBIDDEN`）
- [x] 移除模型可传的 `completion_id`；completion 的 `completionId` 只由插件按 `run_id` 确定性派生
- [x] `appendEntry` 幂等命中改为**归属 + 内容**双重校验：他人同 `entryId`/同 `completionId` 或同 ID 异内容 → `WINDOW_TOPIC_CONFLICT`，不再静默幂等（堵住抢占真实 completion）
- [x] `stopForOrigin` 增加调用者/离线校验（详见 REQ §6.18），不再是服务面上唯一无身份门槛的写操作

### 正确性

- [x] lifecycle 全部写路径经 `RunStorePort.withLock`：orphan 标记、回调重投、stop、drain 兜底循环都在锁内重读后再写（消除与 complete/interrupt 的 lost update）
- [x] orphan 判定加 **origin 在线否决**：only `alive !== true` 且超过 `orphanTimeoutMs` 才 orphan
- [x] `drainActiveRunsSync` 改走 `writeJsonAtomicSync`（temp+fsync+rename），不再直写 run.json
- [x] `list()` 对损坏 run.json 按条隔离（改名 `run.corrupt-<ts>.json`），单条损坏不再拖垮 list/reconcile/wait
- [x] `RunListIndex` 增加新鲜度校验（runId 集合 + run.json mtime 对比），陈旧即重建
- [x] topic 存储根/manifest 失败统一翻成 `WINDOW_TOPIC_STORAGE_UNAVAILABLE`

### 回调与终态

- [x] 回调状态落盘失败时把 `unknown` **也尝试落盘**，盘上不再停在 pending 被 reconcile 盲重投
- [x] reconcile 只重投 `pending`/`failed`，`unknown` 不自动重发
- [x] `retryCallback` 拦 `unknown`（`WINDOW_CALLBACK_UNKNOWN`，要求先对账）与 `not_requested`（`WINDOW_CALLBACK_NOT_REQUESTED`）
- [x] `interrupt(mode='run')` 写 `lifecycle.state='stopped'` 并释放该 run 的协作占用，与 stop 路径口径一致

### 契约与杂项

- [x] `window_status` 补齐 REQ §6.3 承诺字段：`scenario` / `created_by` / `topic_id` / `started_topic_revision` / `last_activity_at`
- [x] `delivery.reason` 覆盖问题修复：运行记录失败走 `run_error`、主题失败走 `topic_note`（open 与 dispatch 两处）
- [x] `window_topic_append` 新增 `idempotency_key`（同窗口+kind+key 命中同一 entry）
- [x] exec 形状读取集中到 `src/application/execView.ts`（原先散落 3 处）
- [x] `AgentControl.cancelTurn` 空原因改为返回 `accepted:false`（契约「永不抛」自洽）
- [x] `requireLiveDriver` 文案中性化（不再写死 window_open）
- [x] `AgentMessenger.deliver` 冷路径失败时并列保留热路径原因（同「reason 覆盖」类问题，附带回归用例）
- [x] tsconfig 开启 `noUnusedLocals` / `noUnusedParameters`；删除死导出 `isWindowError` / `hasTopicStore`；刷新 `index.ts` 头注释与 `cordis.patch.yml` 说明

### 测试债

- [x] 新增：unknown 态落盘与 reconcile 不重投、retry 拦截 unknown/not_requested、interrupt-run 生命周期与 claim 释放、并发 complete/dispatch、AgentMessenger 冷恢复、REQ §6 契约字面断言、title>200、wait `my_active` 正路径、topicStore 权限位、topic 新安全语义（幂等键/抢占/越权 runId）、drain 原子性残留检查
- [x] 共享带锁 `MemoryRunStore`（`test/helpers/`）替代无锁直通 fake
- [x] 反向探针 3 改为如实表述（不再声称发射过 turn/end 信号）
