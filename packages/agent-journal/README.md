# Agent Journal · 每日回顾

> 本文是随代码保留的历史模块文档；其中真实部署与运行声明不构成本新项目的验证。工具集入口见[根文档](../../README.md)。当前项目验证见[验证记录](../../docs/VALIDATION.md)。独立源码副本中的数据源说明见[来源说明](docs/SOURCES.md)。

状态：**J1a + J1b 模型 + J1c 1.1/1.2 已实现（2026-11-15）**：配置校验、Trace content 增量同步（cursor/租约/页校验/墓碑）、按日投影、确定性骨架、**OpenAI 兼容云模型 map/reduce 日报**、`sync`/`dream`/`run`/`status` 命令；**独立 Trace content 客户端与 token**；**launchd 06:30 安装器已安装并 kickstart 验证**；61 项测试通过；2026-11-14 的真实 DeepSeek 日报已生成（17 次调用 / 138,674 tokens / 约 3m47s）。**仍未完成：连续两天的自然 06:30 自动日报、真实 provider 三天质量核对、map 缓存/重试、Knowledge 索引（`generated: true`）。**（阶段用 J1a/J1b、J2、J3，避免与 Trace 的 P0–P3 混淆。）

目标：每天定时回顾“今天和所有 agent 一起做了什么”，产出**可追溯到会话/事件**的日报，并把日报作为后续经验整合的输入。它消费 [agent-trace](../agent-trace/README.md) 的 content 归档，**不复用**其他项目的 follow 实现，只遵守共享协议。方案依据与实测见 [历史报告未复制，见迁移说明](../../docs/MIGRATION.md)。

项目命名与目录规则见[统一命名说明](../../docs/NAMING.md)。

也可无需运行 Trace，离线导入自定义活动 JSON 并生成无模型日报；格式、限制与示例见 [离线数据源](docs/SOURCES.md)。安装包内示例应先复制到用户可写目录，不能把运行库或日报写进 `node_modules`。npm 发行包提供编译后的 CLI 与示例；源码测试和 macOS 安装器仅在源码仓库提供。

> **服务安全：** 新项目不自动安装服务，源码安装器使用隔离标签 `local.agent-observatory.agent-journal`，安装或卸载须显式提供 `--apply`；先用 `--dry-run` 审核。自定义配置仍可能指向现有数据库、输出目录、token 和 Trace 服务；标签隔离不保护你显式指定的数据。以下旧环境历史安装记录不是新项目已经安装或验证的声明。

## 与现有项目的关系

```text
Codex / pi / dsh 会话日志
   └→ agent-trace（采集、脱敏、content_ref、删除墓碑、只读 API）
        └→ agent-journal（独立 sync + 按日聚合 + 云模型总结）
             ├→ daily/YYYY-MM-DD.md / .json（人看 + 机读）
             └→ 交给 agent-knowledge 作为 source 索引（需 generated 标记，未实现）
```

| 项目 | 职责 | 与 Journal 的边界 |
| --- | --- | --- |
| Agent Trace | 采集与归档 | Journal 只通过 `GET /v1/events`（content 视图）和 `/v1/status` 读取；不读 Trace 数据库、不读宿主原始日志 |
| Agent Stats | 用量、费用、执行统计 | 不参与；Journal 的成本来自 `usage.snapshot`，无需耦合 Stats |
| Agent Knowledge | 知识检索与证据 | 只通过**文件**集成：Journal 写 Markdown，Knowledge 配一个 source 目录索引；不互相调用、不共享数据库 |
| Agent Journal | 每日回顾与经验整合 | 自己维护 cursor、租约、日缓冲、运行记录和产物 |

**解耦原则**：共享的是 [consumer-follow 约定](../agent-trace/docs/consumer-follow.md)、[protocol v1](../agent-trace/docs/protocol.md) 和 [协议 fixtures](../agent-trace/fixtures/protocol/README.md)；不共享代码。理由见 [历史报告未复制，见迁移说明](../../docs/MIGRATION.md)：Knowledge 的 follow 包含证据库、墓碑、项目绑定等 Journal 不需要的概念，直接复用会把错误的领域模型带进来；当前 monorepo 虽已提供独立公共 API，也不应直接复用 Knowledge 的 follow 实现，以免绑定不同模块的领域模型与发布节奏。

## 相关实现与取舍（Claude Code dreaming / 开源方案）

调研日期：2026-11-15。**没有现成项目同时满足**“多 agent 归一化归档输入 + 按日定时 + 可追溯到事件/会话的日报”；因此只借鉴机制与产物形态，不引入外部实现，也不重复采集日志。

| 方案 | 它做什么 | 借鉴什么 | 为什么不是直接采用 |
| --- | --- | --- | --- |
| Claude Code **autoDream**（官方未发布，社区逆向整理） | 后台 fork 子代理回顾近期会话，把记忆合并、去重、修正矛盾、修剪 `MEMORY.md`；门控为 24h + 至少 5 个会话，PID 锁互斥，四阶段（Orient → Gather → Consolidate → Prune） | 触发门控、锁/回滚、四阶段整合 Prompt、安全边界（只读输入、写入限定目录） | 它是**单宿主记忆维护**，不汇总多个 agent 的执行过程，也不以共享归档为输入；官方能力不可用（feature flag），只能参考逆向文档 [cc-haha](https://github.com/NanmiCoder/cc-haha/blob/v0.4.1/docs/memory/03-autodream.md) |
| [grandamenium/dream-skill](https://github.com/grandamenium/dream-skill) | 用 skill + Stop hook 复刻 auto-dream：24h 门控、四阶段记忆整合 | 轻量条件检查（~10ms）、skill 化的整合流程 | 只处理 Claude Code 自己的 memory 目录；没有多 agent 输入、没有日报产物；依赖宿主 skill/Stop hook，不适合作为定时服务 |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | hooks → 本地 worker → observer agent 生成 observations/summaries → SQLite → 渐进式披露 MCP 检索，支持 claude-code/codex/pi/dsh 等 | 分层摘要与索引（先小索引再按需取详情）、多宿主适配、`<private>` 脱敏 | 会话级记忆而不是每日回顾；体量大、带托管服务；hooks + observer 是**第二套采集链路**，与 Trace 重复，且会绕开 Trace 的事件身份/删除/游标 |
| [jackwener/AI-digest](https://github.com/jackwener/AI-digest) | 本地 CLI 解析 5 种 AI 编程工具的原始日志，调 LLM 生成中文日报（Highlights + 活动卡片） | 日报结构、多源聚合、本地时区切日 | 自己解析宿主日志，不利用 Trace 已有的归一化、脱敏、外置正文、删除传播和事件身份；再接一套解析器会重复且更难维护 |
| [JerryZLiu/Dayflow](https://github.com/JerryZLiu/Dayflow) | 屏幕录制 → 自动时间线 → daily standup、周报、对话检索，本地优先 | 产物形态（standup 亮点/阻塞/下一步）、周报复盘、Markdown 导出 | 输入是屏幕活动，不是 agent 对话与执行证据；无法回答“agent 具体改了什么/验证了什么” |
| Letta sleep-time compute、ReMe 等记忆框架 | 把记忆整理/反思放到离线批处理 | “日报 → 候选经验 → 定期整合”的两层节奏 | 概念参考，不引入依赖；跨天整合要等 Knowledge 的 `record_memory`/`record_feedback`（未实现） |

**与 Claude Code dreaming 的关系**：本项目的 J1 是“看得懂的日报”（读了什么、做了什么、卡在哪、明天做什么）；J3 才是 dreaming 语义的“跨天经验整合”（去重、消矛盾、把明确决策/偏好/lesson 变成候选事实）。日报是整合的输入，不是替代。

## 实现结构（J1a）

| 模块 | 职责 |
| --- | --- |
| `src/cli.ts` | `config-check` / `sync` / `dream` / `run` / `status` 入口 |
| `src/config.ts` | 严格 JSON 配置、路径解析、token 只从 env 读取 |
| `src/trace/client.ts` | `/v1/status`、`/v1/events` 客户端（回环、Bearer、超时、413 缩页） |
| `src/trace/page.ts` | v1 页契约校验：信封、顺序、身份、会话键、metadata allowlist、`content_ref`；按 `projects` 消费范围过滤名单外事件 |
| `src/store.ts` | SQLite cursor、单实例租约、页幂等、墓碑、日记录与运行记录 |
| `src/projection.ts` | 确定性投影、token 估算、input hash |
| `src/provider.ts` | OpenAI 兼容 chat-completions 客户端（env key、超时、HTTP 错误分类） |
| `src/model.ts` | 按会话 map / 跨会话 reduce、预算裁剪、模型输出校验 |
| `src/render.ts` | 确定性骨架与模型日报渲染 |
| `src/sync.ts` `src/dream.ts` | 同步与日报编排 |

测试入口：`npm test`（**50 项**，覆盖 day/config/page/store/projection/sync/dream/provider/model，含 Trace protocol fixtures、合成 Trace E2E、mock HTTP provider 与 fake map/reduce provider）。`npm run check` 在 `npm ci` 后可用。

真实归档验证（2026-11-15，只读临时副本，验证后删除）：

- `sync` 从 content 归档拉到 cursor 44,826，本地投影 43,770 事件 / 126 会话，SQLite 约 58 MB。
- `dream --date 2026-11-14`：59 会话 / 22,362 事件 → **43,110 tokens 上界、107,130 字符、78 KB Markdown**，记录成本 $3.1964；重跑 `skipped`，`--force` 才递增 revision。
- `run` 增量 25 事件后 7.5s 完成；`dream --today` 生成 37 会话 / 10,543 事件的预览。
- 真实数据同时验证了 codex、pi、dsh 三种 runtime 的页校验（dsh 事件身份包含原生 row seq，消费者只能校验 64-hex，不重算）。
- 真实 DeepSeek 验证（2026-11-14）：`deepseek-flash` 生成 30 KB 日报，17 次调用 / 输入 95,694 / 输出 42,980 / 合计 138,674 tokens，约 3m47s；重跑 `skipped`，不重复计费。
- `deepseek-flash` 会先输出 `reasoning_content`：实测 4,000 output tokens + 60s 会全部耗在 reasoning 上（`finish_reason=length`）或超时。示例配置使用 `max_output_tokens: 16000`、`timeout_seconds: 300`；请求失败时会报告 `finish_reason` 与 `message_keys` 便于诊断。

## 已确认的决策（2026-11-15）

1. **次日出 D-1 终版**：每天 06:30（本地时区）总结前一天，宽限 6 小时；同日 `--today` 只作预览，不写正式产物。
2. **云模型 API**：provider 可配置，密钥只从环境变量读取；默认只发送确定性投影后的摘要，不发送工具输出或外置正文。
3. **独立实现**：Journal 自己实现窄版 Trace 拉取与页校验，不复制 Knowledge 的 `follow`；一致性靠共享 fixtures + 合成 Trace 测试防漂移。
4. **文件是 Knowledge 的集成边界**：日报写入 `daily/`，由 Knowledge 作为 source 索引；Knowledge 需要新增 source 级 `generated: true` 标记（否则会把模型生成物当来源事实），该改动未实现。
5. **不做常驻 daemon**：`run` 是一次性批处理，由 launchd 每天触发；写库、模型、时间戳都在同一个 run 内完成。

## 时间与覆盖语义

- 日窗口：本地时区 `[00:00, 24:00)`；按事件 `occurred_at` 归属，而不是会话开始时间或导入时间。
- 会话元数据（标题、cwd）按 `session_key` 回查全归档：会话可能在前一晚开始，`session.started` 不在当天窗口内。
- 宽限：`now >= 当天结束 + 6h` 才 finalize，降低“最后一分钟会话还没采集到”的概率。
- 迟到事件：输入摘要变化时重算并递增 revision，保留历史；删除墓碑到达时把该日标 `stale`，重算并注明“含已撤回会话”。
- 历史回补：`observed_at - occurred_at > 36h` 的事件只进证据、不自动生成日报；更早的日期需要显式 `--backfill --date`，避免回补旧会话时“补写历史日报”（P0 实测对照日 late ratio = 100%）。
- 连续离线：自动按日顺序补跑尚未实现；`max_days_per_run` 已解析，但常规 run 当前不会自动遍历漏日。

## 确定性投影（v1）

先聚合、后模型；工具输出与 process 噪声不进入模型输入：

| 输入 | 处理 |
| --- | --- |
| `session.started` | 标题、cwd、runtime、cli_version；全归档回查 |
| `message.user` | ≤20 条×1,200 字符；过滤 `# AGENTS.md instructions`、`<INSTRUCTIONS>`、`<environment_context>`、`<external_…>` 等注入块 |
| `turn.completed` | ≤8 条×1,500 字符（codex 最终答复） |
| `message.assistant` | 无 turn.completed 正文时回退最后 2 条（pi/dsh 终止答复在此），并标记 `answer_source: message.assistant` |
| `tool.called` | 工具名/次数；结构化提取绝对路径（排除凭据/密钥类路径），每会话 ≤40 条 |
| `tool.returned` | 只留状态计数，不发送输出 |
| `usage.snapshot` | 每会话最后一次 cumulative + 当天 `cost_usd` 求和 + `cost_source` |
| `reasoning.summary` | 默认不发送，仅计数 |
| `source.unknown` | 仅计数（dsh 流式 chunk 等） |
| `content_ref` | 仅计数，**绝不读取指向文件** |
| `session.deleted` | 从日缓冲删除该会话；已生成日报标 stale |

会话树：用 `parent_session_id` / `forked_from_session_id` 把主会话、subagent、fork 归组；日报按主会话叙事，子代理只贡献“做了什么调研/修复”。

## 模型阶段（J1b，已实现）

- provider：OpenAI 兼容 `POST {base_url}/chat/completions`，密钥只从 `api_key_env` 读取；401/403/400 永久失败，429/5xx/超时 transient。
- map：按会话生成结构化摘要（`session_key`/summary/decisions/follow_ups）；按 ~6k token 分批，大会话单独调用。
- reduce：跨会话合成日报 JSON：`highlights[]`、`projects[]`、`decisions[]`、`blockers[]`、`next_steps[]`、`candidates[]`、`evidence[]`。
- 每条要点必须能引用真实 `session_key`；渲染前校验 `session_key`/`project_id` 属于当天 bundle，未知或重复引用直接 `MODEL_OUTPUT` 失败，禁止编造。
- 预算：单日输入 ≤120k tokens（按投影估算），超出时按会话体积选择、丢弃低优先会话并在日报与 run 记录 `dropped_sessions`；输出上限由 `model.max_output_tokens` 控制。
- 幂等：run key = `hash(day, timezone, model, prompt_version, 输入摘要哈希)`；重跑默认返回已有结果，`--force` 才覆盖。
- 用量记录：每次调用记录 provider/model/tokens/耗时/估算成本到 `daily_runs`，不记录提示词正文。

### 模型实际收到的输入

模型只看到**确定性投影**，不是原始会话日志。每次 `dream` 的调用如下：

1. **map（每个会话批次一次）**
   - system：要求只依据输入、不要编造、写中文、返回固定 JSON（`session_key` / `summary` / `decisions` / `follow_ups`）。
   - user：`{day, timezone, sessions:[...]}`，每个会话包含：
     - `session_key`、`project_id`、`runtime`、`title`、`started_at`、`ended_at`、`open_ended`
     - `counts`：事件数、用户消息数、答复数、工具数、中断数、`source.unknown` 数
     - `user_messages`：≤20 条、每条 ≤1,200 字符（已过滤 AGENTS.md/`<INSTRUCTIONS>` 等注入块）
     - `answers`：`turn.completed` 最终答复（≤8 条×1,500 字符）或 pi/dsh 的 `message.assistant` 回退（≤2 条×800 字符）
     - `tools`：工具名与次数（**不含工具输出**）
     - `paths`：从工具参数中确定性提取的绝对路径（≤20 条，已过滤凭据/密钥类路径）
     - `cost_usd`
   - 一个会话的 payload 上限约 8k tokens；按约 6k tokens 分批，大会话单独一批。
2. **reduce（一次）**
   - system：要求基于会话摘要和统计写日报，返回固定 JSON。
   - user：`{day, timezone, totals, project_stats, session_digests}`；`session_digests` 是 map 产出的摘要/决策/待续，不带原始消息。

**不会发给模型**：`tool.returned` 的工具输出、`raw`、reasoning 摘要全文、`content_ref` 指向的外置正文、`source.unknown` 的具体内容、被预算丢弃的会话。模型返回的 `session_key` / `project_id` 必须属于当天 bundle，否则整次失败（`MODEL_OUTPUT`）。

## 存储与产物

SQLite（建议 `journal.sqlite`，0600）：

```text
sync_state   # trace_url、archive_id、cursor、健康、单实例租约
pages        # 已提交页指纹，用于页重放幂等
events       # 有界投影（message 文本、工具名/参数路径、usage；不存工具输出与 raw）
tombstones   # 已删除会话，阻止旧页复活
days         # day/status/revision/input_hash/output_hash
runs         # 每次 run 的 model/status/output_hash（当前 model 为 null）
```

产物目录（配置 `output_directory`，示例为 `./daily`）：

- `daily/YYYY-MM-DD.md`：人看的日报，带 frontmatter（date、timezone、projects、sessions、events、model、prompt_version、coverage、generated）与会话标识。J1a 固定 `generated: false`、`model: null`。
- `daily/preview/YYYY-MM-DD.md`：`--today` 预览，不写正式 day 记录。
- 权限 0600，先写临时文件再 rename；不覆盖其他日期的产物。
- 机读 JSON、`INDEX.md`、Knowledge 索引留到 J2。

## 命令（J1a 已实现）

```sh
node src/cli.ts config-check --config ./agent-journal.json   # 校验配置，不建库、不联网
node src/cli.ts sync --config ./agent-journal.json           # 拉增量页并提交 cursor
node src/cli.ts dream --config ./agent-journal.json --date 2026-11-14   # 默认先 sync
node src/cli.ts dream --config ./agent-journal.json --today             # 预览到 daily/preview/
node src/cli.ts dream --config ./agent-journal.json --date 2026-11-14 --no-sync --force
node src/cli.ts run --config ./agent-journal.json            # sync + D-1（launchd 入口）
node src/cli.ts verify-model --config ./agent-journal.json    # 用 DEEPSEEK_API_KEY 发一个极小请求验证端点/模型
node src/cli.ts status --config ./agent-journal.json
```

- `config-check` 会报告 Trace token 与模型 key 是否存在（不打印值）；`verify-model` 只发一个 512-token 的 JSON 探测请求（兼容会先输出 reasoning 的模型），不写日报。
- `dream` 默认先同步；`--no-sync` 跳过；`--today` 只写预览；`--force` 重算并递增 revision；`--include-backfill` 显式纳入历史回补。
- `run` 只做 Journal 自己的 sync + D-1，不调用 Knowledge 命令；Knowledge 的 `sync` 由 launchd 脚本作为独立步骤执行。
- 配置 `model` 时 `dream` 走云模型 map/reduce；`--no-model` 强制确定性骨架。provider 需要 OpenAI 兼容端点与 `api_key_env` 指定的密钥；缺 key 直接报 `MODEL_KEY_MISSING`。

配置（严格 JSON、未知键拒绝，相对路径相对配置文件；`agent-journal.example.json` 可直接复制）：

```json
{
  "schema_version": 1,
  "timezone": "Asia/Shanghai",
  "database": "./.agent-journal/journal.sqlite",
  "trace_url": "http://127.0.0.1:18767",
  "token_env": "AGENT_TRACE_JOURNAL_TOKEN",
  "output_directory": "./daily",
  "projects": ["agent-trace", "agent-stats", "agent-knowledge"],
  "page_size": 500,
  "finalize": { "grace_hours": 6, "max_days_per_run": 7, "late_observed_hours": 36 },
  "budget": { "max_input_tokens_per_day": 120000, "max_output_tokens_per_day": 100000 },
  "model": {
    "provider": "openai-compatible",
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-flash",
    "api_key_env": "DEEPSEEK_API_KEY",
    "timeout_seconds": 300,
    "max_output_tokens": 16000
  }
}
```

- `token_env` 指向 Trace content 客户端 token；需由使用者在所选 Trace 实例显式配置授权。隔离安装器默认 token 路径为 `~/.local/share/agent-observatory/agent-journal/content.token`（0600），由运行环境/launchd wrapper 注入 `token_env`；不要复用 Knowledge 的 token，也不要假定历史环境配置已应用到新实例。
- DeepSeek 4.1 Flash：示例使用 OpenAI 兼容端点 `https://api.deepseek.com/v1` + 模型 id `deepseek-flash`（DSH 目录里的默认 id），密钥环境变量 `DEEPSEEK_API_KEY`。若官方模型列表使用其他 id（如 `deepseek-chat`/`deepseek-v4-flash`），以实际列表为准。
- 如果你用的是 DSH 订阅账号（`deepseek-official` 的 Messages 路由）而不是 DeepSeek 平台 API key，Journal 当前只支持 OpenAI 兼容 API，不能直接复用该账号授权；需要额外实现 Messages 适配器或改用 API key。
- 模型密钥同样只从环境变量读取，不写入配置、日志或产物。
- `projects` 是**消费范围（consumption scope）**，不是访问控制/授权名单：Trace 开启全量采集后，content 页可能出现名单之外的 `project_id`（例如 `unscoped`）；Journal 会跳过这些事件并正常推进 cursor，不报错、不停摆。Trace 客户端的授权范围由 Trace 侧的 client/view 配置决定，与 `projects` 无关；名单外事件只做信封级基础校验（事件身份形状、同页去重、`archive_seq` 递增与 `next_cursor` 范围），不做更深的内容校验，因为不会落库。

## 调度（源码工具；新副本未安装）

macOS 上的 `scripts/install-macos-service.ts` **只包含在源码仓库，不包含在 npm 安装包中**。默认 label 为 `local.agent-observatory.agent-journal`（06:30、`RunAtLoad` false），不使用旧的 `local.agent-journal`。默认 state、token 与 key 位于隔离的 `~/.local/share/agent-observatory/agent-journal/`；可选 Knowledge 默认配置位于 `~/.local/share/agent-observatory/agent-knowledge/content.json`。

先在源码目录执行 `npm run build` 并单独准备用户自己的配置和凭证。**dry-run 不操作文件、网络或 launchd；真正安装和卸载均需要显式 `--apply`。**

```sh
node --experimental-strip-types scripts/install-macos-service.ts --config /path/to/reviewed-config.json --dry-run
node --experimental-strip-types scripts/install-macos-service.ts --uninstall --dry-run
# 仅在确认影响后手动执行：
node --experimental-strip-types scripts/install-macos-service.ts --config /path/to/reviewed-config.json --apply
node --experimental-strip-types scripts/install-macos-service.ts --uninstall --apply
```

- 默认路径：state/log `~/.local/share/agent-observatory/agent-journal/`（0700）；plist `~/Library/LaunchAgents/local.agent-observatory.agent-journal.plist`（0600）。自定义 `--config`、`--state-dir`、凭证路径和配置中的 database / output_directory 可指向真实数据，需在 apply 前自行核实。
- 密钥文件：`content.token`（Trace，0600）、`deepseek.key`（模型 key，0600；安装时缺失且环境有 `DEEPSEEK_API_KEY` 则由其创建，不打印值）。
- 日志：`run.log|err`（0600）；wrapper 每步追加 ISO 时间戳 header。成功与租约冲突（`FOLLOW_LOCKED`，视为良性）都不写 `run.err`，避免 launchd 错误日志误报。
- 单实例：SQLite 租约；并发 run 以 `FOLLOW_LOCKED` 退出，wrapper 记日志后按成功（退出 0）结束。
- 失败：permanent/config 不重试并退出 1；transient 按 `--retries`（默认 1）以 30s/120s 退避重试；失败不覆盖已有日报（`dream` 先写临时文件再 rename，且只更新目标日）。
- 可选 Knowledge 文件 source：追加 `--knowledge-source <id> --knowledge-config <path>` 会在 journal 成功后执行独立的 `agent-knowledge sync`；`run` 自身不调用 Knowledge。
- 补日及休眠唤醒：旧版本常规 run 仅处理单日；连续漏日与唤醒补跑尚需实现和验证，不保证自动补齐。历史环境曾安装、kickstart，但不能代表这个隔离的新服务已经安装或验证。

## 失败与安全

- 遵循 [consumer-follow 错误分类](../agent-trace/docs/consumer-follow.md)：transient 退避重试、permanent 停止并报告；`archive_id`/`trace_url`/视图变化 → 暂停，不静默归零。
- 不读 Trace/Knowledge/Stats 的数据库；不读宿主原始日志；不读 `content_ref` 指向的文件（除非显式开启并校验路径/字节/SHA-256）。
- 云模型是新增外泄面：默认只发送确定性投影（用户请求/最终答复/工具名/路径），不发送工具输出、reasoning 全文或 `content_ref` 正文；密钥只从 env 读取，不写配置/日志/产物。
- 日志与产物不含 token、密钥、完整工具输出；敏感路径过滤沿用 Trace 的命名规则。
- 日报是**工具/模型生成的二手摘要**，不是原始事实；引用必须能回到会话/事件。

## 验收状态

交接清单见 [项目路线图](../../docs/ROADMAP.md)。

- [x] **协议一致性**：[protocol fixtures](../agent-trace/fixtures/protocol/README.md) 已接入 `tests/page.test.ts`；有效页接受，16 个无效页全部 permanent 拒绝。
- [x] **合成 Trace E2E**：`tests/sync.test.ts` / `tests/dream.test.ts` 覆盖分页、重启续传、租约、删除墓碑、幂等重跑、宽限、回补策略与 413 缩页。
- [x] **真实数据对照**：2026-11-14 单日复跑，59 会话 / 22,362 事件 / 43,110 tokens 上界，与 P0 骨架一致（107,130 字符 vs 108,256 字符）。
- [x] **幂等与 revision**：同一内容重跑 `skipped`，`--force` 或输入变化才递增 revision；删除后重算。
- [x] **模型（J1b）**：mock HTTP provider + fake map/reduce 覆盖请求格式、错误分类、预算裁剪、输出校验、幂等与失败记录。
- [x] **真实 provider 单日**：2026-11-14 用 `deepseek-flash` 生成真实日报，17 次调用 / 138,674 tokens / 3m47s；重跑 skipped。
- [ ] **真实 provider 三天核对**：再用 2–3 天确认质量、成本与失败重试。
- [x] **独立 Trace 客户端（J1c 1.1）**：`agent-journal` content 客户端 + `~/.local/share/agent-journal/content.token`（0600）；服务重启后新 token `/v1/status` 200、Knowledge 旧 token 仍 200、匿名 401；新 token `sync` 增量 597 事件；缺 token 报 `TOKEN_MISSING`。
- [x] **launchd 安装器（J1c 1.2）**：`local.agent-journal` 06:30 / `RunAtLoad` false；`--dry-run`/`--uninstall`、wrapper 注入 0600 token/key、日志 0600、租约冲突良性。2026-11-15 安装并 kickstart 验证（证据见 [项目路线图](../../docs/ROADMAP.md)）。
- [ ] **launchd 连续两天自动日报**：待 2026-11-16、11-17 自然 06:30 运行观测（或等价证据）。
- [x] **文档与边界**：workspace README、NAMING、TODO、Trace 消费方文档与本 README 已更新；未实测项保持标记。

## 路线图

- **J1a（已完成，2026-11-15）**：`sync` + 确定性投影 + 无模型 Markdown + `run`/`dream`/`status` + 真实单日验证。
- **J1b（模型已完成，2026-11-15）**：OpenAI 兼容 provider、map/reduce、预算裁剪、模型输出校验、`--no-model`、50 项测试。
- **J1c（进行中；1.1/1.2 已完成 2026-11-15）**：独立 Trace 客户端与 token、launchd 06:30 安装器已安装并 kickstart 验证；待连续两天自然运行、真实 provider 三天核对、map 缓存/重试，以及 J2 的 Knowledge 索引（`generated: true`）。
- **J2**：日报按主会话/子代理归组；周报/月报；Knowledge 索引（`generated: true`）。
- **J3**：跨天整合（借 Claude Code autoDream 的四阶段与门控思路）：去重、消矛盾、把明确的决策/偏好/lesson 作为候选写入 Knowledge（依赖 Knowledge 的 `record_memory` / `record_feedback`，尚未实现）。

## 参考

- [历史报告未复制，见迁移说明](../../docs/MIGRATION.md)：真实单日规模、投影压缩率、成本、发现的 10 类数据问题。
- [Protocol v1](../agent-trace/docs/protocol.md)、[本机 API](../agent-trace/docs/local-api.md)、[消费方 follow 约定](../agent-trace/docs/consumer-follow.md)。
- [Protocol conformance fixtures](../agent-trace/fixtures/protocol/README.md)：4 个有效页 + 16 个无效页 + manifest + generator。
- [项目路线图](../../docs/ROADMAP.md)：J1c 交接（独立 token、launchd、三天质量、map 缓存）。
- 工作区 [TODO.md](../../docs/ROADMAP.md) 与 [统一命名说明](../../docs/NAMING.md)。
