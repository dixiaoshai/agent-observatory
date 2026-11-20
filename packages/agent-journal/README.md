# Agent Journal · 每日回顾

Agent Journal 把 agent 的执行活动整理成**可追溯到会话和事件**的每日回顾。它默认消费 [agent-trace](../agent-trace/README.md) 的 content 归档，也可以离线导入自定义活动快照；日报是给人看的二手摘要，引用前须用其中的会话标识回查原始事件。

本文只描述当前实现。工具集入口见 [根 README](../../README.md)。

## 定位

- **按日回顾**：以本地时区自然日聚合工作，输出 Markdown 日报，回答“今天和 agent 一起做了什么、改了什么、卡在哪、接下来做什么”。
- **证据可回溯**：日报中的每个会话都带 `session_id`，可回到 Trace 归档或离线活动的原始来源中核对。
- **两种输入**：Trace content 归档（增量同步）或离线活动 JSON 快照（无需 Trace、token、网络和模型）。
- **可选模型**：配置 OpenAI 兼容模型时运行 map/reduce 总结；不配置或使用 `--no-model` 时只输出确定性骨架。
- **独立模块**：自己维护数据库、消费游标、租约和产物，不读 Trace、Knowledge、Stats 的数据库，也不读宿主原始日志。

## 数据流

```text
Codex / pi / dsh 会话日志
  └→ agent-trace（采集、脱敏、content_ref、删除墓碑、只读 API）
       └→ agent-journal sync（独立游标 / 租约 / 页校验）
            └→ 确定性投影 ─┬→ 确定性日报（--no-model）
                           └→ map/reduce 模型总结（可选）
                                └→ daily/YYYY-MM-DD.md

离线活动 JSON ── agent-journal import ──→ 同一 SQLite / 投影 / 日报

daily/ ── 文件集成 ──→ agent-knowledge 的 source 目录
```

- **Trace content 输入**：`sync` 只调用 `GET /v1/status` 和 `GET /v1/events?view=content`，不读 Trace 数据库，也不读宿主原始日志。共享协议与消费约定见 [Trace 协议](../agent-trace/docs/PROTOCOL.md)和[消费方接入与同步](../../docs/TRACE-CONSUMERS.md)。
- **离线活动输入**：`import` 读取完整追加式活动 JSON，适合没有 Trace 的环境；格式、限制与示例见[离线数据源](docs/SOURCES.md)。
- **产物**：Markdown 日报写入 `output_directory`；`--today` 只写预览。SQLite 保存游标、有界投影、日状态和运行记录。
- **Knowledge 集成**：只通过文件集成。日报写入目录后由 Knowledge 作为普通 source 索引；Knowledge 需要 source 级 `generated: true` 标记来区分模型生成物，该能力当前未实现，因此日报暂不应作为事实来源被索引。

## 命令

安装后使用 `agent-journal <command>`；源码目录可用 `node src/cli.ts <command>` 或 `npm run cli -- <command>`。要求 Node.js **24.15.0+**。

所有命令都接受 `--config PATH`；省略时依次读取环境变量 `AGENT_JOURNAL_CONFIG`、当前目录的 `agent-journal.example.json`。

| 命令 | 作用 |
| --- | --- |
| `config-check` | 校验配置并输出摘要；不建库、不联网，只报告 token 和模型 key 是否存在 |
| `verify-model` | 用配置的模型发一个最多 512 个输出 token 的 JSON 探测请求；不写日报、不建库 |
| `sync` | 从 Trace 拉取增量 content 页并提交游标 |
| `import --file PATH` | 导入离线活动 JSON 快照 |
| `dream` | 生成指定日期或当天预览的日报；使用 `--date` 时默认先 `sync` |
| `run` | `sync` + 生成前一天的正式日报（定时任务入口） |
| `status` | 输出本地事件、会话、日、运行计数，以及同步状态和 token 是否存在 |

```sh
agent-journal config-check --config ./agent-journal.json
agent-journal sync --config ./agent-journal.json
agent-journal import --config ./agent-journal.json --file ./activities.json

agent-journal dream --config ./agent-journal.json --date 2026-01-02
agent-journal dream --config ./agent-journal.json --date 2026-01-02 --no-sync --force
agent-journal dream --config ./agent-journal.json --today

agent-journal run --config ./agent-journal.json
agent-journal status --config ./agent-journal.json
agent-journal verify-model --config ./agent-journal.json
```

- `dream` 使用 `--date` 时默认先同步，`--no-sync` 跳过同步；`--date` 与 `--today` 互斥，省略时报错。
- `--today` 不执行同步，只基于已提交数据输出到 `preview/`，不写正式日记录，也不要求宽限期已到。
- `--force` 忽略输入未变化时的跳过逻辑并递增 revision。
- `--include-backfill` 显式纳入被判为历史回补的事件。
- `--no-model` 强制只输出确定性骨架。
- `run` 总是先同步，默认处理本地时区的**前一天**；`--date` 可指定其他日期。`run` 不会自动补齐连续漏掉的日期。
- `import` 需要 `--file`；离线导入仍要求配置中有语法有效的 `trace_url` 和 `token_env`，但导入过程不会使用它们。
- 每次命令输出一行 JSON 结果；出错时向 stderr 输出一行包含 `error.code` 和 `error.class` 的 JSON，并以退出码 1 结束。

### 定时调度

源码仓库提供 macOS launchd 安装器 `scripts/install-macos-service.ts`（不包含在 npm 安装包中）。默认标签为 `local.agent-observatory.agent-journal`，每天本地时间 06:30 运行，`RunAtLoad` 为 false，包装脚本读取 0600 的 token / key 文件后执行 `run`。

安装器默认不修改系统；`--dry-run` 只打印计划，安装和卸载都必须显式加 `--apply`。自定义的配置、数据库、输出目录和凭证路径可能指向真实数据，执行前应自行核对。

## 配置

配置文件是严格 JSON：未知字段会被拒绝，相对路径以配置文件所在目录为基准。可直接复制 `agent-journal.example.json`。

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

| 键 | 必填 / 默认 | 说明 |
| --- | --- | --- |
| `schema_version` | 必填，固定为 `1` | 配置版本 |
| `timezone` | 默认 `Asia/Shanghai` | IANA 时区；日窗口按它切分 |
| `database` | 默认 `./.agent-journal/journal.sqlite` | Journal 自己的 SQLite 路径 |
| `trace_url` | 必填 | 只能是带端口的回环 `http://` 地址，不能含路径、查询或凭据 |
| `token_env` | 必填 | 保存 Trace content token 的环境变量名；明文 token 不写配置 |
| `output_directory` | 默认 `./daily` | 日报输出目录 |
| `projects` | 必填，非空数组 | 消费范围；Trace 页中名单外的项目事件会被跳过，游标照常前进 |
| `page_size` | 默认 `500`，范围 1–1000 | 单页事件上限；实际取它与 Trace 服务端上限的较小值 |
| `finalize.grace_hours` | 默认 `6`，范围 0–72 | 宽限期；正式 finalize 需满足 `now >= 当日结束 + grace_hours` |
| `finalize.max_days_per_run` | 默认 `7`，范围 1–30 | 当前只做配置校验，不驱动自动补日 |
| `finalize.late_observed_hours` | 默认 `36`，范围 1–720 | 判定历史回补的迟到阈值 |
| `budget.max_input_tokens_per_day` | 默认 `120000`，范围 1,000–2,000,000 | 单日模型输入预算；超出时丢弃低优先会话 |
| `budget.max_output_tokens_per_day` | 默认 `10000`，范围 100–200,000 | 当前只做配置校验，未参与裁剪 |
| `model.provider` | 固定 `openai-compatible` | 模型协议 |
| `model.base_url` | 模型配置时必填 | 兼容 chat-completions 的 HTTP(S) 基地址 |
| `model.model` | 模型配置时必填 | 模型 id |
| `model.api_key_env` | 模型配置时必填 | 保存 API key 的环境变量名 |
| `model.timeout_seconds` | 默认 `60`，范围 1–600 | 单次请求超时 |
| `model.max_output_tokens` | 默认 `4000`，范围 1–65536 | 单次请求输出上限 |

- **Trace token**：只从 `token_env` 指定的环境变量读取，需由 Trace 实例显式授权 content 视图。不要复用 Knowledge 的 token。
- **模型密钥**：只从 `model.api_key_env` 指定的环境变量读取，不写入配置、日志或产物。默认只发送确定性投影，不发送工具输出、推理全文或 `content_ref` 正文。
- **`projects` 是消费范围，不是访问控制**：Trace 全量采集时可能返回名单外的 `project_id`（例如 `unscoped`）；Journal 会跳过这些事件并正常推进游标。真正能读到哪些数据由 Trace 侧的 client / view 授权决定。
- **模型端点**：当前只支持 OpenAI 兼容 API。若使用 DSH 订阅账号的 Messages 路由而非平台 API key，需要另行实现适配器，现有实现不能直接复用该账号。

## 存储与产物

Journal 使用自己的 SQLite（默认权限 0600）：

| 表 | 内容 |
| --- | --- |
| `sync_state` | `trace_url`、`archive_id`、视图、游标、最近尝试/成功/错误、单实例租约 |
| `pages` | 已提交页的区间与指纹，用于页重放幂等 |
| `events` | 有界投影：消息文本、工具名与参数路径、用量等；不存工具输出和 `raw` |
| `tombstones` | 已删除会话，阻止旧页把数据带回 |
| `days` | 日状态（`final` / `stale`）、revision、输入哈希、产物路径与哈希 |
| `runs` | 每次运行的模型、prompt 版本、输入/输出哈希、状态和用量汇总 |

产物目录（`output_directory`）：

- `YYYY-MM-DD.md`：正式日报。`generated: false` 表示确定性骨架，`generated: true` 表示模型总结。
- `preview/YYYY-MM-DD.md`：`--today` 预览，不写正式日记录。
- 目录按 0700、文件按 0600 创建；先写临时文件再 rename，不覆盖其他日期的产物。
- 日报 frontmatter 包含 `date`、`timezone`、`generated`、`generator`、`model`、`prompt_version`、`projects`、`sessions`、`events`、`projected_tokens`、`coverage`；模型日报另有 `dropped_sessions`。
- 当前只产出 Markdown，没有机读 JSON、目录索引或 Knowledge 索引文件。

正文结构：模型日报包含“今天做了什么 / 按项目 / 决策与变更 / 未完成或阻塞 / 明天建议 / 会话摘要 / 覆盖与限制”；确定性骨架按项目列出会话时间、事件计数、用户请求、最终答复、工具与触及路径。两种形态都保留会话标识供回查。

## 时间与覆盖语义

- **日窗口**：本地时区半开区间 `[00:00, 24:00)`，跨夏令时也按当地日历切分。
- **归属**：按事件 `occurred_at` 归属日期，不按会话开始时间或导入时间。
- **会话元数据**：标题、cwd、runtime 等按 `session_key` 在本地投影中回查；会话可能在前一晚开始，`session.started` 不一定在当天窗口内。
- **标题**：优先使用最新的非空 `session.title` 修订，没有修订时回退 `session.started` 快照或用户消息标题。
- **宽限**：正式 finalize 要求 `now >= 当日结束 + grace_hours`，降低最后一分钟会话尚未采集到的概率；`--today` 不受此限制。
- **重算**：输入摘要哈希变化时重算并递增 `revision`；输入和既有产物都没变时返回 `skipped`；`--force` 强制重算。
- **删除传播**：删除墓碑到达时把对应会话从投影中移除，并把相关日期标为 `stale`；下次生成会重算并只保留剩余会话，不会自动在日报中额外标注撤回。
- **历史回补**：缺少 `occurred_at`、`observed_at - occurred_at` 超过 `late_observed_hours`，或事件发生时间早于当日结束而观测时间晚于“当日结束 + 24 小时”的事件，默认只计入覆盖统计、不进入日报；需要时显式加 `--include-backfill`。
- **漏日**：`run` 只处理默认 D-1 或 `--date` 指定的一天，不自动遍历漏掉的日期。

## 确定性投影

先聚合、后模型。投影只包含会话标识、用户请求、最终答复、工具名与路径、用量，不包含工具输出、原始记录、推理全文或外置正文。

| 输入事件 | 处理 |
| --- | --- |
| `session.started` | 首次观测快照：cwd、runtime、cli_version |
| `session.title` | 采用最新非空修订；空修订不覆盖已知名称 |
| `message.user` | 最多 20 条、每条 1,200 字符；过滤 `# AGENTS.md instructions`、`<INSTRUCTIONS>`、`<environment_context>`、`<external_…>` 等注入块 |
| `turn.completed` | 最多 8 条、每条 1,500 字符，作为最终答复 |
| `message.assistant` | 没有 `turn.completed` 正文时回退最后 2 条、每条 800 字符，并标记来源 |
| `tool.called` | 只保留工具名和次数；从参数中提取绝对路径，过滤凭据/密钥类路径，每会话最多 40 条 |
| `tool.returned` | 只保留状态计数，不发送输出 |
| `usage.snapshot` | 每会话最后一次 cumulative、当天 `cost_usd` 求和与 `cost_source` |
| `reasoning.summary`、`source.unknown` | 只计数 |
| `content_ref` | 只计数，绝不读取指向的文件 |
| `session.deleted` | 从当日投影移除该会话，并把相关日期标为 `stale` |

投影按 `session_key` 独立汇总；`parent_session_id` / `forked_from_session_id` 只在协议校验层接受，当前不用于日报归组，子代理会话与主会话分别成节。

## 模型阶段

- **模型提供方**：OpenAI 兼容 `POST {base_url}/chat/completions`，Bearer 密钥只从 `api_key_env` 读取。401/403/400 归类为永久错误，429、5xx、超时归类为临时错误。
- **map**：按会话生成结构化摘要（`session_key`、summary、decisions、follow_ups）；按约 6k tokens 分批，大会话单独一批。
- **reduce**：跨会话合成日报 JSON：`highlights`、`projects`、`decisions`、`blockers`、`next_steps`、`session_notes`。
- **引用校验**：模型返回的 `session_key` 和 `project_id` 必须属于当天 bundle；未知或重复引用直接以 `MODEL_OUTPUT` 失败，不写日报，避免编造。
- **预算**：单日输入不超过 `budget.max_input_tokens_per_day`；超出时按会话体积选择、丢弃低优先会话，并在日报和运行记录中写 `dropped_sessions`。单次输出上限由 `model.max_output_tokens` 控制。
- **幂等**：输入摘要哈希覆盖日期、时区、窗口、归档 id、项目、运行时、会话投影、统计和覆盖计数；启用模型时还包含模型 id 和 prompt 版本。输入未变时重跑返回 `skipped`，`--force` 才递增 revision。
- **用量记录**：`runs.cost_json` 保存本次运行的调用次数、输入/输出/总 token、估算值和缺失用量的调用数；不保存提示词正文。
- **失败诊断**：兼容会先输出 `reasoning_content` 的模型；输出被截断（`finish_reason=length`）或没有文本时会报告 `finish_reason` 与 `message_keys`。示例配置给足 `max_output_tokens` 和 `timeout_seconds`。

模型实际收到的输入：

1. **map**：system 要求只依据输入、不编造、使用开发者请求的语言、返回固定 JSON；user 是 `{day, timezone, sessions:[...]}`，每个会话含 `session_key`、`project_id`、`runtime`、`title`、起止时间、`open_ended`、计数、用户消息、答复、工具名与次数、路径、`cost_usd`。
2. **reduce**：system 要求基于会话摘要和统计写日报；user 是 `{day, timezone, totals, project_stats, session_digests}`，不带原始消息。

**不会发给模型**：`tool.returned` 的工具输出、`raw`、推理摘要全文、`content_ref` 指向的外置正文、`source.unknown` 的具体内容、被预算丢弃的会话。

## 失败与安全

- **输入边界**：只通过 Trace 只读 API 读 content；不读 Trace / Knowledge / Stats 数据库，不读宿主原始日志，不读 `content_ref` 指向的文件。
- **错误分类**：配置和协议错误是永久错误，直接停止并报告；连接失败、超时、HTTP 408/429/5xx 是临时错误。`sync` 在单次命令内对临时错误最多尝试 3 次，退避 0.5s / 1s；macOS 包装脚本可对整次 `run` 再做 30s / 120s 重试。
- **来源变化**：`trace_url`、`archive_id` 或视图变化时以永久错误暂停，禁止静默把游标归零。
- **单实例**：SQLite 租约防止并发运行；另一个进程持锁时以 `FOLLOW_LOCKED` 退出。安装器把租约冲突视为良性（退出 0），避免 launchd 误报。
- **模型外泄面**：默认只发送确定性投影；密钥只从环境变量读取；日志和产物不含 token、密钥或完整工具输出。
- **写盘**：先写临时文件再 rename，权限 0600；只更新目标日期，模型失败不会覆盖已有日报。
- **二手摘要**：日报由工具或模型生成，不是原始事实；引用前用会话标识回查 Trace 或 Knowledge 事件。

## 限制

- 当前只支持 OpenAI 兼容 chat-completions；不支持 DSH 订阅账号的 Messages 路由。
- `finalize.max_days_per_run` 和 `budget.max_output_tokens_per_day` 目前只做配置校验，不驱动行为。
- 连续离线后的自动补日未实现；`run` 只处理一天，需要显式 `--date` 补写。
- 没有模型结果缓存、分阶段重试或断点续跑；`--force` 会重跑整日。
- 只产出 Markdown，没有机读 JSON、`INDEX.md` 或 Knowledge 索引。
- Knowledge 的 source 级 `generated: true` 标记未实现，日报暂不应作为已确认知识被索引。
- macOS 定时安装器只在源码仓库提供；npm 包不含 `scripts/install-macos-service.ts`。安装器只隔离默认路径，不会隔离用户显式指定的数据库、输出目录或上游服务。
- 面向本机单用户；没有多用户认证、团队共享或远程服务。

## 文档索引

- [离线数据源](docs/SOURCES.md)：活动快照格式、追加语义、独立运行示例。
- [合成协议 fixtures](tests/fixtures/README.md)：Journal 测试使用的 Trace 协议样例副本。
- [Trace 协议](../agent-trace/docs/PROTOCOL.md)、[消费方接入与同步](../../docs/TRACE-CONSUMERS.md)：共享的数据输入契约。
- 根文档：[架构](../../docs/ARCHITECTURE.md)、[开发指南](../../docs/DEVELOPMENT.md)、[安全说明](../../docs/SAFETY.md)、[命名规则](../../docs/NAMING.md)、[当前任务](../../TODO.md)。
