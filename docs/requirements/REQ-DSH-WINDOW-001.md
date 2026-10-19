---
req_id: REQ-DSH-WINDOW-001
title: dsh-window 独立插件：双场景、Topic Ledger 与 branch 运行时调度
status: draft
created_at: 2026-10-16
updated_at: 2026-10-16
sides: backend
---

# dsh-window 独立插件：双场景、Topic Ledger 与 branch 运行时调度

## TL;DR

把通用的窗口能力抽成独立插件 **`dsh-window`**，并明确只提供两种任务场景：

| 场景 | 触发 | 新窗口职责 | 原窗口职责 | 完成回调 |
|---|---|---|---|---|
| `continuation`（续接） | 当前窗口上下文将满 | **接管并继续当前任务** | 退出执行或转为旁观，用户在新窗口看后续结果 | **不需要，也不得触发** |
| `branch`（分叉） | 当前任务拆出独立分支 | **完成分叉任务** | 保留主任务，可继续工作 | **必须回调完成内容到原窗口** |

两个场景通过必填参数 `scenario='continuation'|'branch'` 选择，不能靠 `mode='fork'|'create'`、是否传 seed 或调用方文案猜测。

`mode` 只是“如何创建会话”的技术选项，`scenario` 才是“为什么开新窗口、完成后找谁”的业务语义；两者正交。

在双场景之上增加**项目主题台账（Topic Ledger）**：同一项目的多个窗口可围绕同一 `topic_id` 共享参与者、决策、进度、产物和完成内容。台账使用**持久化存储**，内存只能做缓存；信息按 **L0 全局索引 → L1 项目摘要 → L2 主题摘要 → L3 明细事实** 的金字塔读取。它是跨场景的协作记录，不是第三种开窗场景，也不要求同步完整对话。

在 branch 场景上再增加**运行时调度层**：发现自己的 child 与 run（`window_list` / `window_inspect`）、复用 child 再派任务（`window_dispatch`）、运行中引导（`window_send`）、中断与取消（`window_interrupt`）、等待/join（`window_wait`）、结构化结果（`output_schema` / `structured`），以及 branch run 的生命周期所有权（stop / orphan / drain）。该层只作用于 `branch`；`continuation` 是所有权主动转交，不参与运行时控制。

---

## 1. 背景与现状

窗口能力原先散落在业务插件内部，与业务状态机耦合，无法独立安装与复用。早期实现可以创建/分叉会话并投递底稿，但没有把“续接当前任务”和“分叉后回传结果”建成两条明确链路，也缺少运行中的发现、引导、中断、等待与生命周期收口。

### 1.1 要解决的核心问题

- **场景混用**：续接和分叉都表现为“打开新窗口”，但完成后的归属完全不同，不能共用一套默认回调行为。
- **续接缺边界**：当前任务已交给新窗口后，再把结果传回原窗口会打断原窗口，也违背“由新窗口继续”的意图。
- **分叉缺闭环**：原窗口保留主任务时，需要知道分支是否完成以及具体完成内容，现有实现没有返回通道。
- **完成语义易错**：普通 `turn/end` 只代表一个回合结束，不等于分叉任务完成；多回合或等待人工确认的任务不能提前报喜。
- **失败与冷窗口**：分支完成时原窗口可能忙碌、冷却或暂时不可用，结果必须持久化并支持重试。
- **运行时控制缺层**：只做一次性派单时，origin 无法发现自己派出的 child/run、无法运行中纠偏、无法中断失控任务、无法等待多个分支收齐、无法用结构化结果自动收口，也无法在自身归档时回收 branch 生命周期。

---

## 2. 需求目标与非目标

### 2.1 目标

- **G-1 独立插件**：不安装、不加载任何外部业务插件时，`dsh-window` 仍能完成两类开窗和 branch 结果回调。
- **G-2 续接无回调**：continuation 只把当前任务交给新窗口，不创建分支 run，不向原窗口发送完成消息。
- **G-3 分叉有闭环**：branch 创建持久化 `run_id`，完成后将状态与内容准确投递到创建分支的原窗口。
- **G-4 完成可信**：branch 只接受显式完成信号或宿主业务插件的确定性完成信号，不以普通回合结束冒充任务完成。
- **G-5 可恢复、可诊断**：支持冷原窗口、忙碌原窗口、重复完成、投递失败、插件重启和人工重试。
- **G-7 项目协作记忆**：同一项目的多个窗口能查到彼此的任务范围、有效决策、进度和完成内容，并通过版本与占用规则减少重复和矛盾交付。
- **G-8 branch 运行时调度**：origin 能发现自己创建的 child/run，能复用 child 再派任务、运行中引导、中断/取消、等待终态，并用结构化结果和生命周期规则收口 branch，而不是只做一次性派单。

### 2.2 非目标

- 不创建操作系统或 Electron 并列窗口；本文“窗口”指 **DSH 会话**，新会话只出现在侧栏，不承诺自动打开或切换 GUI。
- 不把任何外部业务插件的需求状态机、席位、owner/worker/observer 角色或上下文水位阈值迁入 `dsh-window`。
- 不替代 DSH subagent，不把普通会话续接/分叉改成父子 subagent 关系；FR-13～FR-19 只补窗口级调度控制，不引入进程内 activation 所有权或 delegation depth 预算。
- 不做任意窗口广播，不允许模型指定任意回调目标，不允许冒充用户发言；主题台账采用共享读取，不等于向所有窗口推送消息。
- 不在主题台账中复制完整对话，也不让它成为外部业务状态机或任务 DAG 的第二份权威数据源。
- 不承诺自动理解所有自然语言并发现全部语义矛盾；P0 只确定性拦截版本过期、范围占用和显式冲突，其他矛盾必须被记录和解决，不能静默忽略。
- 不因为收到 branch 回调就自动通过人工门、自动验收或自动归档。
- P0 不做基于回合/内容推断的自动完成、多窗口进度面板和回调链可视化；FR-19 的 orphan 超时只针对 origin 不可用，不等于任务完成或失败判定。
- `window_send` / `window_interrupt` 只允许 branch run 的 origin 作用于自己的 child，不做任意窗口广播、不允许 child 反向控制 origin 或 sibling。
- branch 生命周期所有权只覆盖 `branch` run，不扩张到 continuation 的所有权转交，也不替代外部业务插件的业务归属与拍板权。
- `window_inspect` 默认只读元数据，完整对话内容必须显式分页请求；它不是无限制读取任意窗口历史。

---

## 3. 双场景定义

### 3.1 场景对照

| 维度 | `continuation` | `branch` |
|---|---|---|
| 典型请求 | “上下文满了，开新窗口接着做” | “拆一个分支任务出去，做完把结果告诉我” |
| 当前任务归属 | 转给新窗口 | 仍归原窗口，新窗口只负责分支 |
| 新窗口任务 | 原任务的续接部分 | 可独立交付的分支任务 |
| 原窗口后续 | 退出执行、observer 或仅查看 | 可继续主任务，也可等待分支结果 |
| 默认 `mode` | `create`，通过断点底稿续接，避免复制将满的上下文 | `fork`，默认共享当前上下文；需要隔离时可改 `create` |
| `seed_text` | 必填：当前任务断点、现状和下一步 | 必填：分支目标、范围、验收和需回传内容 |
| `run_id` | **不生成** | **必须生成并持久化** |
| 完成入口 | 不提供本场景的完成回调 | `window_complete` 或 Host Service |
| 完成回调 | **无，且禁止由后续状态变化补发** | **必须支持，不可关闭** |
| 完成内容去向 | 默认留在新窗口；启用 topic 后可由参与者主动查询 | 投递到 branch 创建时的原窗口，并同步写入所绑定的 topic |

### 3.2 选择规则

工具描述与宿主提示词必须使用以下规则：

1. 新窗口要**成为当前任务的接管者**，选 `continuation`；
2. 原窗口仍拥有主任务，只把**独立分支**交出去并等待结果，选 `branch`；
3. 不得因为使用了会话 `fork` 就判定为 branch，也不得因为使用 `create` 就判定为 continuation；
4. 不得为了回避回调而把实际分支任务标成 continuation；
5. 原窗口上下文将满时优先 continuation；branch 回调会再次占用原窗口上下文，完成内容应是结论与产物指针，而不是完整对话记录。
6. 多窗口共同完成一个项目主题时，必须共用同一 `topic_id`；决策和完成上报先读取最新 revision，不得拿开窗口时的旧快照覆盖他人进展。
7. 只有 branch 进入运行时调度层（list / inspect / dispatch / send / interrupt / wait / structured / lifecycle）；continuation 是所有权转交，不得被这些控制工具当成 branch child。

---

## 4. 目标流程

### 4.1 continuation：续接当前任务，不回调

```text
原窗口（上下文将满）          dsh-window                 新窗口
        │                         │                         │
        │ scenario=continuation   │                         │
        ├────────────────────────▶│ create/fork + 投递断点   │
        │                         ├────────────────────────▶│ 接管当前任务
        │◀── window_key，无 run_id │                         │
        │                         │                         │
        │ 不等待完成回调            │                         │ 持续推进至完成
        ▼                         │                         ▼
退出执行 / observer / 用户查看新窗口       结果留在新窗口；可写 topic 供主动查询，不主动回传原窗口
```

### 4.2 branch：分叉执行，完成回调

```text
原窗口（保留主任务）          dsh-window                 分支窗口
        │                         │                         │
        │ scenario=branch         │ 创建 run_id 并持久化      │
        ├────────────────────────▶│ create/fork + 投递分支底稿 │
        │                         ├────────────────────────▶│ 执行分支任务
        │◀── window_key + run_id  │                         │
        │ 可继续主任务              │                         │
        │                         │ window_complete / Service │
        │                         │◀────────────────────────┤
        │                         │ 先保存结果，再投递回调     │
        │◀────────────────────────┤                         │
        │ 收到状态 + 完成内容       │                         │
        ▼                         ▼                         ▼
```

普通 `turn/end` 而没有完成信号时，branch run 保持未完成，不发送完成回调。回调投递失败时，完成结果仍保留，可查询并重试。

### 4.3 Topic Ledger：同一项目多窗口共享与防冲突

```text
窗口A（主任务/发起者）       Topic Ledger（共享台账）        窗口B/C（其他参与者）
       │                             │                              │
       │ create/join topic           │                              │
       ├────────────────────────────▶│ R=0                          │
       │                             │                              │
       │ window_open(topic_id)       │ join + 读取同一 revision 快照 │
       ├────────────────────────────▶│◀─────────────────────────────┤
       │                             │                              │
       │ progress / decision / claim │ append-only entry            │
       ├────────────────────────────▶│ R → R+1                      │
       │                             │◀──── window_topic_get ───────┤
       │                             │  A/B/C 读取同一事实           │
       │                             │                              │
       │                    B：continuation 完成                     │
       │                             │◀── append(kind=completion) ──┤
       │                             │ 只写共享台账，不发消息        │
       │                             │                              │
       │                    C：branch 调 window_complete             │
       │                             │◀─────────────────────────────┤
       │                             │ completionId + entry R+n      │
       │◀──────── callback ──────────┤ 再回调 origin=A               │
       │                             │                              │
       ├────────────────────────────▶│ topic_get：双方完成内容可见   │

并发与矛盾防护（A、B 都基于 revision=R 工作）：

A append / decision / claim ──▶ 原子提交成功，R → R+1
B 仍用旧 R 写入            ──▶ WINDOW_TOPIC_STALE
B topic_get 读取新内容      ──▶ 用 R+1 重试、选择其他 scope，或追加 resolution
同 scope claim            ──▶ WINDOW_TOPIC_CLAIM_CONFLICT（协作软占用，不是文件锁）
decision_key 结论冲突       ──▶ candidate + unresolved conflict
                              → resolution 后才允许相关 completion
```

图中 `R` 是 topic revision。`window_topic_append` 只改变共享台账，绝不向原窗口推送；唯一会产生 origin callback 的路径是 branch 的 `window_complete`。

### 4.4 branch 运行时调度：发现 / 引导 / 中断 / 等待 / 结构化 / 生命周期

```text
origin（原窗口）              dsh-window                       child（分支窗口）
     │                            │                                │
     │ window_open / window_dispatch                              │
     │                            │ open=建新会话 / dispatch=复用   │
     ├───────────────────────────▶│ 创建 run，投递 seed             │
     │                            ├───────────────────────────────▶│ 执行分支任务
     │◀── window_key? + run_id ───┤                                │
     │                            │                                │
     │ window_list / window_inspect                                │
     ├───────────────────────────▶│ 只读盘点：派出哪些、谁在跑、状态 │
     │                            │ （随时可调用，不改任何状态）     │
     │                            │                                │
     │ window_send（运行中纠偏）    │ 活动 run 才有                  │
     ├───────────────────────────▶│ running→steer / 空闲→followup  │
     │                            ├───────────────────────────────▶│ 最近 step 边界生效
     │                            │                                │
     │ window_interrupt(turn)     │ 只停当前轮，run 保持 running    │
     ├───────────────────────────▶│ agent.cancel(hook reason)      │
     │                            ├───────────────────────────────▶│ 当前轮被中断
     │                            │                                │
     │ window_wait(all/any+timeout)                                │
     ├───────────────────────────▶│ 等终态；超时返回当前快照        │
     │                            │ （只读，不消费 callback）       │
     │                            │                                │
     │                            │ window_complete（结构化校验）   │
     │                            │◀───────────────────────────────┤
     │                            │ 落 result → topic entry → 回调  │
     │◀── callback（dsh-window-result）                             │
     │                            │                                │
     │ window_interrupt(run)      │ run=cancelled                  │
     ├───────────────────────────▶│ callback=not_requested         │
     │                            │ （origin 自己取消，不回调自己） │
     │                            │                                │
     │ origin 归档/停止/超时      │ stop / orphan / drain           │
     ├───────────────────────────▶│ 尽力取消 child、释放 claim      │
     │                            │ 插件重启 → reconcile 对账       │
```

三条纪律贯穿全图：

1. `window_send` / `window_wait` 只读或引导，**不创建 run、不写 result、不触发回调**；
2. `window_interrupt(mode='turn')` 不改变 run 状态，`mode='run'` 是终态且 origin 主动取消**不回调自己**；
3. callback（push）与 wait（pull）并存互补，wait 永不消费 callback。

---

## 5. 功能需求

### FR-1：独立插件工程（P0）

- 新仓库/包名为 `dsh-window`，ESM，提供 Host 插件与 Agent 工具；P0 不要求 Client UI。
- 运行时不得依赖 `dsh-pmboard`、`pm-core`、`pm-common`、`tool-pm`，不得读取 PM 需求台账。
- 只允许依赖 DSH 公开能力，如 `sessionController`、`agents`、`workspaceRegistry`、Storage；服务按调用时解析，缺失时结构化失败。
- 必须有独立的 `package.json`、装载清单、README、构建、类型检查和测试命令。

### FR-2：显式双场景（P0）

`window_open` 新增必填参数：

```ts
scenario: 'continuation' | 'branch'
```

- 缺少或传入其他值时返回 `WINDOW_SCENARIO_REQUIRED`，且不创建会话；
- 两个场景都要求非空 `seed_text`；仅创建空白会话不属于本工具 P0 场景；
- 不提供 `callback` 布尔参数，回调策略由 scenario 唯一决定，避免“branch 但关闭回调”等矛盾组合；
- continuation 默认 `mode='create'`，branch 默认 `mode='fork'`，调用方可显式覆盖；
- 返回体必须包含 `scenario` 和 `callback_policy`，分别为 `continuation/none` 与 `branch/required`。

### FR-3：共享开窗能力（P0）

两个场景共用以下能力：

- `mode='fork'|'create'`、`at_seq`、`title`、`seed_text`；
- create 落点按 `workspaceId` 优先、`cwd` 兜底；两者均不可得时响亮失败，不落到宿主进程目录；
- **标题策略**：显式 `title` 优先；未给时按任务派生 `续接：<seed 首条有效内容>` / `分叉：<seed 首条有效内容>`，再回退源标题递增，三者都没有才 `skipped`。完整判定、派生规则与失败语义见 **FR-20**，不得在别处再写一套标题判定；
- 标题、Agent 预设、模型分别以 `set/skipped/failed` 回报，继承失败不撤销已创建会话；投影读数是 `{ver,seq,val}` 行时必须先解包 `val` 再判定缺失；
- 返回真实 `window_key`，且不得等于源会话；
- seed 使用 `source.kind='dsh-window-seed'`，不得使用 `sessionController.prompt`；
- 文案只能说“会话已创建，请在侧栏打开”，不能宣称已打开并列窗口。

### FR-4：continuation 续接行为（P0）

- 创建并投递当前任务断点底稿后，返回 `window_key`、`scenario='continuation'`、`callback_policy='none'`，**不返回 `run_id`**；
- 不创建 branch run、不注册完成监听、不创建 callbackId；
- 新窗口后续完成、归档、空闲、回合结束或发生其他状态变化，都不得因此向原窗口发送结果回调；
- 原窗口是否继续运行由调用方决定；`dsh-window` 不擅自修改外部业务插件的归属或席位；
- 外部业务插件的接管流程使用本场景，保持“新窗口接管、原窗口旁观”的既有语义，完成后也不回调原窗口；
- continuation 可以通过 `window_topic_append` 把进度和完成内容写入项目主题台账，供原窗口及其他参与者主动查询；写台账不等于回调，不得因此向 origin 发消息；
- continuation 不进入 branch 运行时控制层：没有 run_id，不能被 `window_list` 当作自己的 branch run，不能被 `window_send` / `window_interrupt` / `window_wait` / `stop`/`orphan` 管理。

### FR-5：branch 持久化 run（P0）

- 每次 branch 创建全局唯一 `run_id`，持久化 origin、child、seed、结果和 callback 状态；传入 `topic_id` 时还要保存 topic、开跑 revision 与协作范围；
- run 记录必须区分 `createdBy='open'|'dispatch'`：open 创建新会话，dispatch 复用已有 child、不创建会话；两者共用同一运行状态机；
- 记录使用与 Topic Ledger 相同的分层 JSON 持久化存储，不得只保存在进程内存；
- branch 所需存储不可用时应在意图校验阶段响亮失败，且不创建会话；不得退化为内存记录后继续承诺回调；
- branch seed 必须附带 `run_id` 和完成协议，明确“实际分支任务完成后调用 `window_complete` 上报状态与完成内容”；有 topic 时还要附最新 revision、有效决策和活动占用摘要；
- 插件重启后恢复未完成 run 与未送达 callback，不丢失已保存的完成内容。

### FR-6：branch 显式完成（P0）

新增 `window_complete`，并提供等价的 Host Service 完成入口：

- 仅适用于 branch run，支持 `completed | failed | cancelled` 和非空 `content`；
- 只有 seed 已送达且 `callback_armed=true` 的活动 run 才能首次完成；pending 或 seed_failed 返回 `WINDOW_RUN_NOT_ACTIVE`，已终结 run 按 FR-8 做幂等/冲突判定；
- 调用者身份从执行上下文取得，必须等于 run 的 child，或由通过授权的 Host 业务插件明确指定 run；
- `run_id` 可省略的唯一条件是当前 child 只有一个活动 branch run；存在多个时必须显式给出，否则返回 `WINDOW_RUN_AMBIGUOUS`；
- 完成结果先持久化，再执行回调；回调失败不回滚完成结果；
- run 绑定 topic 时，首次完成必须生成共享 `completionId`，让 run result 与 completion 主题记录**对齐到同一 `completionId`**；`base_revision` 过期则返回 `WINDOW_TOPIC_STALE`，在保存结果和回调前停止，调用方读取他人新进展后重试；
  > 实现口径（如实记录）：run store 与 topic store 是两份独立存储，**没有共享事务**。两者靠「`completionId` 由 `run_id` 确定性派生 + `appendEntry` 按 `completionId` 幂等且校验归属与内容」收敛：中途崩溃会短暂出现「有 completion entry 无 result」，重试即对齐。幂等命中不再改写既有内容，冲突返回 `WINDOW_TOPIC_CONFLICT`。
- 普通 `turn/end`、Agent idle、Agent disposed 均不得单独把 branch run 改为 completed；
- continuation 没有 run，调用本工具不能伪造结果回调，应返回 `WINDOW_RUN_NOT_FOUND` 并提示该会话没有活动 branch run。

### FR-7：branch 完成内容回调（P0）

- 回调目标只取 run 创建时保存的 `originSessionId`，续跑窗口不能改写；
- 热窗口通过 `agents.get(origin).followup(message)` 投递；冷窗口通过 `sessionController.resolveAgent(origin)` 恢复后投递，并按宿主能力确认落盘；
- 原窗口忙碌时使用 followup 排队，不用 steer 打断主任务；
- 回调消息 `source.kind='dsh-window-result'`，携带 `plugin`、`runId`、`childSessionId`、`callbackId`，且 `source.kind` 永不为 `user`（已实现：`createMessage` 显式拒绝 `kind='user'`，不靠调用点自觉）；
- 回调正文至少包含 `run_id`、分支窗口、结果状态、完成内容和非人类来源说明；内容不得被静默改写或截断；有 topic 时还要包含 `topic_id`、completion `entry_id` 和对应 revision，方便原窗口核对共享记录；
- 完成内容应是分支结论、验证结果和产物路径，不默认复制完整对话或工具日志；
- `delivered` 仅表示消息被原 Agent 接受并可持久化，不表示用户已读、内容已验收或主任务已完成；
- `callback_policy='required'` 只约束 child 正常完成；origin 主动 `window_interrupt(mode='run')` / 生命周期 stop 时 callback=`not_requested`，不算违反回调用例。

### FR-8：幂等、冲突与重试（P0）

- 同一 `run_id` 以相同状态、相同 content 且相同 structured 重复完成：先按既有结果幂等返回，不再次写主题记录或投递，也不因 topic revision 已前进而误报 stale；
- 同一 `run_id` 已完成后以不同状态、content 或 structured 完成：返回 `WINDOW_RUN_ALREADY_SETTLED`，不得覆盖首次结果；
- `callbackId` 由 `run_id` 确定性生成；重试前检查本地状态，能读取原会话日志时还要核对同一 callbackId 是否已存在；
- 回调失败保存 `failed + reason`；`window_retry_callback` 只允许用于结果已保存但回调未确认的 branch run；
- 如果消息可能已发出但送达状态未能持久化，状态标为 `unknown`，先对账再重试，不盲目宣称 delivered 或无声重复发送；
- P0 至少保证普通重复调用不重复产生回调；崩溃导致的极端重复必须通过相同 callbackId 可识别、可对账，不谎报严格 exactly-once。

### FR-9：状态查询与部分失败（P0）

新增 `window_status`：

- 按 `run_id` 返回 origin、child、run 状态、结果、callback 状态、尝试次数、最近错误和时间字段；
- run 状态与 callback 状态必须分开，避免“结果已完成但尚未送达”被显示成“全部完成”；
- 非 origin、非 child 的 Agent 调用者返回 `WINDOW_RUN_FORBIDDEN`，不得读取完成内容；
- 会话已创建但 run/seed 未成功时，返回 `success:false` 和已创建的 `window_key`（如可得），并明确 `delivery`（`delivered/kind/reason`，运行记录失败另见 `run_error`）与 `callback_armed` 的真实状态；
- 完成落盘成功而回调失败时，`window_complete` 返回“完成已记录”与真实 callback 状态，不能把结果回滚成未完成；
- 日志不得输出完整 seed 或结果正文，只记录 ID、状态、错误和耗时；后台异常不得破坏 DSH 事件派发。

### FR-11：项目主题台账（P0）

- `window_topic_create` 在当前项目创建或按 ID 幂等打开一个主题，记录项目、目标、创建者和单调递增 `revision`；项目身份优先取 workspaceId，无 workspace 时才使用规范化 cwd 并明确标记来源。
- Topic、participant、entry、claim、conflict 及 revision 都必须持久化。P0 使用插件自有的分层 JSON 存储（根目录固定、文件原子替换、事务日志恢复），因为它能直接表达“项目 → 主题 → 摘要/明细”的目录金字塔；内存只允许做读缓存和短期锁，不能作为事实源。插件重启后必须恢复完整主题状态。
- 主题存储不可用时，所有 `window_topic_*` 返回 `WINDOW_TOPIC_STORAGE_UNAVAILABLE`；带 `topic_id` 的 `window_open` 也必须在意图校验阶段失败且不创建会话，不得静默降级成内存台账或未跟踪协作。
- `window_topic_join` 允许当前窗口主动加入已有主题并取得首份快照；只能加入自己，不能代其他窗口加入。`window_open` 的 origin/child 加入复用同一用例。
- `window_topic_get` 按金字塔读取：省略 topic_id 时返回 L0/L1 的项目与主题摘要；提供 topic_id 时返回 L2 主题摘要和必要的最近 L3 明细；历史记录分页读取，不默认返回任何窗口的完整对话。
- L1/L2 中的 activeRuns 只保存 `run_id` 指针，不复制 run 状态；实时状态以 run store / `window_list` 为准。
- `window_open` 接受可选 `topic_id`：提供时，origin 与 child 在投递 seed 前完成参与登记并取得同一 revision 快照，seed 成功后参与状态为 active，失败则记 seed_failed；branch run 同时绑定 topic 和该开跑 revision。缺席时保持原双场景行为，但返回 `topic_tracking=false`，不得声称具备协作防冲突能力。
- `window_topic_append` 允许参与者追加 `progress | decision | completion | conflict | resolution` 记录；记录只能追加，修正历史通过 `supersedes_entry_id` 指向新记录，不能篡改旧内容。写入明细后必须更新或重建对应 L1/L2 汇总投影。
- continuation 的完成内容通过 `window_topic_append(kind='completion')` 写入，不触发回调；branch 的 `window_complete` 自动写入 completion 后再按 FR-7 回调，两个场景共用一份可查询事实；
- branch 的 structured 结果只存 run result；topic completion entry 只保存 `completionId` 与有界摘要，不复制完整 structured，避免两套真相。
- 主题消息按不可信协作数据处理，不能冒充用户指令或人工批准。

### FR-12：协作矛盾防护（P0）

- 每个主题维护单调递增 revision；decision、completion 和 acquire claim 必须携带调用方最近读取的 `base_revision`，写入采用持久化 compare-and-swap、单条原子记录或带恢复日志的等价串行提交。
- revision 已变化时返回 `WINDOW_TOPIC_STALE` 和当前 revision，调用方必须先 `window_topic_get` 读取新记录，再决定是否基于新 revision 重试；不得覆盖或静默丢弃他人记录。
- `window_topic_claim` 提供按任务/模块/文件范围的**协作占用声明**，支持 acquire、renew、release 和 `expires_at`；同一 scope 已有未过期占用时，其他窗口 acquire 返回 `WINDOW_TOPIC_CLAIM_CONFLICT`。
- 占用是 Agent 协作软约束，不伪装成操作系统文件锁；完成时自动释放对应占用，过期占用可被接管，但历史必须保留。
- 同一 `decision_key` 出现不同结论时：带有效 `supersedes_entry_id` 和替代理由的是正常演进；未指明替代关系的新结论只能保存为 `candidate`，同时生成 unresolved conflict，不得直接变成有效决策。
- 同一范围的重复完成或调用方显式发现的矛盾也必须形成 conflict。存在与当前工作相关的 unresolved conflict 时，completion 和 `window_complete` 返回 `WINDOW_TOPIC_CONFLICT`，在结果与回调前停止。
- `resolution` 必须关联 `conflict_id`，明确采用哪个 candidate/既有结论或双方均不采用；解决后保留全部历史，未解决的冲突不能显示成“无冲突”。

### FR-13：发现与只读查看（P0）

新增 `window_list` 与 `window_inspect`：

- `window_list` 列出当前调用窗口创建的 branch run（默认按 `updated_at` 倒序，分页），每行至少给 `run_id`、`child_window_key`、`run_status`、`callback.status`、`topic_id`（有则给）、`created_at/updated_at/last_activity_at`；
- `window_list` 支持按 `status`（active / terminal / all）、`topic_id`、`time_window` 过滤；默认只返回摘要，不返回 result 正文；
- 授权：origin 只能列出自己创建的 run；child 可以列出分配给自己的 run；其他窗口返回 `WINDOW_RUN_FORBIDDEN`；
- `window_inspect` 只读查看某个 child 会话的元数据（标题、cwd、父子关系、运行状态）和按需分页的历史；默认不返回完整对话，不返回未授权窗口的内容；
- `window_inspect` 不能 rename、cancel、prompt 或写任何会话状态；
- 运行状态的权威来源是 run store；`window_topic_get` 中的 activeRuns 只是指向 run 的指针，不能用主题摘要替代运行时状态。

### FR-14：`window_dispatch` 复用 child 再派任务（P0）

- 不创建新会话，向已有 branch child 创建新的 branch run 并投递 seed；
- 只允许与该 child 存在既有 origin→child 委派关系的窗口调用；continuation 接管窗口和无关系窗口返回 `WINDOW_RUN_FORBIDDEN`；
- 同一 child 同时最多一个活动 run；已有 `pending/running` run 时返回 `WINDOW_CHILD_BUSY`，完成后再派；
- 新 run 必须持久化，`callback_armed` 在 seed 送达后为 true，完成后仍按 FR-7 回调 origin；
- seed 必须包含新 `run_id` 与完成协议，不得复用旧 run_id；
- child 上下文会累积；接近上下文上限时应新开 branch/continuation，而不是继续 dispatch 到同一 child。

### FR-15：`window_send` 运行中引导（P0）

新增 `window_send`：

- 只允许 branch run 的 origin 向自己的 child 投递引导消息；child、sibling、无关窗口一律拒绝；
- 目标 child 有活动 run 时才允许；没有活动 run 返回 `WINDOW_RUN_NOT_ACTIVE`，派新任务应使用 `window_dispatch`；
- 目标正在运行 → 以 steer 方式在最近 step 边界插入；目标已空闲但有活动 run → 以 followup 排队，不打断其他窗口；
- 消息自署 `source.kind='dsh-window-guidance'`，永不为 `user`；正文必须标明“这是原窗口的运行时引导，不是用户新指令”；
- `window_send` 不创建 run、不改变 run 状态、不构成完成、不触发回调；它只返回“是否已被目标接受”；
- 找不到 live child 或投递失败时返回结构化失败，不把“已排队”说成“已执行”；
- 每条 guidance 必须留痕：sender、run_id、messageId、时间、投递结果；不得记录完整敏感正文。

### FR-16：`window_interrupt` 中断与取消（P0）

新增 `window_interrupt`：

- 只允许 branch run 的 origin 调用；child 不能中断自己或其他窗口，sibling 与非祖先一律拒绝；
- `mode='turn'`：只取消 child 当前轮次，保留 run 的 active 状态、收件箱与后续引导能力；run 不进入终态；
- `mode='run'`：取消 child 当前轮次并把 run 置为 `cancelled`，由 origin 写入 `result = { status:'cancelled', content: 原因 }`，`callback.status='not_requested'`；origin 自己取消不回调自己；
- child 已离线：`mode='turn'` 返回“目标不在线，未执行”；`mode='run'` 仍可落盘取消，并对在线 child 尽力取消，必须如实回报哪一半做了、哪一半没做；
- 中断不得冒充完成：不得写入 `completed`，不得伪造 callback delivered；
- 中断原因、执行者与时间必须写入 run 控制记录，供 `window_status` / `window_list` 复盘。

### FR-17：`window_wait` 等待 / join（P0）

新增 `window_wait`：

- 入参支持 `run_ids` 列表，或 `scope='my_active'`、`topic_id`、`status` 过滤；
- `mode='all'`：等待所有目标进入终态；`mode='any'`：任一目标进入终态即返回；
- 必须支持 `timeout_ms`；超时返回当前快照与 `timed_out=true`，不得把超时伪装成完成；
- 返回每个 run 的 run 状态、callback 状态与 result 是否存在；默认不返回 result 正文，需要时由调用方按 `window_status` 读取；
- 等待是**拉取**语义，不消费、不抑制已有的 callback；callback 仍按 FR-7 投递；
- 授权与 `window_status` 相同：origin 或对应 child；无关窗口 `WINDOW_RUN_FORBIDDEN`；
- 必须观察 `exec.signal` 取消；不得忙轮询，使用事件或受配置约束的有界轮询。

### FR-18：结构化结果（P0）

- `window_open` 与 `window_dispatch` 可传 `output_schema`（object 根、DSH 允许的 JSON Schema 子集）与 `result_required`；schema 随 run 持久化；
- `result_required=true` 但没有 `output_schema` 时返回 `WINDOW_OUTPUT_SCHEMA_INVALID`，且不创建 run；
- `window_complete` 增加可选 `structured`；当 run 声明了 `output_schema` 且 status='completed' 时，`structured` 必填并必须通过 schema 校验，否则返回 `WINDOW_STRUCTURED_RESULT_REQUIRED` / `WINDOW_STRUCTURED_RESULT_INVALID`，在落结果与回调前停止；
- `failed` / `cancelled` 可以不带 structured，但 `content` 仍必填并写真实原因；
- `window_status` 返回 `output_schema` 与已落盘的 `structured`；
- 回调正文可以使用结构化结果的 JSON（受内容预算约束）或只给 `completionId` 指针；`content` 仍是人类可读摘要；
- 绑定 topic 时，completion entry 只保存 `completionId` 与有界摘要，完整 structured 保存在 run result，不复制两份；
- 结构化结果校验失败必须可重试：失败不消耗 run、不覆盖已有结果。

### FR-19：branch 生命周期所有权（P0）

- branch run 从创建起归属 origin；只有 `branch` 受本 FR 约束，`continuation` 是所有权转交，不进入这套 stop/orphan/drain；
- origin 显式结束 run 的唯一入口是 FR-16 `window_interrupt(mode='run')`；FR-19 的 stop 是 origin 会话停止/归档/宿主触发时调用同一用例，不新增第二个取消工具；
- 生命周期状态：`stop`（origin 主动结束 run）、`orphan`（origin 长时间不可用）、`drain`（插件卸载/重启对账）；三类都写入 run 控制记录，不得静默；
- origin 归档、会话停止或显式停止时，该 origin 的 active branch run 必须进入 stop/orphan 流程；对 child 的取消是尽力而为，成败都要如实记录；
- origin 不可用超过配置的 `orphanTimeoutMs` 后，run 置为 `orphaned`，释放 topic claim，不再等待完成，也不回调；`window_list` 必须能看到；
- 插件重启时执行 reconcile：恢复未送达 callback、清理半截写入、把超过阈值的 run 标记 orphan；不能把重启当作“从未发生”；
- stop/orphan 不得伪造成 `completed`，不得写入虚假 callback；
- 外部业务插件的归属与席位是业务所有权，`dsh-window` 的 origin 所有权是运行时所有权；两者可以互相引用，但不能互相冒充。

### FR-20：窗口标题策略（P0）

标题必须让用户在侧栏一眼分辨每个窗口的用途；**同源派出的多个窗口不得因继承而默认同名**。本策略只作用于 `window_open` 新建的会话（`fork` 与 `create` 一致）；`window_dispatch` 复用既有 child，不改写标题。

**优先级链**（先命中先得，未命中才看下一级）：

1. **显式 `title`**：去空白后非空时原样使用；纯空白视为未给。超过 200 字符在开窗前返回 `WINDOW_OPEN_FAILED`，不创建会话。
2. **按任务派生**：`续接：<摘要>` / `分叉：<摘要>`，前缀由 `scenario` 决定，摘要取自 `seed_text`：跳过开头空行与 seed 协议行（`[DSH Window`、`scenario:`、`run_id:`、`完成后必须`、`普通 turn/end`、`本窗口接管`、`你正在同一个分支窗口`、`---` 分隔线），取首条有效内容行；去掉行首 Markdown 列表/引用符号（`#`、`>`、`*`、`-`），把连续空白折叠为单个空格；超过 36 字符截断并追加 `…`。
3. **源标题递增**：派生不出一行有效摘要时，回退源会话标题并递增——`标题(2)` → `标题(3)`、`标题（2）` → `标题（3）`，无编号后缀则追加 ` (1)`；递增与宿主客户端同口径，编号用大整数运算，避免精度丢失。
4. **`skipped`**：seed 无可派生摘要且源会话无标题时跳过，不猜测标题。

**回执、失败与可测性**：

- `inheritance.title` 只报 `set | skipped | failed`，原因写进 `inheritance.reasons`；不得因为“回执里带了标题”就宣称已改名成功；
- `rename` 未装配或抛错 → `title='failed'`，不影响 Agent 预设与模型继承，也不撤销已创建会话；
- 源画像读取失败且派生不出摘要 → `failed` 并给原因；不得把“读不到画像”说成“源没有标题”；
- 派生是纯函数：同一 `scenario` + `seed_text` 必须得到同一结果，不依赖宿主，可单测；
- 标题失败不构成开窗失败：`window_open` 的 `success` 只由场景是否完整建立决定（FR-2 / §6.1）。

**为什么不能只依赖源标题递增**（防止回退成旧策略的可核验理由）：`fork` 会继承父会话历史，宿主按「首条用户消息」自动命名，同一源派出的两个 branch 窗口会得到完全相同的标题，用户在侧栏无法区分。因此派生必须使用各窗口自己的 `seed_text`，源标题递增只作最后兜底。

---

## 6. 对外接口要求

以下为需求级接口。Agent JSON 字段使用 snake_case，Host Service TypeScript 字段使用 camelCase。详细设计可调整字段命名，但不得改变双场景及授权语义。

### 6.1 `window_open`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `scenario` | `'continuation' \| 'branch'` | 是 | 续接当前任务或执行分叉任务；决定是否有 run 与回调 |
| `mode` | `'fork' \| 'create'` | 否 | continuation 默认 create；branch 默认 fork |
| `at_seq` | `number` | 否 | 仅 fork，切点事件序号（含） |
| `title` | `string` | 否 | 新会话标题；显式值优先。缺省按 FR-20 的顺序判定：显式 title > 任务派生 > 源标题递增 > `skipped` |
| `seed_text` | `string` | 是 | continuation 为断点底稿；branch 为独立任务包与完成要求 |
| `topic_id` | `string` | 否 | 多窗口协作时必填；同一项目任务必须共用，缺席则不启用主题跟踪 |
| `output_schema` | `object` | 否 | 结构化结果契约；object 根、允许的 JSON Schema 子集 |
| `result_required` | `boolean` | 否 | 默认 false；true 时 completed 必须带通过校验的 structured |

关键返回字段：

```ts
{
  success: boolean                 //  requested scenario 是否完整建立，不只是会话是否创建
  scenario: 'continuation' | 'branch'
  callback_policy: 'none' | 'required'
  window_key?: string              //  会话已创建时即使后续失败也要返回
  parent_session_id?: string
  mode: 'fork' | 'create'
  run_id?: string                  //  仅 branch
  topic_tracking: boolean          //  是否已加入项目主题台账
  topic_id?: string
  topic_revision?: number          //  开窗口时读取的主题版本
  callback_armed: boolean          //  continuation 恒 false；branch 成功时恒 true
  delivery?: { delivered: boolean; kind: string; reason?: string; run_error?: string; topic_note?: string }
  inheritance: { title: string; preset: string; model: string; reasons: string[] }
  degraded_note: string
}
```

判定规则：

- continuation 成功 = 会话已创建且断点底稿已投递；`callback_armed=false` 是正常结果，不是失败；
- branch 成功 = 会话已创建、run 已持久化且分支底稿已投递；三者缺一则 `success:false`，同时如实返回已发生的部分结果；
- 提供 `topic_id` 时，成功还要求参与者与开跑 revision 已写入；主题写入失败不得静默降级成 `topic_tracking=false`；
- `inheritance.title` 按 FR-20 报 `set/skipped/failed`；`title=skipped|failed` 只说明标题这一步的结果，不改变 `success` 判定；
- branch 不允许通过参数关闭 callback。

### 6.2 `window_complete`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `run_id` | `string` | 条件必填 | 当前 child 有多个活动 branch run 时必填 |
| `status` | `'completed' \| 'failed' \| 'cancelled'` | 是 | 对分支实际结果的声明，不是回合状态 |
| `content` | `string` | 是 | 非空结果；failed/cancelled 应包含真实原因和已有产出 |
| `structured` | `object` | 条件必填 | run 声明 `output_schema` 且 status='completed' 时必填；必须通过 schema 校验 |
| `base_revision` | `number` | 条件必填 | run 绑定 topic 时必填；必须等于完成前最新主题 revision |

返回：完成是否已记录、`run_id`、结果状态以及 `callback { status, delivered?, reason? }`；绑定 topic 时还返回 `completion_entry_id` 和写入后的 `topic_revision`。回调失败不能把“完成已记录”伪报为未记录。

### 6.3 `window_status`

入参 `{ run_id: string }`，仅查询 branch run，至少返回：

```ts
{
  run_id: string
  scenario: 'branch'
  topic_id?: string
  started_topic_revision?: number
  origin_session_id: string
  child_session_id: string
  run_status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'seed_failed' | 'orphaned'
  created_by: 'open' | 'dispatch'
  result?: {
    status: 'completed' | 'failed' | 'cancelled'
    content: string
    structured?: object
    completed_at: number
    completion_entry_id?: string
  }
  output_schema?: object
  lifecycle?: { state: 'active' | 'stopped' | 'orphaned' | 'drained'; reason?: string; at: number }
  last_activity_at: number
  callback: {
    status: 'not_armed' | 'not_requested' | 'pending' | 'delivered' | 'failed' | 'unknown'
    callback_id: string
    attempts: number
    reason?: string
    delivered_at?: number
  }
  created_at: number
  updated_at: number
}
```

### 6.4 `window_retry_callback`

入参 `{ run_id: string }`。仅 origin 或有权限的 Host 调用方可重试；child 不能借重试向其他窗口发消息。返回重试后的 callback 状态和原因。

### 6.5 Host Service

`dsh-window` 至少提供与工具同用例的 Host Service：

- `open(...)`：调用方必须明确 scenario，供宿主流程复用；
- `complete(...)`：按 branch `run_id` 完成，供能确定业务完成的插件使用；
- `get(...)` / `retryCallback(...)`：查询和恢复；
- `list(...)` / `inspect(...)` / `dispatch(...)` / `send(...)` / `interrupt(...)` / `wait(...)`：与对应工具同用例，供宿主做运行时调度；
- `topicCreate/join/get/append/claim(...)`：与主题工具同用例，供调用方把稳定业务 ID 映射为 topic，并同步协作摘要；
- 生命周期对账 `reconcile(...)`：宿主启动/归档时恢复 run、处理 orphan 与未完成 callback；
- 自署消息投递可复用内部 messenger，但不得暴露成允许模型任意投递的工具。

### 6.6 `window_topic_create`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `topic_id` | `string` | 否 | 指定稳定业务 ID；缺省由插件生成。调用方可传稳定业务 ID 的命名空间形式 |
| `title` | `string` | 是 | 项目主题名称 |
| `objective` | `string` | 是 | 共同目标与完成边界，不能只写空泛标题 |

返回 `project_id`、`topic_id`、`revision`、创建者与参与者。相同 ID 的重复创建仅在目标一致时幂等；目标不同返回冲突，不得覆盖原主题。

### 6.7 `window_topic_get`

入参 `{ topic_id?, cursor?, limit? }`：

- 省略 `topic_id`：读取 L0/L1，返回当前项目的 topic 列表、目标、活动 run 指针、未解决冲突数、最近完成时间和明细 entry 指针；活动 run 的实时状态用 `window_list` / `window_status` 读取，不由主题摘要反推；
- 提供 `topic_id`：读取 L2，返回主题目标、参与窗口、有效决策、活动占用、最近 completion、unresolved conflict 及指向 L3 的 entry id；
- `cursor/limit`：只用于继续读取该主题的 L3 明细，默认只返回最近条目，不返回各窗口完整对话。

### 6.8 `window_topic_append`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `topic_id` | `string` | 是 | 目标主题 |
| `kind` | `'progress' \| 'decision' \| 'completion' \| 'conflict' \| 'resolution'` | 是 | 记录类型 |
| `content` | `string` | 是 | 非空摘要或结论，不写完整对话 |
| `base_revision` | `number` | 条件必填 | decision/completion/conflict/resolution 必填，防止基于旧状态写结论 |
| `decision_key` | `string` | 否 | 决策的稳定键；相反结论可用于冲突检测 |
| `artifact_refs` | `string[]` | 否 | 产物路径或 ID，不复制文件内容 |
| `supersedes_entry_id` | `string` | 否 | 本记录替代的旧记录；与 `supersedes_reason` 同时必填 |
| `supersedes_reason` | `string` | 条件必填 | 替代旧决策或旧完成的理由 |
| `conflict_id` | `string` | 条件必填 | `kind='resolution'` 时必填，指定正在解决的冲突 |

返回 `entry_id` 和写入后的 revision；若新结论与有效决策冲突，则同时返回 `candidate_entry_id`、`conflict_id` 和 `effective=false`，该返回不代表冲突已解决。**该工具本身从不触发 origin 回调**；branch 需要回调时必须走 `window_complete`。

### 6.9 `window_topic_claim`

入参 `{ topic_id, scope, action: 'acquire'|'renew'|'release', base_revision?, run_id?, lease_ms? }`：

- `base_revision` 仅 acquire 必填；renew/release 只更新当前窗口自己的占用，不接受以旧快照覆盖他人占用；
- `scope` 是任务、模块或文件范围的稳定字符串；acquire/renew/release 只能操作当前窗口自己的占用；
- 返回 `scope`、`owner_window_key`、`expires_at` 和当前 revision；
- acquire 冲突返回现有占用者的公开摘要，不泄露其私有对话；release/renew 不存在的占用返回明确错误；
- `lease_ms` 受插件配置上下限约束，不能只传永久占用。

### 6.10 `window_topic_join`

入参 `{ topic_id, scenario?: 'continuation'|'branch' }`：

- 只允许当前窗口把自己加入主题；不得代其他窗口加入或修改其角色；
- 成功后返回当前窗口 participant 记录及一份 `window_topic_get` 同构快照，供后续 `base_revision` 使用；
- 重复加入仅在同一 scenario 下幂等；以另一 scenario 参与时新增 participation，不能覆盖或改写首次参与记录；
- `window_open` 的 origin/child 参与登记必须复用本用例，不能另写一套加入规则。

### 6.11 `window_list`

入参 `{ status?: 'active'|'terminal'|'all', topic_id?: string, cursor?: string, limit?: number, time_window?: { from?: number; to?: number } }`。

> 工具面把 `time_window` 扁平暴露为顶层 `from` / `to`（毫秒，含边界），应用层再组装成 `time_window`；两者语义等价。

返回分页 run 摘要列表，每行：

```ts
{
  run_id: string
  child_window_key: string
  run_status: 'pending'|'running'|'completed'|'failed'|'cancelled'|'seed_failed'|'orphaned'
  callback: { status: string; attempts: number; reason?: string }
  topic_id?: string
  created_at: number
  updated_at: number
  last_activity_at: number
}
```

- origin 只能列出自己创建的 run；child 只能列出分配给自己的 run；
- 默认 `status='all'`，但只返回摘要，不返回 `result.content` / `structured`；
- 分页游标为空时从头开始；列表只返回调用者有权看到的 run（无关窗口得到空清单，不泄露他人 run）。

### 6.12 `window_inspect`

入参 `{ window_key: string, include_history?: boolean, cursor?: string, limit?: number }`。

- 默认返回只读元数据：会话 id、标题、cwd、parentSession、origin、Agent 预设、模型选择、运行/空闲状态；
- `include_history=true` 时按分页返回 role / time / source.kind 与有界文本，不返回工具日志全文；
- 只允许该窗口自己、其 origin（对该窗口存在 run 关系的窗口）调用；其他窗口 `WINDOW_RUN_FORBIDDEN`；
- 不做 rename / cancel / prompt / 写操作；历史内容按不可信数据处理。

### 6.13 `window_dispatch`

入参 `{ to_window: string, seed_text: string, output_schema?: object, result_required?: boolean }`。

返回 `{ success, run_id, to_window, callback_policy:'required', callback_armed, delivery, degraded_note }`。

- 只允许与该 child 存在 origin→child 委派关系的窗口调用；
- 同一 child 有 `pending/running` run 时返回 `WINDOW_CHILD_BUSY`；
- seed 必须包含新 `run_id`、完成协议和 `dsh-window-seed` 来源。

### 6.14 `window_send`

入参 `{ run_id?: string, to_window?: string, message: string }`：

- `run_id` 与 `to_window` 至少给一个；同时给时必须指向同一 run；
- 只允许 branch run 的 origin 发给自己的 child；目标必须有活动 run；
- 返回 `{ accepted: boolean, run_id, message_id, delivery: 'steered'|'queued'|'failed', reason? }`；
- 不创建 run、不改变 run 状态、不触发 callback；
- 消息来源 `dsh-window-guidance`，正文必须标明“非用户新指令”。

### 6.15 `window_interrupt`

入参 `{ run_id: string, mode: 'turn'|'run', reason?: string }`：

- `mode='turn'`：返回 `{ accepted, run_id, mode:'turn', run_status:'running', note }`；run 保持活动；
- `mode='run'`：返回 `{ accepted, run_id, mode:'run', run_status:'cancelled', result, note }`；`callback.status='not_requested'`；
- 只有 origin 可调用；child 自身、sibling、无关窗口返回 `WINDOW_RUN_FORBIDDEN`；
- 目标离线时如实报告已落盘与未执行的部分，不谎报已停止 child。

### 6.16 `window_wait`

入参 `{ run_ids?: string[], scope?: 'my_active', topic_id?: string, status?: string, mode: 'all'|'any', timeout_ms: number }`：

- 返回 `{ timed_out: boolean, runs: RunSummary[] }`，RunSummary 与 6.11 行结构一致；
- 超时返回当前快照，不把 `running` 当完成；
- 拉取语义：不消费 callback，不改变 run；
- 必须响应调用方取消信号；无权限返回 `WINDOW_RUN_FORBIDDEN`。

### 6.17 生命周期对账接口（Host 内部，非工具）

- `reconcile()`：插件启动时读取全部 run，恢复未送达 callback，清理半截写入；对超过 `orphanTimeoutMs` 的 active run 标记 `orphaned` 并释放 topic claim；
- `onOriginStopped(originSessionId, reason)`：origin 归档/停止时，对其 active branch run 执行 stop/orphan，尽力取消 child，并写控制记录；
- `drain()`：插件卸载时等待已接受的控制操作落盘；不得把未完成对账静默丢掉；
- 对账只改变 run/callback/lifecycle 状态，不伪造 `result.status='completed'`。

### 6.18 Host Service（供其他插件注入，非工具）

按 §6.5，`dsh-window` 必须暴露可注入的 Host Service，服务名 `window`：

```ts
ctx.provide('window', {
  open(request, exec),                 // 与 window_open 同用例；入参/出参 camelCase
  complete(input, exec),               // window_complete
  get(runId, exec), retryCallback(runId, exec),
  list(input, exec), inspect(input, exec), dispatch(input, exec),
  send(input, exec), interrupt(input, exec), wait(input, exec),
  topicCreate/join/get/append/claim(input, exec),
  reconcile(),                         // §6.17 启动/归档对账
  stopForOrigin(originId, why, exec),  // B5 stopActiveRunsForOrigin；见下方身份约束
})
```

- `open(request)` 字段：`scenario`（必填）/ `mode` / `atSeq` / `title` / `seedText`（必填）/ `topicId` / `outputSchema` / `resultRequired`；
- `open` 返回：`success` / `scenario` / `callbackPolicy` / `sessionCreated` / `windowKey?` / `parentSessionId?` / `mode` / `runId?` / `topicTracking` / `topicId?` / `topicRevision?` / `callbackArmed` / `delivery?`（`delivered/kind/reason/run_error/topic_note`）/ `inheritance` / `degradedNote`；
- 校验失败按 `WindowError` 抛出（带 `code`），调用方按其错误码适配层处理；缺 `exec` 时由 `resolveWindowKey` 响亮拒绝，不伪造调用者身份；
- `stopForOrigin` 返回 `{ affected: string[]; failures: { runId, reason }[] }`；**它不是无门槛写入口**：传 `exec` 时调用者必须就是该 origin；不传 `exec`（宿主生命周期/对账路径）时**必须能证明 origin 已离线**——`isWindowAlive` 未装配、抛错、返回 true 或无法判定一律拒绝（fail-closed，`WINDOW_RUN_FORBIDDEN`）；`reason` 必填且 ≤500 字符；
- `reconcile()` 与包导出的生命周期原语是**宿主特权入口**（不接 exec）：只应由宿主对账/生命周期钩子调用，业务插件不应代调（要停某 origin 的 run 请走 `window_interrupt`）；
- 服务未提供或 `provide` 不可用时，调用方必须走「未装配」结构化降级，不得伪造成功。

---

## 7. 数据与状态要求

### 7.1 branch run 最小记录

| 字段 | 要求 |
|---|---|
| `schemaVersion` | 初始为 1；后续迁移不得静默误读旧记录 |
| `runId` | 插件生成，唯一且不可由模型指定 |
| `scenario` | 固定为 `branch`，防止旧记录被误作 continuation |
| `createdBy` | `open`（新建会话）或 `dispatch`（复用已有 child） |
| `originSessionId` | 创建时从调用上下文固定，之后不可修改 |
| `childSessionId` | 宿主真实返回或 dispatch 指定的会话 ID |
| `mode/title` | open 的参数快照；dispatch 保留原会话信息 |
| `topicId/startedTopicRevision` | 可选；启用主题协作时记录关联主题和开跑版本 |
| `claimScopes` | 可选；本 run 持有的协作范围，完成/停止时据此释放 |
| `seedMessageId` | seed 投递后记录，便于对账 |
| `outputSchema/resultRequired` | 可选；结构化结果契约 |
| `runStatus` | pending/running/completed/failed/cancelled/seed_failed/orphaned |
| `result` | 状态、非空内容、可选 structured、完成者、完成时间、completionId；首次成功写入为权威版本 |
| `callback` | callbackId、状态、attempts、reason、deliveredAt；与 runStatus 分离；状态含 not_armed/not_requested/pending/delivered/failed/unknown |
| `lifecycle` | active/stopped/orphaned/drained、原因与时间；与 result/callback 分离 |
| `lastActivityAt` | 最近 seed/guidance/控制操作或状态变化时间；供 window_list 排序与 orphan 判定。**不随每个回合刷新**，故不可用作“任务是否停滞”的判据 |
| `controlEvents` | append-only：send / interrupt-turn / interrupt-run / stop / orphan / drain 的 actor、原因、时间与结果 |
| `createdAt/updatedAt` | 持久化审计时间 |

### 7.2 状态不变量

1. 同一次开窗中 `originSessionId !== childSessionId`。
2. continuation 永远没有 branch run、run_id 或结果回调。
3. branch 必须持久化 run 后才能投递带 run_id 的 seed；seed 未送达时 callback=`not_armed`，不得接受完成上报。
4. seed 送达后 run 才进入活动状态，callback=`pending` 并允许首次完成。
5. 有 `result` 时 branch run 必须处于 `completed/failed/cancelled` 之一。
6. `callback.status='delivered'` 前必须已有结果，不得只有“送达”而没有完成内容。
7. 不同内容的后续完成不得覆盖首次结果。
8. 普通 `turn/end`、Agent idle、Agent disposed 均不得单独把 run 改为 completed。
9. callback delivered 不代表用户已读、结果正确、主任务完成或外部业务插件已验收。
10. topic revision 只能递增，历史 entry 不可编辑或删除；替代关系必须通过新 entry 表达。
11. 绑定 topic 的 branch 首次完成必须让 run result 与 completion entry 指向同一 completionId；两份存储**无共享事务**，一致性靠"确定性 completionId + 按 ID 幂等且校验归属/内容"收敛，不允许出现无同一 completionId 关联的半截写入（崩溃窗口由重试收敛，见 §7.2 FR-6 口径）。
12. 同一 topic/scope 同时最多一个未过期 active claim；过期与释放必须保留历史。
13. `window_topic_append` 只改变台账，不改变 run 状态，也绝不单独触发 origin 回调。
14. candidate 不是有效决策；相关 conflict 未 resolution 前不得完成受影响范围，已保存的 candidate 与 conflict 不得因拒绝完成而删除。
15. L1/L2 汇总必须由 L3 明细可重建；汇总与明细不一致时以明细为准并重建，不得把陈旧汇总当权威事实。
16. `originSessionId` 与 `childSessionId` 一旦创建不可改写；send/interrupt/list/wait 的授权都以这对关系为准。
17. `window_list` / `window_inspect` 只能返回调用者有权看的内容；child 不能借 list 枚举其他 origin 的 run。
18. `window_send` 不创建 run、不改变 runStatus、不更新 callback、不构成完成；它只记录一次 guidance 尝试。
19. `window_interrupt(mode='turn')` 后 run 保持 running；`mode='run'` 后 runStatus=cancelled 且 callback=not_requested，不得再回调 origin。
20. 声明 `outputSchema` 且 `resultRequired=true` 的 run，`completed` 必须带通过校验的 `structured`；否则不得写 result、不得回调。
21. stop/orphan/drain 只写 lifecycle 与控制记录；未完成 run 不得伪造成 completed，也不得写虚假 callback。
22. Topic Ledger 的 activeRuns 只是 run 指针；运行时状态以 run store 为准，不能由主题摘要反推 run 终态。
23. continuation 没有 branch run，也没有运行时所有权；不得对 continuation child 调用 send/interrupt/list 的 branch 控制路径。

### 7.3 topic 最小记录

以下记录都是**持久化数据**，不是内存状态；`revision`、active claim 和 unresolved conflict 的恢复结果必须与崩溃前一致。

| 记录 | 必备字段 | 说明 |
|---|---|---|
| `GlobalIndex` | `schemaVersion/projects[]/updatedAt` | L0；只保存项目与 topic 指针、计数和时间，不保存完成正文 |
| `ProjectSummary` | `projectId/projectHash/topics[]/activeRuns/unresolvedCount/lastCompletionAt/updatedAt` | L1；一个项目的有界摘要与 L2 指针 |
| `ProjectTopic` | `projectId/topicId/title/objective/revision/createdBy/createdAt/updatedAt` | L2 身份卡；一个项目可有多个主题，同一主题由多个窗口协作 |
| `TopicSummary` | `topicId/topicHash/revision/participants/effectiveDecisions/activeClaims/lastCompletions/unresolvedConflicts` | L2 汇总投影；由 L3 明细重建，只保留有界结论与 entry 指针 |
| `TopicParticipant` | `participationId/topicId/windowKey/scenario/role/status/joinedAt/lastSeenAt` | 记录哪些窗口以何种场景参与；status 区分 active/pending/seed_failed/left；role 不复制外部业务插件的 owner 授权 |
| `TopicEntry` | `entryId/topicId/revision/windowKey/kind/content/baseRevision/createdAt` | append-only；可选 runId、completionId、decisionKey、artifactRefs、supersedesEntryId、effective/conflictId |
| `TopicClaim` | `topicId/scope/ownerWindowKey/runId/claimedAt/expiresAt/releasedAt?` | 当前占用与历史分开投影，过期不等于从未发生 |
| `TopicConflict` | `conflictId/topicId/entryIds/status/createdAt/resolvedAt?/resolutionEntryId?` | unresolved 必须可见；resolution 不能删除冲突事实 |

### 7.4 存储路径与命名设计

#### 物理根目录

- Topic Ledger 使用一个固定的插件根：`dshHomePath('storages', 'dsh-window')`，默认展开为 `~/.dsh/storages/dsh-window`；设置 `DSH_HOME` 时对应为 `$DSH_HOME/storages/dsh-window`。
- 根目录和目录权限由插件创建并限制为仅当前用户可读写（目录 `0700`、记录文件 `0600`）；临时文件只能出现在根内隐藏目录，不能写到 `/tmp` 后丢失归属。
- 不把 Topic 数据写到项目仓库下的 `.dsh/`、`.dsh-window/` 或当前 cwd：协作元数据不是交付物，不能误进 Git，也不能因同一项目有多个 checkout 而分裂。真正的代码、文档和报告仍留在项目工作区，Topic 只保存它们的引用。
- profile 隔离由 `DSH_HOME` 的部署方式决定；多个 profile 共享同一 `DSH_HOME` 时也会共享该插件根，业务隔离必须依靠目录与记录中的 `projectId`，不能假装路径天然按 profile 隔离。
- 如果后续改用 SQLite，物理文件可变为 `$DSH_HOME/storages/dsh-window/ledger.db`，但下面的逻辑层级、ID 和读取顺序必须保持等价。

#### 金字塔层次（唯一逻辑结构）

Topic Ledger 必须按信息密度分四层，不能只保留平铺明细：

| 层 | 记录 | 内容 | 默认读取 |
|---|---|---|---|
| L0 全局索引 | `index.json` | 当前 DSH_HOME 下有哪些项目、每个项目的 topic 指针与最近活动时间 | 找项目/找 topic |
| L1 项目摘要 | `projects/<projectHash>/project.json` | 一个项目下各 topic 的目标、参与窗口数、活动 run、未解决冲突数、最近完成时间和指向 L2/L3 的路径 | 了解项目全貌 |
| L2 主题摘要 | `projects/<projectHash>/topics/<topicHash>/topic.json` + `summary.json` | topic 目标、参与者、有效决策、活动 claim、最近 completion、unresolved conflict 和指向明细的路径 | 多窗口协作默认视图 |
| L3 明细事实 | `participants/`、`entries/`、`claims/`、`conflicts/` | append-only 参与、进度、决策、完成、占用、冲突和 resolution 全量历史 | 只在核对证据时按需分页读取 |

读取顺序必须是 **L0 → L1 → L2 → L3**：Agent 先读小索引，再按需要读项目摘要和主题摘要，最后只为明确核对的条目读取明细；不得默认把全部 entry 装进上下文。

L1/L2 是由 L3 append-only 事实派生的**有界汇总投影**，不是第二份业务真相；汇总只保留结论、计数和 entry/artifact 指针，不复制完整历史。写明细时必须同事务或用恢复日志更新相关汇总；发现汇总与明细不一致时，以明细为准并重建汇总，不能静默相信陈旧摘要。

#### 推荐目录结构

P0 使用一个插件根目录承载完整金字塔，不再把 topic 表平铺到 storage 根：

```text
$DSH_HOME/storages/dsh-window/             # 插件唯一数据根；默认 ~/.dsh/storages/dsh-window
├── manifest.json                          # schemaVersion、storageVersion、创建/升级时间
├── index.json                             # L0：项目索引、topic 指针、runId → topic 路径
├── runs/                                  # 跨主题分支 run（window_status/retry/list 的规范位置）
│   ├── index.json                         # RunListIndex 可重建投影：origin/child/status/lastActivity
│   └── <runId>/
│       ├── run.json                       # 规范记录：origin/child/status/result/outputSchema/callback/lifecycle
│       ├── control.jsonl                  # RunControlEvent append-only（send/interrupt/stop/orphan/drain）
│       └── messages.jsonl                 # RunMessage append-only（guidance：messageId/sender/target/digest）
├── audit.jsonl                            # 只读访问留痕（window_inspect：actor/target/includeHistory/at）
├── projects/
│   └── <projectHash>/                     # L1：一个项目一层
│       ├── project.json                   # 项目摘要：topic 列表、活动 run、冲突数、最近完成时间
│       └── topics/
│           └── <topicHash>/               # L2：一个主题一层
│               ├── topic.json             # projectId、topicId、title、objective、revision
│               ├── summary.json           # 由 L3 重建的有界汇总：参与者/有效决策/活动 claim/最近完成
│               ├── participants/
│               │   └── <participantHash>.json
│               ├── entries/
│               │   └── e_<revision>_<entryId>.json
│               ├── claims/
│               │   └── <scopeHash>/
│               │       ├── active.json    # 当前占用投影（可重建）
│               │       └── history/
│               │           └── <claimEventId>.json
│               └── conflicts/
│                   └── <conflictId>/
│                       ├── conflict.json
│                       └── resolutions/
│                           └── <entryId>.json
└── _journal/                              # 隐藏恢复区，不给 Agent 读取
    └── <transactionId>.json               # 跨文件写入的单一事务事实
```

这个结构同时满足两条约束：

- **金字塔清晰**：`index.json → projects/<project>/project.json → topics/<topic>/summary.json → entries|claims|conflicts`；
- **根目录不脏**：所有文件都在 `storages/dsh-window/` 内，projects/topics 只出现在 `projects/` 子树，不会污染 storage 根或项目仓库。

`entries/` 是 append-only 明细事实；`project.json`、`summary.json`、claim `active.json` 和 `index.json` 都是可重建投影，不是第二份真相。跨 run、entry、summary 的多文件更新必须先写 `_journal/<transactionId>.json` 这一份原子事务记录，再应用各文件；启动时按 journal 恢复或重建，不能接受不可恢复的半截状态。

#### key 与文件命名

- `projectHash = sha256(normalizedProjectId)`；`topicHash = sha256(normalizedProjectId + '\0' + topicId)`，均取安全长度的小写十六进制前缀；记录中同时保存原始 ID 并校验，防止哈希碰撞被误认为同一项目或主题。
- 原始 workspace 路径、外部业务 ID、窗口 id、scope 文本都**不直接作为路径段**；participant、claim scope 等目录名同样使用确定性安全 hash，避免路径穿越、非法字符和过长路径。
- `entry` 文件名使用 `e_<补零 revision>_<entryId>.json`；因为所在路径已经包含 topicHash，文件名不再重复 topicHash。补零 revision 保证字典序与写入顺序一致，重复写入必须先通过 revision CAS。
- `runId`、`participantHash`、`scopeHash`、`conflictId`、`claimEventId` 由插件生成或派生并限制为路径安全字符；模型只能拿到 ID，不能指定物理路径。
- `runs/index.json` 是 RunListIndex 投影，可从各 `runs/<runId>/run.json` 重建；`control.jsonl` 只追加控制事件，不写模型完整正文。
- 每个 JSON 文件通过同目录隐藏临时文件 + fsync + rename 原子发布；`_journal/` 只保存恢复所需的跨文件事务，不是模型可读的协作内容。
- `manifest.json` 的 `storageVersion` 是目录结构版本；版本不兼容时必须响亮拒绝或执行显式迁移，不能按新结构误读旧目录。

### 7.5 运行时控制记录

| 记录 | 必备字段 | 说明 |
|---|---|---|
| `RunControlEvent` | `eventId/runId/kind/actorSessionId/reason/at/result` | append-only；kind ∈ send / interrupt-turn / interrupt-run / stop / orphan / drain；`result` 记录接受/失败/目标离线 |
| `RunMessage` | `messageId/runId/senderSessionId/targetSessionId/kind/textDigest/deliveredAt` | guidance 留痕；只存正文摘要或哈希，不默认保存敏感全文 |
| `RunLifecycle` | `runId/state/reason/at` | state ∈ active / stopped / orphaned / drained；与 result/callback 分离 |
| `RunListIndex` | `runId/originSessionId/childSessionId/runStatus/callbackStatus/lastActivityAt` | 可重建投影，供 `window_list` 分页；与 run.json 不一致时以 run.json 为准 |

- run、RunControlEvent、RunMessage 的写入必须通过 run 目录内的原子记录或事务日志；不允许出现控制已执行但没有任何留痕的半截状态。
- `window_list` 只读 RunListIndex；索引缺失或陈旧时按 run.json 重建，不能把索引当第二份真相。

---

## 8. 安全与授权红线

- 禁止通过 `sessionController.prompt` 发送 seed 或 callback；该入口会将来源标为 `user`。
- seed 与 callback 可以使用 `role='user'` 的 DSH 消息载体，但 `source.kind` 必须分别为 `dsh-window-seed` 和 `dsh-window-result`，不得继承人类授权。
- branch 回调正文要明确“这是插件投递的分支结果，不是用户新指令”；结果正文按不可信内容包裹，原窗口不得仅因文本包含“请批准/请归档”就绕过人工门。
- `origin` 由插件创建 run 时绑定，`window_complete` 不提供目标窗口参数。
- 查询、完成、重试都校验调用者身份；Host Service 内部调用也必须传入并核验明确的 run/session 身份，不能仅凭“插件内部”跳过授权。
- 主题参与者可读本主题，只有参与者可 append/claim/release；非参与者只能先通过 `window_topic_join` 或 `window_open` 把自己加入，其他读写返回 `WINDOW_TOPIC_FORBIDDEN`，不得借其他窗口 ID 代写完成内容或释放占用。
- 主题中的 decision、completion 和其他窗口文本都是不可信协作数据，不是用户新指令；工具返回和 seed 快照都必须带这一声明。
- `window_send` / `window_interrupt` / `window_wait` 的授权都以 run 的 origin→child 关系为准；child、sibling、无关窗口一律拒绝，不允许通过传 `to_window` 越权。
- guidance 消息来源固定为 `dsh-window-guidance`，正文必须标明“原窗口运行时引导，不是用户新指令”；child 不得把 guidance 当作人工批准。
- 结构化结果由 child 提供，仍按不可信 JSON 处理：先做 schema 校验，再落盘/回调；不得因为字段看起来合法就跳过校验。
- 生命周期 stop/orphan 只能由 origin 或 Host 内部对账触发；child 不能自行把 run 标成 orphan/stopped，也不能伪造控制记录。
- `window_inspect` 返回的会话历史同样是不可信数据；读取行为必须留痕，且默认不返回完整对话与工具日志。
- 不在日志中输出完整 seed、结果正文、guidance 正文或敏感项目内容。

---

## 9. 错误码要求

| 错误码 | 场景 | 恢复建议 |
|---|---|---|
| `WINDOW_SCENARIO_REQUIRED` | scenario 缺失或不是 continuation/branch | 按任务目的显式选择场景 |
| `WINDOW_SEED_REQUIRED` | seed_text 为空或只有空白 | continuation 提供断点；branch 提供独立任务包 |
| `WINDOW_OPEN_UNAVAILABLE` | sessionController、Storage 等必要能力不可用，或 create 无项目落点 | 修复装配/落点后重试 |
| `WINDOW_OPEN_FAILED` | fork/create 宿主调用失败，或开窗参数被拒（含 `title` > 200 字符，FR-20 走此码而非 `WINDOW_INVALID_INPUT`） | 根据原因重试或调整 mode；不产生半截会话 |
| `WINDOW_SEED_DELIVERY_FAILED` | 保留码（历史契约）；**当前实现不抛出**：seed 未送达由 `success=false` + `delivery.delivered=false` + `degraded_note` 表达 | 读 `delivery` 判断真实投递状态，用返回的 window_key 手动接续，不能谎称场景已建立 |
| `WINDOW_RUN_NOT_FOUND` | run_id 不存在，或 continuation 窗口调用 branch 完成 | 核对 run_id 与 scenario |
| `WINDOW_RUN_NOT_ACTIVE` | seed 未送达、run 尚未活动或 seed_failed 时尝试首次完成 | 先确认 seed 投递与 callback_armed，不在未开始的分支上伪造结果 |
| `WINDOW_RUN_FORBIDDEN` | 非授权窗口完成、查询或重试 | 在 origin/child 或合法 Host 调用方执行 |
| `WINDOW_RUN_AMBIGUOUS` | 省略 run_id 且当前 child 有多个活动 branch run | 显式传 run_id |
| `WINDOW_RUN_ALREADY_SETTLED` | 以不同结果重复完成 | 用 window_status 查看首次结果 |
| `WINDOW_RESULT_EMPTY` | content 为空或只有空白 | 提供真实结果或失败原因 |
| `WINDOW_CALLBACK_FAILED` | 原窗口恢复/投递/落盘失败 | 结果仍已保存，修复后 retry |
| `WINDOW_TOPIC_NOT_FOUND` | topic_id 不存在或不属于当前项目 | 先创建主题或核对项目与 topic_id |
| `WINDOW_TOPIC_STORAGE_UNAVAILABLE` | Topic Ledger 所需持久化存储不可用 | 修复存储后重试；不得用内存临时台账冒充已共享 |
| `WINDOW_TOPIC_FORBIDDEN` | 非参与者读写、代写或释放他人占用 | 加入主题后再操作，且只能操作本窗口记录 |
| `WINDOW_TOPIC_REVISION_REQUIRED` | decision/completion/conflict/resolution 或 acquire claim 缺少 base_revision | 先读取当前 revision 并显式携带 |
| `WINDOW_TOPIC_STALE` | base_revision 已过期 | 读取新记录，解决差异后用新 revision 重试 |
| `WINDOW_TOPIC_CLAIM_CONFLICT` | 同一 scope 已有未过期占用 | 查看占用者，选择其他范围或协商后接管过期占用 |
| `WINDOW_TOPIC_CONFLICT` | 同 ID 主题目标不一致，或存在相关 unresolved conflict 时仍尝试完成 | 不覆盖原记录；先读取 candidate/conflict，追加合法 resolution 后重试 |
| `WINDOW_CHILD_BUSY` | 目标 child 已有 pending/running run，又调用 dispatch | 等当前 run 终态后再 dispatch，或用 window_send 做运行中引导 |
| `WINDOW_SEND_FAILED` | guidance 未获得目标接受（离线、无 followup/steer 能力、投递异常） | 根据原因重试；不得把失败说成已排队 |
| `WINDOW_INTERRUPT_FAILED` | 中断请求未被接受（越权、无 child 句柄、宿主播错） | 如实报告哪一半已做；run 状态不得被伪造成终态 |
| `WINDOW_WAIT_UNAVAILABLE` | wait 的目标集合为空或无法解析 | 先用 window_list 确认 run_id，再等待 |
| `WINDOW_OUTPUT_SCHEMA_INVALID` | 传入的 output_schema 不属于允许的 object JSON Schema 子集 | 修正 schema 后重新 open/dispatch |
| `WINDOW_STRUCTURED_RESULT_REQUIRED` | run 声明了 output_schema，completed 时未提供 structured | 提供通过校验的 structured 后重试 |
| `WINDOW_STRUCTURED_RESULT_INVALID` | structured 不符合已声明的 output_schema | 修正结果后重试；不影响已有 content |
| `WINDOW_CALLBACK_NOT_REQUESTED` | 对 origin 主动取消（callback=not_requested）的 run 调 retry | 按语义不再投递；不要试图补发已取消的回调 |
| `WINDOW_CALLBACK_UNKNOWN` | 回调状态未知（投递后状态落盘失败） | 先人工对账同一 callbackId 是否已送达，再决定是否重试，不得盲目重发 |
| `WINDOW_RUN_STORE_UNAVAILABLE` | 运行记录存储不可用（含 list/reconcile/wait 依赖的存储失败） | 修复存储后重试；不得把失败当成"没有 run" |
| `WINDOW_CONFIG_INVALID` | 插件配置非法（orphanTimeoutMs / waitPollMs / leaseMin/leaseMax 等，或上下限倒挂） | 装配期即失败；修正配置后重启插件 |
| `WINDOW_INVALID_INPUT` | 输入参数非法（cursor、limit、lease_ms、status、claim scope 等） | 按提示修正参数；不得用默认值静默兜底 |
| `WINDOW_TOPIC_PROJECT_REQUIRED` | 拿不到当前窗口的项目身份（workspaceId 与 cwd 都不可得） | 在带项目身份的窗口调用，或先声明 workspaceId |
| `WINDOW_TOPIC_CLAIM_NOT_FOUND` | renew/release 的占用不存在或不属于当前窗口 | 先 window_topic_get 确认占用归属与是否已过期 |

> 生命周期（stop/orphan/drain/reconcile）的存储失败复用 `WINDOW_RUN_STORE_UNAVAILABLE`；
> topic 存储根/manifest 层面的失败统一为 `WINDOW_TOPIC_STORAGE_UNAVAILABLE`（不再透出裸 Error）。

本插件自身不使用任何外部业务前缀（如 `REQBOARD_*`）；错误码一律为 `WINDOW_*`。

---

## 10. 依赖方向

```text
dsh-window ──▶ DSH 公开能力
dsh-window ──X──▶ dsh-pmboard / pm-core / pm-common / tool-pm
```

`dsh-window` 必须能独立安装与独立运行；任何外部插件都只能通过它对外暴露的工具面与 Host Service 可选接入，本插件不感知也不依赖对方。

---

## 11. 验收标准

| 编号 | 场景与操作 | 通过条件 |
|---|---|---|
| AC-1 最终独立安装 | 全部阶段完成后，不安装/不加载任何外部业务插件，只安装 `dsh-window` | `window_open/complete/status/retry_callback/list/inspect/dispatch/send/interrupt/wait` 与 `window_topic_*` 可用；构建和类型检查通过；依赖扫描无外部业务插件包 |
| AC-2 场景与 mode 正交 | 缺 scenario 调用；分别以两种 scenario 搭配 fork/create | 缺 scenario 时零开窗且报 `WINDOW_SCENARIO_REQUIRED`；合法组合按参数执行，不能由 mode 猜错回调策略 |
| AC-3 continuation 不回调 | 以 continuation 开窗续接，随后让新窗口正常结束、归档或尝试 `window_complete` | 无 run_id、`callback_policy=none`、`callback_armed=false`；原窗口收不到结果消息；完成工具返回 `WINDOW_RUN_NOT_FOUND` |
| AC-5 branch 建立 | 以 branch 开窗并读取 run 与 child seed | 返回 run_id 且已持久化；`callback_policy=required`、`callback_armed=true`；seed 含 run_id、完成协议和 `dsh-window-seed` 来源 |
| AC-6 热窗口完成回调 | branch child 调 `window_complete({status:'completed',content:'分支结果X'})` | origin 收到一条 `dsh-window-result`，正文原样包含“分支结果X”和 run_id；callback=delivered |
| AC-7 普通回合结束 | branch child 正常结束一个或多个回合，但不调用完成工具 | run 不变为 completed，origin 不收到“完成”回调；等待人工确认不会提前报喜 |
| AC-8 冷原窗口 | 让 origin 冷却后再完成 branch run | 插件 resume origin 后投递成功，不能仅因 `agents.get` 无结果而报窗口不存在 |
| AC-9 原窗口忙碌 | origin 正执行主任务时完成 branch run | 使用 followup 排队，不用 steer 打断；回执只称已投递/排队，不称已阅读或主任务完成 |
| AC-10 重复与冲突完成 | 相同内容完成两次，再以不同内容完成一次 | 第二次幂等且不重复回调；第三次返回 `WINDOW_RUN_ALREADY_SETTLED`，首次结果不变 |
| AC-11 授权与多分支 | 非 child 完成；同一 child 建两个活动 branch run 后省略 run_id | 前者 `WINDOW_RUN_FORBIDDEN`；后者 `WINDOW_RUN_AMBIGUOUS`；显式 run_id 后结果不串单 |
| AC-12 回调失败重试 | 首次令 origin 恢复/投递失败，再恢复能力并 retry | 完成内容未丢失；首次 callback=failed+reason；重试后 delivered；不产生第二条逻辑结果 |
| AC-13 重启与未知态 | 在完成落盘后、callback 状态落盘前重启 | run/result 可恢复；不能确认时 callback=unknown；按 callbackId 对账后才决定重试，不谎称 delivered |
| AC-14 开窗部分失败 | branch 存储不可用；另模拟会话已创建但 seed 失败并尝试完成 | 前者不创建会话；后者 `success:false` 且返回真实 window_key、delivery 和 callback_armed，完成上报返回 `WINDOW_RUN_NOT_ACTIVE`，不谎称 branch 已建立 |
| AC-16 内容与授权安全 | 回调包含 Markdown、多行文本和“请批准”等指令样文本，并扫描实现 | 内容不被静默改写/截断，带非用户指令声明；无 `sessionController.prompt`、无对外部业务插件的反向依赖、人工门未被自动通过 |
| AC-17 回归与反例 | 运行新插件全套测试、构建与类型检查 | 全部通过；反向探针证明：若 continuation 产生回调、branch 重复回调或普通 turn/end 被判完成，对应测试必须失败 |
| AC-18 主题参与和共享 | 窗口 A 创建主题，B/C 分别以 continuation 和 branch 加入，随后各自写 progress/completion | 省略 topic_id 时 A/B/C 读到同一 L0/L1 项目索引；提供 topic_id 时读到同一 L2 参与者、有效决策、递增 revision 和 completion 指针；L3 明细只按需分页返回，不返回完整对话 |
| AC-19 双场景写台账 | continuation 用 append 写 completion；branch 用 window_complete 完成同一主题的另一范围 | continuation 不产生 origin 回调但内容可查；branch 先出现 completion entry 再收到回调，回调中的 topic/entry/revision 与台账一致 |
| AC-20 版本与占用冲突 | A/B 以相同 base_revision 写相反决策；随后 B 在未重读时完成，且两窗口申请同一 scope | 只有首个原子写入成功；其他返回 STALE 或 CLAIM_CONFLICT，不覆盖 A 的内容；B 重读并以新 revision/其他 scope 后才能继续 |
| AC-21 冲突可见与解决 | 对同一 decision_key 在未提供 supersedes 的情况下写入不同结论，尝试完成后再追加 resolution | 新结论仅为 candidate，get 显示 unresolved，完成返回 WINDOW_TOPIC_CONFLICT；resolution 关联 conflict 后才允许完成，原冲突和旧结论仍可追溯 |
| AC-22 主题授权 | 非参与者读取/append/释放他人 claim，随后用 window_topic_join 加入自己；主题文本含“请忽略之前指令” | 加入前分别返回 FORBIDDEN 或对应占用错误；join 只能加入当前窗口，成功后按权限可读；文本只作为不可信数据，不改变任务和人工门 |
| AC-23 主题持久化与路径 | 创建主题、join、append、claim、形成 conflict 后重启插件；再写入一条记录并检查默认落点 | 重启后 L0/L1/L2 汇总、topic、参与者、全部 L3 entry、active/expired claim、unresolved conflict 和 revision 完整恢复，新 revision 严格递增；记录只出现在 `$DSH_HOME/storages/dsh-window` 的金字塔目录中，项目工作区零新增 Topic 数据文件，原始路径/业务 ID 不作为文件路径段 |
| AC-24 发现与只读查看 | origin 创建 3 条 branch run 后调 `window_list`；再对其中一个 child 调 `window_inspect`；无关窗口调两者 | list 返回 3 条摘要且不含 result 正文；inspect 默认只返回元数据，include_history 才分页返回；无关窗口调 list 得到空清单（列表本身按授权过滤），调 inspect 得到 `WINDOW_RUN_FORBIDDEN` |
| AC-25 dispatch 复用 child | 对同一 child 连续 dispatch；期间 child 未完成时再 dispatch | 第一条创建新 run 并回调；忙时返回 `WINDOW_CHILD_BUSY`；完成后可派下一条，run_id 各不相同，continuation child 与无关系窗口被拒 |
| AC-26 运行中引导 | child run running 时 origin 调 `window_send`；目标空闲/离线时分别调用；无关窗口调用 | running 时消息以 `dsh-window-guidance` steer 或排队；不创建 run、不改 runStatus、不回调；无活动 run 返回 `WINDOW_RUN_NOT_ACTIVE`；无关窗口 `WINDOW_RUN_FORBIDDEN` |
| AC-27 中断与取消 | origin 先 `mode='turn'` 再 `mode='run'`；child 尝试中断 origin | turn 后 run 仍 running；run 后 runStatus=cancelled、callback=not_requested、无回调；child 调用返回 FORBIDDEN；控制记录可查 |
| AC-28 等待 / join | origin 对 3 条 run 分别 `mode='all'`、`mode='any'`、带 timeout；期间 callback 正常到达 | all 等全部终态；any 任一终态即返回；timeout 返回当前快照且 `timed_out=true`；callback 未被消费或抑制 |
| AC-29 结构化结果 | run 声明 output_schema，completed 时不带 / 带非法 / 带合法 structured | 前两者返回 REQUIRED/INVALID 且不落 result、不回调；合法时落盘并可由 window_status 读回；topic completion entry 只保存 completionId 与摘要，不复制完整 structured |
| AC-30 branch 生命周期 | origin 归档/停止并触发 reconcile；再模拟 origin 超时与插件重启 | active run 进入 stop/orphan，claim 释放，child 尽力取消并留痕；超时 runStatus=orphaned 且 window_list 可见；重启恢复未送达 callback；continuation 与外部业务插件所有权不受影响 |
| AC-31 标题策略 | ① 同一源连续开两个 seed 不同的 branch 窗口；② 再开一个 seed 只有协议行的窗口（源标题为 `源标题 (2)`）；③ 显式传 `title`；④ 让 `rename` 抛错 | ① 标题分别为 `分叉：<各自 seed 首条有效内容>` 且**互不相同**（continuation 对应 `续接：…`）；② 回退为 `源标题 (3)`；③ 使用显式值；④ `inheritance.title='failed'` 且原因可读，会话仍创建、预设与模型照常继承、`success` 判定不受影响 |

> AC-4 / AC-15 原为外部业务插件集成条款，已随本项目独立化移出范围；编号保留不复用，以免影响 AC-18 及之后的既有引用。

---

## 12. 测试要求

1. **场景纯函数测试**：scenario 校验、默认 mode、callback policy、seed 必填和成功/部分成功判定。
2. **continuation 反回调测试**：新窗口完成、archived、idle、turn/end、调用完成工具均不向 origin 投递。
3. **branch 用例测试**：run 状态机、完成授权、幂等冲突、结果保真、错误映射。
4. **Host adapter 测试**：fork/create、workspace 落点、画像继承、热/冷投递、flush 失败和服务迟到装配。
5. **持久化与并发测试**：重启恢复、unknown 对账、同 child 多 run、完成与 retry 并发。
6. **实机验收**：分别完成一次 continuation 和 branch，确认前者只在新窗口收尾，后者在原窗口收到真实完成内容。
7. **主题协作测试**：多窗口共享读取、L0→L1→L2→L3 金字塔读取、汇总投影一致性与重建、持久化重启恢复、存储路径归属、append-only、revision CAS、claim 过期/接管、冲突解决、外部投影不形成第二份状态真相，并用真实并发而不是顺序调用冒充竞争。
8. **运行时调度测试**：window_list 过滤与授权、window_inspect 只读边界、dispatch 忙/复用、send steer/queue、interrupt turn/run、wait all/any/timeout 与取消，并用真实并发验证同一 child 单活动 run。
9. **结构化与生命周期测试**：output_schema 子集校验、structured 必填/非法/合法、topic entry 指针不复制正文、origin 归档 stop、orphan 超时、reconcile 重启恢复、continuation 不被生命周期控制影响。
10. **标题策略测试**（FR-20）：优先级链三级（显式 > 任务派生 > 源标题递增 > skipped）、协议行跳过、列表符剥离、空白折叠、超长截断、半角/全角编号递增、投影读数解包、`rename` 抛错只让 title=failed 而不断其它两步。

---

## 13. 实施计划（工具分批）

实施不按 FR 编号线性推进，而是按**依赖关系 + 风险**分批。每批只交付可独立验收的工具，批间不互相阻塞到能并行的部分。

### 当前状态（2026-10-16 已交付）

| 批次 | 状态 | 证据 |
|---|---|---|
| B0 基础设施 + B1 发现 + B2 控制 + B3 等待 + B4 结构化 + B5 生命周期 | ✅ 已实现 | `window_open/complete/status/retry_callback/dispatch/list/inspect/send/interrupt/wait`；194 个测试，`pnpm typecheck/test/build` 全绿 |
| B6 Topic Ledger | ✅ 已实现 | `window_topic_create/join/get/append/claim` + 分层存储（`index/projects/topics/participants\|entries\|claims\|conflicts/_journal`）+ revision CAS/claim/conflict + open/complete 接入 |
| `window` Host Service（§6.5，供外部插件注入） | ✅ 已提供 | `ctx.provide('window', ...)`，含 open/complete/get/retryCallback/list/inspect/dispatch/send/interrupt/wait/topic*/reconcile/stopForOrigin，见 `src/hostService.ts` |
| 需求条款差距补齐 | ✅ 已实现 | §6.16 wait `status` 过滤、§7.5 `RunMessage`、`RunLifecycle.drained` + drain 留痕、FR-16 status/list 复盘、§8 inspect 访问留痕、§6.12 工具名摘要、§6.9 租约配置上下限 |
| 标题策略（FR-20） | ✅ 已实现 | `deriveTaskTitle` / `increasedWindowTitle` / `applyWindowInheritance`（`src/application/windowInherit.ts`）；三态回报 + 派生/递增/截断规则由 `test/titleInheritance.test.ts` 覆盖 |
| B9 审核修复 | ✅ 已实现 | 见 [ADR-0002](../adr/0002-audit-fixes.md) 与完成清单 B9：topicAppend runId 归属校验、completionId 抢占防护、lifecycle 全锁化、orphan 在线否决、drain 原子写、损坏记录隔离、索引新鲜度、unknown 落盘与 retry 拦截、interrupt-run 生命周期/claim、status 补字段、delivery 分字段、幂等键、stopForOrigin 身份约束 |

当前工具面共 **15 个**：`window_open / window_complete / window_status / window_retry_callback / window_dispatch / window_list / window_inspect / window_send / window_interrupt / window_wait / window_topic_create / window_topic_join / window_topic_get / window_topic_append / window_topic_claim`。

### B0 公共基础设施（先行，半天）

后续多个工具共用的地基，单独一小批，不注册任何新工具：

| 工件 | 服务于 | 内容 |
|---|---|---|
| `RunListIndex`（`runs/index.json`，可重建投影） | `window_list` / `window_wait` | 从各 `run.json` 重建，索引陈旧不阻塞 |
| `lastActivityAt` 写入 | `window_list` / orphan 判定 | 在 open/complete/dispatch/send/interrupt 的每次写 run 时更新 |
| `RunControlEvent`（`control.jsonl` append-only） | `window_send` / `window_interrupt` / lifecycle | 统一控制留痕写入口 |
| Agent 能力探测（`steer` / `cancel` 方法存在性） | `window_send` / `window_interrupt` | 能力缺失如实降级，不假装已引导/已中断 |
| Config 校验（`orphanTimeoutMs`、wait 轮询间隔等） | 生命周期 / `window_wait` | 装配期校验，非法响亮失败，不写死默认值到处散落 |

### B1 发现：`window_list` + `window_inspect` → AC-24

- `window_list`：读 `RunListIndex`（陈旧时重建），过滤 `status/topic_id/time_window`，分页；origin 只见自己派出的，child 只见分配给自己的；默认不含 result 正文。
- `window_inspect`：`sessionController.inspect` 读元数据，`sessionController.page` 按需分页历史；按 run 关系授权；历史内容标记为不可信数据。
- **为什么先做**：纯读、零状态变更，风险最低；同时成为后面所有批次的调试与验收抓手（“child 到底在跑什么”随时可查）。

### B2 控制：`window_send` + `window_interrupt` → AC-26 / AC-27

- `window_send`：活动 run 前置；目标 `status==='running'` 走 `steer`（最近 step 边界），空闲走 `followup` 排队；kind=`dsh-window-guidance`；写 RunMessage 摘要与控制事件。
- `window_interrupt`：`mode='turn'` 只 `agent.cancel({kind:'hook', reason})`、run 保持 running；`mode='run'` 取消当前轮 + 落 `cancelled` 结果 + `callback=not_requested`；目标离线时如实拆分“已落盘 / 未执行”。
- **顺序**：send 先（不动 run 状态机），interrupt 后（动状态机 + 终止语义）；两者的授权与控制留痕共用 B0 工件。
- AC-25（dispatch 复用 child）已在当前交付中完成，本批回归即可。

### B3 等待：`window_wait` → AC-28

- 目标集合解析复用 `window_list` 的逻辑；`mode='all'|'any'`；优先事件驱动（`agent/status` / run 状态变更），事件缺失时受配置约束的有界轮询；
- `timeout_ms` 到点返回当前快照 + `timed_out=true`；全程观察 `exec.signal`；不消费 callback。
- **依赖**：B1 的目标解析；语义独立，可与 B2 并行。

### B4 结构化结果：`output_schema` / `structured` → AC-29

- `window_open` / `window_dispatch` 收 `output_schema`，用 `@deepseek-ai/dsh-tools` 的 JSON Schema 校验器在创建时校验（非法 → `WINDOW_OUTPUT_SCHEMA_INVALID`，不建 run），随 run 持久化；
- `window_complete` 在落结果前校验 `structured`；缺/不符分别 `WINDOW_STRUCTURED_RESULT_REQUIRED` / `INVALID`，不落盘不回调；failed/cancelled 可不带 structured 但 content 必填；
- `window_status` 回读；topic completion entry 只存 completionId + 摘要。
- **依赖**：无，独立于 B1～B3，可并行；校验器是已有 peer 依赖，不引新包。

### B5 branch 生命周期：stop / orphan / drain / reconcile → AC-30

- `reconcile()`：插件启动时恢复未送达 callback、清理半截写入、按 `orphanTimeoutMs` 标记 orphan 并释放 topic claim；
- `onOriginStopped`：挂 `workspace/session-stop`（或等价的 origin 停止信号），对 active run 执行 stop/orphan，child 取消尽力而为并留痕；
- `drain()`：插件卸载时等待已接受控制操作落盘；
- **依赖**：B2 的 cancel 路径（复用 `window_interrupt` 的 child 取消，不另写一套）、B0 控制事件与配置校验；
- **为什么最后**：涉及宿主事件集成与重启对账，风险最高，等控制路径稳定后再挂。

### B6 Topic Ledger → AC-18～AC-23

- 分层 JSON 存储（§7.4 目录结构）+ `window_topic_create/join/get/append/claim`；revision CAS；claim 占用；conflict/resolution；L0→L3 汇总投影与重建；
- 接入点：`window_open(topic_id)` 参与登记、continuation 手工 completion、branch `window_complete` 自动 completion；
- **独立性**：与 B1～B5 无依赖，可并行启动；`claim` 释放钩子需等 B5 的 stop/orphan 到位后接上。

### 批次依赖总览

```text
B0 基础设施 ──┬──▶ B1 发现 ──▶ B3 等待
             ├──▶ B2 控制 ──▶ B5 生命周期
             └──▶ B4 结构化（独立，可并行）

B6 Topic Ledger（独立，可并行；claim 释放钩子依赖 B5）
```

### 完成定义（Definition of Done）

只有以下条件同时满足才算完成：

- 每一批次的 AC 全部通过，且**只做当前批次的工具**（不提前把下一批入口注册出来冒充已交付）；
- continuation 实机续接后，原窗口没有收到完成回调；结果留在新窗口，启用 topic 时可由参与者主动查询；
- branch 实机完成后，原窗口收到真实分支结果，冷窗口与失败重试也有证据；
- 普通 turn/end 不会触发 branch 完成回调，continuation 也不能通过其他状态变化绕过“不回调”约束；
- 同一主题的多个窗口能读取彼此完成内容；continuation 只写台账不回调，branch 写台账后再回调；
- Topic Ledger 在插件重启后仍能恢复主题、参与者、完成内容、claim、conflict 和 revision，内存清空不丢事实源；
- Topic Ledger 按 L0→L1→L2→L3 读取：上层只给索引和有界摘要，明细只按需分页，不把全部历史作为默认上下文；
- branch 运行时控制齐备：origin 能 list/inspect/dispatch/send/interrupt/wait，且全部按 origin→child 授权，child 不能反向控制；
- 声明 output_schema 的 run 只有通过 structured 校验才能完成并回调；topic entry 只引用 completionId，不复制结构化正文；
- branch stop/orphan/drain 与 reconcile 有确定行为，origin 归档不再留下永久孤儿；continuation 与外部业务插件所有权不被误接管；
- 过期 revision、重复范围占用和未解决冲突均有确定性的拒绝或醒目状态，不能静默覆盖他人成果；
- `dsh-window` 无对外部业务插件的反向依赖；
- 文档、工具描述和回执不夸大 delivered、完成或 GUI 开窗语义。

---

## 14. 能力边界与去重

本节用于审核新增运行时控制层与已有 FR 是否形成两套真相或重复入口。

| 容易混淆的两项 | 各自职责 | 不重复规则 |
|---|---|---|
| `window_list` vs `window_topic_get` | list 是运行时 run/child 清单；topic_get 是项目主题知识 | 主题 activeRuns 只存 `run_id` 指针；run 状态以 run store / list 为准 |
| `window_status` vs `window_list` | status 是单 run 详情；list 是分页摘要 | list 默认不返回 result 正文；需要正文或 structured 时按 run_id 调 status |
| `window_inspect` vs `window_topic_get` L3 | inspect 读 child 会话历史；topic L3 读协作 entry | inspect 不回写主题；topic entry 不复制会话完整对话 |
| `window_inspect` vs `window_status` | inspect 看会话本身（元数据/历史）；status 看 run 状态机 | inspect 的 running/idle 不代表 run 终态；run 结果只从 status/result 读 |
| `window_open` vs `window_dispatch` | open 创建新 child；dispatch 复用已有 child | 两者共用同一 run 状态机；dispatch 不得再创建会话，open 不得复用他人 child |
| `window_send` vs `window_dispatch` | send 引导运行中的同一 run；dispatch 开启新 run | send 不创建 run、不改 runStatus；没有活动 run 时才用 dispatch |
| `window_send` vs `window_complete` | send 是进行中引导；complete 是终态结果 | send 永不写 result/callback；complete 是唯一 branch 完成入口 |
| `window_wait` vs callback | wait 是 origin 主动拉取/join；callback 是 child 完成后 push | wait 不消费 callback、不改 run；两者可并存 |
| `window_wait` vs `window_list` / `window_status` | wait 阻塞到条件满足或超时；list/status 立即返回 | wait 只读状态不改状态；超时返回快照，不能把 running 当完成 |
| `window_interrupt(mode='run')` vs FR-19 stop | interrupt 是 origin 显式取消；stop 是 origin 归档/宿主动触发的同一用例 | 不新增第二个取消工具；两者写同一 result/lifecycle/control，语义一致 |
| `structured result` vs Topic完成 entry | structured 是任务结果契约；topic entry 是共享协作记录 | topic completion entry 只保存 completionId 与有界摘要；完整 structured 只存 run result |
| branch runtime ownership vs 业务插件所有权 | 前者是 origin 对 run 的运行控制权；后者是外部业务插件的席位与业务拍板 | origin 归档可 stop/orphan run；业务插件不因此改写，也不能伪造 run 终态 |
| branch runtime ownership vs continuation | branch 有 origin→child 运行关系；continuation 已转交所有权 | continuation 没有 run，不适用 list/send/interrupt/wait/lifecycle，也不允许被当作 branch child 控制 |

补充约束：

- 新增的 `window_list`、`window_inspect`、`window_send`、`window_interrupt`、`window_wait` 都不得改变 FR-4 的 continuation 语义；
- 新增的 `output_schema` / `structured` 是对 FR-6/FR-7 的扩展，不新增第二条完成路径；
- 新增的生命周期只作用于 branch run，不替代 DSH session 生命周期，也不替代外部业务插件的需求状态机；
- 新增控制记录是审计与恢复用途，不进入模型默认上下文，也不与 Topic Ledger 的协作 entry 重复。

---

## 15. 后续候选（不在 P0）

- `callback_mode='turn_end'`：仅面向明确的单回合 branch，在该回合并仅该回合结束时提取最后一条非空 assistant 输出；绝不可用于 continuation 或多回合任务。
- branch 活动 run 的用户可见超时提醒 UI / 通知；超时判定本身已在 FR-19 实现，候选只做呈现与提醒。
- branch 状态 Client 面板、按 origin/child 查询和人工对账入口。
- 自动指数退避重试、永久失败 dead-letter 视图与记录保留策略。
- 主题变更的实时通知；默认仍是共享读取，只有显式订阅的参与者才接收非人类来源提示，不能变成全员广播。
- 基于规则或独立复核的语义矛盾建议；只能标记候选 conflict，不能未经证据自动覆盖或裁决他人成果。
