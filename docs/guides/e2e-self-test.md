# dsh-window 实机自测指南（真实宿主验收）

> 目的：在真实 DSH 宿主里跑一遍 continuation / branch / 冷窗口 / 运行时控制 / Topic Ledger，
> 补齐 fake 宿主单测覆盖不到的部分（尤其 AC-8 冷原窗口 resume）。
> 前置：插件已装进 profile，宿主已重载，**新会话**里能看到 16 个 `window_*` 工具。

## 0. 前置检查

```bash
# 插件已在 profile 的 dependencies 与 bundles 里
cat ~/.dsh/profiles/desktop/package.json

# 宿主跑过之后应出现存储根
ls ~/.dsh/storages/dsh-window
```

会话内自查：工具列表应包含
`window_open / window_complete / window_status / window_retry_callback / window_dispatch / window_list / window_inspect / window_send / window_interrupt / window_wait / window_topic_create / window_topic_join / window_topic_get / window_topic_append / window_topic_claim / window_topic_send`。

存储根（所有取证都在这）：

```text
~/.dsh/storages/dsh-window/
├── manifest.json                       # schemaVersion / storageVersion
├── index.json                          # L0：项目与主题指针
├── audit.jsonl                         # 只读访问留痕（window_inspect）
├── runs/
│   ├── index.json                      # RunListIndex 可重建投影
│   └── <runId>/{run.json, control.jsonl, messages.jsonl}
└── projects/<projectHash>/
    ├── project.json                    # L1
    └── topics/<topicHash>/             # L2 + L3（participants/entries/claims/conflicts）
```

---

## A. continuation：续接且不回调

**操作**

1. 本窗口调 `window_open({ scenario:'continuation', seed_text:'接管当前任务：…' })`；
2. 在新窗口里让它正常做几轮，**不要**调用完成工具；
3. 回到本窗口，等一两轮。

**预期**

- 回执：`success=true`、`callback_policy='none'`、`callback_armed=false`、**无 `run_id`**；
- `window_status` 对任何 run 都查不到这次开窗；
- 本窗口**永远不出现** `source.kind='dsh-window-result'` 的消息；
- 磁盘：`runs/` 下没有这条开窗的新目录（continuation 不落 run）。

**失败特征**：本窗口收到分支结果，或 `runs/` 里出现 run 目录。

---

## B. branch：完成后回调原窗口（含结构化结果）

**操作**

1. 本窗口调
   `window_open({ scenario:'branch', seed_text:'分叉任务：…', output_schema:{type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}}}, result_required:true })`；
2. 记下回执里的 `run_id` 与 `window_key`；
3. 在子窗口调用 `window_complete({ run_id, status:'completed', content:'一句话结论', structured:{summary:'…'} })`；
4. 回到本窗口看是否收到结果。

**预期**

- 开窗回执：`run_id` 非空、`callback_policy='required'`、`callback_armed=true`、seed 里带 run_id 与完成协议；
- 本窗口收到一条 `dsh-window-result`，正文含 run_id 与「分支结果」声明，且**明确不是用户新指令**；
- 本窗口 `window_status({run_id})`：`run_status='completed'`、`callback.status='delivered'`、`result.structured` 可读、`control`/`messages` 可复盘；
  （普通完成**没有** `lifecycle`——它只在 stop/orphan/drain/interrupt-run 时写入，属可选字段）
- 磁盘：`runs/<runId>/run.json` 的 `result.structured` 与子窗口上报一致；`control.jsonl` 至少一条 `send`/`interrupt`（若做过控制）。

**失败特征**：`callback.status='failed'`（记录 `reason`），或正文被截断/改写。

---

## C. 冷原窗口 + 回调失败重试

**操作**

1. 建一条 branch run（同 B），但先**让本窗口回合结束**（origin 冷却）；
2. 子窗口调 `window_complete(...)`；
3. 本窗口再发起一轮，检查是否收到回调；
4. 制造一次投递失败（例如让 origin 会话处于不可 resume 的状态），确认 `callback.status='failed'` 后调用 `window_retry_callback({ run_id })`。

**预期**

- 冷 origin 经 `resolveAgent` 恢复后投递成功，不能因 `agents.get` 无结果就报「窗口不存在」；
- 失败时结果**仍在**（`result` 不丢），`callback.reason` 写明原因；
- `window_retry_callback` 复用同一 `callbackId`，重试成功后 `attempts` 递增，且**不产生第二条逻辑结果**；
- 磁盘：`run.json` 的 `callback.status` 变化可追溯。

**失败特征**：重试生成了新的 callbackId / 第二份 result。

---

## D. 运行时控制（list / inspect / send / interrupt / wait / dispatch）

**操作**

1. `window_list({})`：应只看到本窗口派出的 run，默认不含 result 正文；
2. `window_inspect({ window_key:<child>, include_history:true })`：只读元数据 + 分页历史（工具只给 `[tool: name]` 摘要）；
3. `window_send({ run_id, message:'补充约束' })`：目标 running 时应 `delivery='steered'`（或空闲时 `queued`）；
4. `window_interrupt({ run_id, mode:'turn' })`：run 仍 `running`；
5. `window_interrupt({ run_id, mode:'run' })`：`run_status='cancelled'`、`callback.status='not_requested'`，**不回**给 origin；
6. `window_wait({ run_ids:[…], mode:'all', timeout_ms:5000 })`：收齐或 `timed_out=true` 快照；
7. `window_dispatch({ to_window:<child>, seed_text:'再来一条' })`：产生**新 run_id**；同时派两条应得 `WINDOW_CHILD_BUSY`。

**预期**

- `send` 不创建 run、不改 `run_status`、不触发 callback；
- `interrupt(mode='run')` 后子窗口不能再 `window_complete`（`WINDOW_RUN_ALREADY_SETTLED`）；
- `wait` 不消费 callback（callback 仍照常投递）；
- 授权：无关窗口调 `list` 得到空清单，调 `inspect` 得到 `WINDOW_RUN_FORBIDDEN`。

**取证**

```bash
cat ~/.dsh/storages/dsh-window/runs/<runId>/control.jsonl
cat ~/.dsh/storages/dsh-window/runs/<runId>/messages.jsonl
cat ~/.dsh/storages/dsh-window/audit.jsonl   # inspect 的访问留痕
```

---

## E. Topic Ledger：跨窗口共享与防冲突

**操作**

1. 窗口 A：`window_topic_create({ title:'…', objective:'…' })` 拿 `topic_id`；
2. 窗口 B/C：`window_topic_join({ topic_id, scenario:'branch'|'continuation' })`；
3. A/B/C 分别 `window_topic_get({})`（L0/L1）与 `window_topic_get({ topic_id })`（L2 + 最近 L3）；
4. A 追加 `progress`；B 追加 `decision`；C 用旧 `base_revision` 追加 → 应 `WINDOW_TOPIC_STALE`；
5. A/B 同时 `window_topic_claim({ scope:'同一范围', action:'acquire', base_revision })` → 一方 `WINDOW_TOPIC_CLAIM_CONFLICT`；
6. 同一 `decision_key` 写相反结论 → `candidate` + unresolved conflict，完成时应 `WINDOW_TOPIC_CONFLICT`，追加 `resolution` 后才可完成。

**预期**

- A/B/C 读到同一 L0/L1 与递增 revision；
- L3 只按需分页，不返回完整对话，检索文本一律标记为不可信协作数据；
- 磁盘：只出现在 `~/.dsh/storages/dsh-window` 金字塔内，项目工作区零新增主题文件；原始 ID/路径不作为文件名。

---

## F. 跨工作区父子窗口与全局主题（FR-21 / FR-22）

**操作**

1. 在 workspace A 的窗口：`window_open({ scenario:'branch', mode:'create', target_workspace:'<B 的 id/标题/绝对路径>', seed_text:'…' })`；
2. 确认子窗落在 B（侧栏分组/回执 `target_workspace`），origin 用 `window_send` 发引导、child 用 `window_complete` 完成 → 回调应回到 A；
3. A：`window_topic_create({ topic_id:'topic-x', title:'…', objective:'…', topic_scope:'global' })`；
4. B 的窗口：`window_topic_join({ topic_id:'topic-x', topic_scope:'global' })`；
5. A/B 各自 `window_topic_send({ topic_id:'topic-x', topic_scope:'global', message:'…' })` → 对方会话出现 `dsh-window-topic-message` 来源消息；
6. A：`window_open({ scenario:'branch', mode:'create', target_workspace:'<B>', topic_id:'topic-x', topic_scope:'global', seed_text:'…' })` → origin/child 都进同一全局主题。

**预期**

- `target_workspace` 与 fork 组合在开窗前 `WINDOW_WORKSPACE_UNSUPPORTED`；未命中/重名分别 `WINDOW_WORKSPACE_NOT_FOUND` / `AMBIGUOUS`，均不建窗；
- 全局主题 `project_id='@global'`，不同 workspace 的窗口可读写；项目内主题对另一 workspace 仍 `WINDOW_TOPIC_NOT_FOUND`；
- `window_topic_send` 回执逐目标给 `delivered`（steered/queued）与 `failed`，发送者不在接收列表；投递失败不回滚 `message` entry；
- `window_topic_append({ kind:'message' })` 被拒（必须用 send）。

---

## G. 生命周期：origin 停止 / 超时 orphan / 重启对账

**操作**

1. 建 branch run 后关闭/归档 origin 会话（或等 `orphanTimeoutMs`）；
2. 重启插件/宿主；
3. 查 `window_list({ status:'terminal' })` 与 `window_status`。

**预期**

- origin 停止：该 origin 的 active run → `cancelled`（`lifecycle.state='stopped'`、`callback.status='not_requested'`）；
- 超时/离线：run → `orphaned`（`window_list` 可见 `lifecycle_state='orphaned'`），**不伪造** result/completed；
- 插件卸载：active run 记 `drained` 并写 `kind='drain'` 控制记录；
- 重启：`reconcile` 恢复未送达 callback、清理半截 `.tmp`、按阈值标记 orphan；continuation 不受影响。

---

## 通过判据

- A/B/C/D/E/F/G 全部符合预期，且每条的磁盘取证与工具回执一致；
- 反向探针（本仓单测已覆盖，实机再确认一次）：continuation 假回调、branch 重复回调、普通 turn/end 被当完成，三者都**不会**发生；
- 任一失败：保留 `run.json` + `control.jsonl` + `messages.jsonl` + 宿主日志，按 `callback.reason` 定位。

---

## 实测记录（2026-10-16，真实 DSH 宿主）

装载方式：`~/.dsh/profiles/desktop` 加 `dsh-window: link:/Volumes/ORICO/doc/github/dsh/dsh-window` + `dsh.profile.bundles` 加 `dsh-window`；重启后新会话可见 16 个工具。

| 用例 | 结果 | 关键证据 |
|---|---|---|
| A continuation | ✅ | 回执无 `run_id`；`runs/index.json` 无该开窗；origin 全程零回调 |
| B branch + structured + 回调 | ✅ | run `512cd016-d6b5-4e92-8772-596d542454e2`：`completed`、`callback=delivered`(attempts=1)、`structured={"summary":"e2e-ok"}`；回调原文出现在 origin 会话文件与上下文中；子窗口会话 0 命中 |
| D 运行时控制 | ✅ | `dispatch` → 新 run `0f296bbf-1aaa-4662-8d8a-16ab231290fe`；`send` → steered 且 `messages.jsonl` 仅摘要；`interrupt(turn)` → running；`interrupt(run)` → cancelled + `not_requested` 且 origin 回调数不变；`control.jsonl` 三条留痕；`audit.jsonl` 有 inspect 记录 |
| E Topic Ledger | ✅ | 主题 `t_a733fad7-07b1-4449-8008-cbbfdaf569e9`：create→rev1、append(progress)→rev2 `effective=true`；金字塔 `index.json`/`manifest.json`/`projects/24ebc59f…/project.json`/`topics/4fe19d22…/` 全 hash 段 |
| C 回调失败→重试 | 🟡 部分 | 对已 `delivered` 的 run 调 `window_retry_callback`：返回既有 `delivered`、`callbackId`/`attempts=1`/`deliveredAt` 均未变 → **不重复投递、不产生第二条逻辑结果**。完整「失败→重试成功」仍由单测覆盖（需安全制造一次投递失败） |
| F 生命周期 reconcile/orphan | ✅ | 启动 `queueMicrotask` 对账实机生效：run `b6096ff0…` 在 origin 离线且超阈值后被标 `orphaned`，`control.jsonl` 写 `kind='orphan'`（reason 含「已 240957ms 未活动」） |
| F 生命周期 drain | ✅ | run `2b8a2d50…` 在宿主退出时被标 `lifecycle.state='drained'`，`control.jsonl` 写 `kind='drain'`；证明 disposer 会被调用，但**宿主不 await 异步 disposer**，故必须走同步 best-effort |
| F stop（origin 停止/归档） | ⏳ 未做实机 | 该路径由 Host Service `stopForOrigin` 触发，需宿主会话停止事件；当前由单测覆盖（`cancelled` + `lifecycle.state='stopped'` + `not_requested`） |
| 附加：新窗口标题按任务派生 | ✅ | 同一源连开两窗：`session-5e204350…` → `续接：把标题策略写进需求文档`、`session-620331de…` → `分叉：验证新窗口标题按任务派生`；run 收尾后复查标题未被宿主自动命名覆盖 |
| 附加：投影行解包 | ✅ | 修复前 `title/agentPreset/modelSelection` 三项继承恒为 `skipped`（把 `{ver,seq,val}` 行当字符串读）；修复后同一会话的投影可读出真实值 |
| 附加：回调再次到达原窗口 | ✅ | run `f25cfe11…` 的结果消息作为 followup 出现在 origin 会话（`[DSH Window 分支结果] … 不是用户新指令`）；该 run 的存储随后已按清理要求删除 |
| 附加：child 反向控制被拒 | ✅（child 自报，单测互证） | child 在 `session-620331de…` 内尝试反向 `window_send` → `WINDOW_RUN_FORBIDDEN`，与「只有 origin 能引导」的授权红线一致 |

### F 实机中发现并修复的两个真缺陷

1. **生命周期接线错误**：Cordis 的 `Events` 接口只有 `internal/*`，**不存在 `ready` / `dispose` / `session-stop`**。原实现 `if (typeof ctx.on === 'function')` 恒为真，于是永远订阅不存在的事件 → 启动对账与卸载 drain 从不执行。
   修复：启动对账改为装载后无条件 `queueMicrotask`；drain 改用 Cordis 正牌机制 `ctx.effect(() => async () => drainLifecycle(deps), 'dsh-window: drain')`。
2. **orphan 判定过激**：FR-19 要求「origin 不可用**超过** `orphanTimeoutMs`」，原实现「一不在线即判死」，会在每次启动把大批 run 误判孤儿。
   修复：必须先超过阈值；是否在线只用于补充 reason 文案。
3. 配套：`drainActiveRunsSync()` 同步落盘（宿主退出不 await 异步 disposer 的兜底），并同步重建索引。

测试痕迹（可清理）：侧栏窗口 `session-25f6bf1e…`（continuation）、`session-c88a223a…`（branch child）、`session-5ad2f99d…`（生命周期观察子窗口）；存储 `runs/512cd016…`、`runs/0f296bbf…`、`runs/b6096ff0…`、`runs/2b8a2d50…`、主题 `t_a733fad7…`、`audit.jsonl`。
