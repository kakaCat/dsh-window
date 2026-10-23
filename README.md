# dsh-window

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-tools)（DSH）的窗口插件：把「开一个新窗口」拆成两个业务场景，并为后续的完成回调与 Topic Ledger 提供独立地基。

DSH 是一个以 Cordis 组合机制装载插件的智能体运行环境；本仓库是一个独立的 Cordis bundle（见 [cordis.patch.yml](cordis.patch.yml)），为 DSH Agent 提供一组 `window_*` 工具与可注入的 `window` Host Service。

> **状态**：当前为 0.x 早期阶段，工具面与存储格式仍可能变动，升级前请留意提交说明。

## 安装

前置要求：Node.js ≥ 20，以及一个运行中的 DSH profile。

```bash
git clone https://github.com/kakaCat/dsh-window.git
cd dsh-window
pnpm install
pnpm build
```

然后在任意一个 DSH 会话中让 Agent 安装本 bundle（以仓库的绝对路径为准）：

> 请用 plugin_manager 的 install_bundle 把 `/path/to/dsh-window` 安装到当前 profile。

安装即时生效；插件清单里出现 `dsh-window` 一行即为成功。之后 Agent 即可调用 `window_open` 等工具（见下）。

### 可选配置

在 [cordis.patch.yml](cordis.patch.yml) 的 `config` 中（或装配层等价位置）可配：

| 键 | 缺省 | 说明 |
|---|---|---|
| `dataRoot` | `$DSH_HOME/storages/dsh-window` | 数据根目录（见「数据路径」） |
| `orphanTimeoutMs` | 24h | 孤儿 run 判定超时 |
| `waitPollMs` | 500ms | `window_wait` 轮询间隔 |
| `leaseMinMs` / `leaseMaxMs` | 1s / 24h | 协作占用（claim）租约上下限，倒挂即装配期失败 |

非法值在装配期响亮失败（`WINDOW_CONFIG_INVALID`）。

## 两个场景

| 场景 | 用途 | 默认 mode | 回调 |
|---|---|---|---|
| `continuation` | 当前窗口上下文将满，新窗口接管并继续当前任务 | `create` | 无，结果留在新窗口 |
| `branch` | 原窗口保留主任务，把独立分叉任务交给新窗口 | `fork` | 有，完成后回调原窗口 |

`scenario` 是业务语义，`mode` 是会话创建方式；回调策略只由 `scenario` 决定，不能用 `mode` 反推。

## 提供的工具

- `window_open`：按 scenario 开窗，投递自署来源的 seed，并做标题 / 模式 / 模型继承回执；可选 `target_workspace` 把子窗开到另一个工作区（仅 `mode=create`）；配合 `topic_scope='global'` 可与跨区子窗共用同一全局主题。
- `window_complete`：branch 完成后上报 `status` 与 `content`；先落结果，再回调 origin。
- `window_status`：origin / child 只读查询 run 与 callback 状态。
- `window_retry_callback`：origin 对已落盘但回调未确认的 run 手动重试；同一 `callbackId` 不伪造新结果。
- `window_dispatch`：向已有 branch child 再派一条任务；不创建新会话，新建 run，完成后仍回调 origin。
- `window_list`：分页列出本窗口可见的 branch run 摘要（origin 见自己的、child 见分配给自己的）。
- `window_inspect`：只读查看某个窗口的会话元数据与（可选）分页历史；不做任何写操作。
- `window_send`：origin 向运行中的 child 投递引导（steer/排队）；只引导、不完成。
- `window_interrupt`：origin 中断 child 当前轮（turn）或取消整条 run（run）；origin 主动取消不回调自己。
- `window_wait`：等待一组 branch run 进入终态（all/any + timeout），拉取语义、不消费 callback。
- `window_topic_create`：在当前项目创建或按 ID 幂等打开项目主题（目标不一致响亮拒绝）。
- `window_topic_join`：把当前窗口自己加入主题并取得首份同构快照。
- `window_topic_get`：按 L0 → L1 → L2 → L3 金字塔读取；省略 `topic_id` 只读项目/主题摘要，提供时读 L2 与最近明细分页。
- `window_topic_append`：追加 `progress | decision | completion | conflict | resolution`（revision CAS、candidate + conflict、supersedes/resolution 关联）；只写台账，从不触发回调。
- `window_topic_claim`：按任务/模块/文件范围 `acquire | renew | release` 协作占用；同 scope 未过期占用冲突、过期可接管、历史保留。
- `window_topic_send`：把一条协作消息写入主题（`kind='message'`）并投递给其他参与者；来源非 user，逐目标回报 delivered/failed，投递失败不回滚记录。
- `window_topic_*` 均支持 `topic_scope='project'|'global'`：缺省 project；global 是跨工作区共享主题，落在保留命名空间 `@global`，知道 topic_id 的窗口可加入；全局 L1 清单只显示自己已参与的主题。

## 当前阶段边界

已实现：

- 独立插件工程、装载清单与构建；
- `window_open` 的 continuation / branch 双场景；
- create 落点（workspaceId 优先、cwd 兜底、都没有则响亮失败）；
- seed 自署投递（`source.kind='dsh-window-seed'`，永不为 `user`）；
- branch 运行记录落盘、`run_id` 与 `callback_armed`；
- `window_complete` 显式完成、结果回调（热窗口 followup、冷窗口 resume）、幂等与冲突拒绝；
- `window_status` 查询与 `window_retry_callback` 手动重试；
- `window_dispatch` 复用已有 branch child 再派任务（单 child 单活动 run、需既有委派关系）；
- `window_list` / `window_inspect` 发现与只读查看；
- `window_send` 运行中引导（steer/queue）与 `window_interrupt` 中断/取消（turn/run，origin 主动取消不回调自己）；
- `window_wait` 等待/join（all/any + timeout，事件驱动优先，不消费 callback）；
- 结构化结果：`window_open`/`window_dispatch` 声明 `output_schema`/`result_required`，`window_complete` 校验 `structured`，`window_status` 回读；
- branch 生命周期：启动 `reconcile`（孤儿标记、回调重投、半截文件清理）、origin 停止联动 stop、卸载 drain；
- RunListIndex 可重建投影、`control.jsonl` 控制留痕、`messages.jsonl` guidance 留痕、`audit.jsonl` 只读访问留痕、Agent steer/cancel 能力探测、Config 装配期校验（含 claim 租约上下限）；
- Topic Ledger（[FR-11](docs/requirements/REQ-DSH-WINDOW-001.md) / [FR-12](docs/requirements/REQ-DSH-WINDOW-001.md)）：`$DSH_HOME/storages/dsh-window` 下的分层 JSON 金字塔（L0 索引 → L1 项目摘要 → L2 主题摘要 → L3 明细 + `_journal/` 事务恢复），revision CAS、协作占用、conflict/resolution、`window_open(topic_id)` 参与登记与 branch 完成自动 completion 指针；
- `window` Host Service（[§6.5](docs/requirements/REQ-DSH-WINDOW-001.md)）：`ctx.provide('window', ...)`，方法面覆盖全部工具用例 + `reconcile` + `stopForOrigin`，供外部插件按 `ctx.inject('window')` 可选接入；未装配时调用方按其错误码适配层降级；
- `window_status` / `window_list` 可复盘 lifecycle 与控制留痕；`window_inspect` 留痕且只给工具名摘要；
- 新窗口标题按任务派生（`续接：…` / `分叉：…`；显式 `title` 优先，seed 无可派生摘要时回退源标题递增），Agent 预设与模型继承同报三态，投影读数会先解包 `{ver,seq,val}` 行；
- **跨工作区父子窗口**（[FR-21](docs/requirements/REQ-DSH-WINDOW-001.md)）：`window_open(target_workspace=…)` 支持 workspace id / 标题 / 绝对路径，把 `mode=create` 的子窗建到另一个工作区；子窗建立后 `window_send` / `window_dispatch` / `window_complete` / `window_wait` 与同工作区完全一致。`fork` 会继承源会话 cwd，因此跨区只允许 `create`；未命中/歧义在开窗前响亮失败，不退回源工作区。
- **全局主题与跨工作区消息**（[FR-22](docs/requirements/REQ-DSH-WINDOW-001.md)）：`topic_scope='global'` 让不同 workspace 的窗口加入同一主题台账；`window_topic_send` 写一条 `message` entry 并投递给其他参与者（`dsh-window-topic-message`，逐目标回报，单次上限 50）。`window_open(target_workspace=…, topic_scope='global')` 把子窗开到另一个工作区并加入同一主题；项目内主题仍按项目隔离。

**边界**：本插件独立运行，不依赖也不感知任何外部业务插件。普通 `turn/end` 不会触发完成回调；主题的 `activeRuns` 只是 run_id 指针，实时状态以 run store / `window_list` 为准。跨工作区协作有两条通路：① 父子窗口（origin 自己开的 child，FR-21）；② 全局主题（不同 workspace 的既有窗口按 topic_id 加入后互发消息，FR-22）。全局主题是**能力式加入**——知道 topic_id 即可加入，因此 topic_id 应按共享凭证对待；项目内主题不跨项目可见，且 `target_workspace` 仍不能与项目内 `topic_id` 组合。

## 数据路径

插件根固定为 `$DSH_HOME/storages/dsh-window`（未设置 `DSH_HOME` 时默认 `~/.dsh/storages/dsh-window`）；
run 记录与 Topic Ledger 共用这一根：

```text
$DSH_HOME/storages/dsh-window/
├── manifest.json                 # schemaVersion / storageVersion
├── index.json                    # L0：项目与主题指针
├── runs/                         # branch run（window_status / list / retry 的规范位置）
│   ├── index.json                # RunListIndex 可重建投影
│   └── <runId>/
│       ├── run.json              # run 状态、完成结果与 callback 状态
│       ├── control.jsonl         # send/interrupt/stop/orphan/drain 控制留痕
│       └── messages.jsonl        # guidance 留痕（RunMessage，只存摘要）
├── audit.jsonl                   # window_inspect 等只读访问留痕
├── projects/<projectHash>/       # L1
│   ├── project.json
│   └── topics/<topicHash>/       # L2
│       ├── topic.json            # 身份卡（目标、revision、创建者）
│       ├── summary.json          # 由 L3 明细重建的有界汇总
│       ├── participants/  entries/  claims/  conflicts/
└── _journal/                     # 跨文件事务恢复区（模型不可读）
```

路径段一律是 sha256 前缀：原始 projectId / cwd / topicId / scope / 窗口 id 不作为文件路径段。

全局主题（FR-22）落在 `projects/<sha256('@global')>/topics/...` 这个保留命名空间；真实 workspaceId / cwd 不得占用 `@global`，避免与全局主题哈希碰撞。

未设置 `DSH_HOME` 时默认根为 `~/.dsh/storages/dsh-window`。配置项见上文「可选配置」。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 文档

- 需求与设计：[docs/requirements/REQ-DSH-WINDOW-001.md](docs/requirements/REQ-DSH-WINDOW-001.md)
- 架构决策记录：[docs/adr/](docs/adr/)
- 端到端自测指南：[docs/guides/e2e-self-test.md](docs/guides/e2e-self-test.md)

## 贡献

欢迎 Issue 与 Pull Request。提交前请确保 `pnpm typecheck` 与 `pnpm test` 全绿；涉及存储格式或工具面变更时，请同步更新 README 与 [docs/requirements](docs/requirements/)。

## License

[MIT](LICENSE) © kakaCat
