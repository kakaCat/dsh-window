# ADR-0008：branch 完成契约改为常驻 system prompt section

- 状态：**已实现**
- 日期：2026-11-01
- 关联：ADR-0005（读回执）、REQ G-4（完成可信）、REQ G-5

## 一、证据（不是推测）

扫了本机 32 个真实的 branch 子会话（`~/.dsh/sessions/**/session.v4.jsonl.zstd`，按
`source.kind='dsh-window-seed'` 识别），用 `.surfaceOp = replace` 事件模拟表面消息集合：

| 子会话回合数 | seed 是否仍在表面上 |
|---|---|
| 77 | **否**（被 replace 覆盖） |
| 42 / 36 / 36 / 10 … | 是 |
| 7 | **否** |

32 个里有 **3 个**的 seed 已被上下文压缩替换掉。也就是说：`[DSH Window 分支任务包]`
里那句「完成后必须调用 window_complete」在长任务里会消失，child 可能正常结束、永不回调。

## 二、决策

在 agent 创建时（`agent/created`），若该会话是**活动 branch run 的 child**，给它挂一段
常驻 system prompt section：

- `name='dsh-window-branch'`、`order=900`、`interpolate=false`；
- 文本包含 `run_id` / `origin_window` / `child_window`、「完成必须 window_complete」、
  「普通 turn/end 不算完成」、「回调正文 ≤4000 字符」；
- `agent/disposed` 时释放；查找 run 期间 agent 被替换则不挂；
- 宿主没有 `systemPrompt.section` 能力时**安静降级**——退化为原来的「只有 seed 里写一次」；
- 只由对话组安装一次（三行全开也只有一份订阅）。

## 三、边界

- 不改 run 状态、不投递消息、不做完成判定（反向探针仍守着「观测层不得完成 run」）；
- 不挂给 subagent：它的 session id 不等于任何 run 的 `childSessionId`；
- 不覆盖、不删除宿主自己的 prompt 段，只追加一条；
- section 注册失败只当作「没挂」，不影响 agent 创建。

## 四、如何验证

- 单测：`test/branchContracts.test.ts`（文本、活动 run 判定、挂载/释放、无能力降级、agent 被替换）；
- 真机：重启后开一个 branch 子窗，在它的会话日志里 grep `DSH Window 分支契约`，
  应出现在 `system/message` 中；再让它跑多轮，确认压缩后契约仍在、仍会 `window_complete`。

## 五、第一次实机验证失败与修正（重要）

第一次上线后开子窗自检，子窗口答 `contract=NO_CONTRACT`：契约没进模型。

原因不是 `section()` 用错，而是**时序**：宿主在 `sessionController.create` 时就把 agent
建好了，`agent/created` 那一刻 run 记录还没落盘，`findActiveRunByChild` 返回 undefined，
于是静默跳过；等 run 建好，agent 已经创建完、不会再触发该事件。

修正：

- 端口加 `attach(sessionId, text)`（热路径）：`window_open` / `window_dispatch` 在
  **run 落盘之后、seed 投递之前**立刻挂载——system prompt 是「每次模型步骤前组装」的
  （`systemPrompt.assemble`），此刻挂上就能进第一次组装；
- `agent/created` 保留为冷路径：重启后重新载入的会话，agent 晚于 run 创建时靠它补挂；
- 两条路径共用同一个 `register()`，按会话去重（`disposers` 已有则跳过）。

## 六、已知取舍

section 是「提示」，不是强制：child 仍可能不调用 `window_complete`。本 ADR 只是把
「契约在上下文里」这件事做稳，不引入自动完成或超时判定（REQ G-4 的边界不变）。
