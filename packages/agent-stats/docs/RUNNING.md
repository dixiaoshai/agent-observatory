# Agent Stats 运行说明

Agent Stats 后端使用 Python 3.9+ 标准库，前端构建产物随 Python 包分发，生产运行不需要 Node。用法入口见[项目入口](../README.md)，输入契约见[数据源契约](SOURCES.md)。

## 启动

Stats 自己跟随 Agent Trace 的本机 API：`follow --config` 是独立的前台 worker，与看板可分别启停；看板用 `serve --archive-only` 只读已接收的统计库。Trace 不向 Stats 推送，也不管理 Stats 的游标。

共享归档入口：`python3 -m agent_stats --db PATH import-archive --input metadata-page.json` 接收 Agent Trace v1 metadata 批次，用于离线导入或显式重建。从 `--after 0` 导出，之后按导入结果的 `cursor` 继续；不同消费方的页大小与游标相互独立，`has_more=true` 时继续取页。常规自动同步用 `follow`；不带 `--archive-only` 的 `/api/refresh` 仍是直接日志刷新，不承担共享归档采集。已被共享归档接管的会话不会被直接刷新覆盖；删除标记消费后清除统计投影，旧导出文件与备份另行管理。

在 `packages/agent-stats/` 下运行：

```bash
python3 -m agent_stats serve
```

打开 <http://127.0.0.1:8765/>，`Ctrl+C` 停止。启动时读取 `CODEX_HOME`（默认 `~/.codex`）下的 `sessions`、`archived_sessions` 目录，页面“刷新采集”重新读取这些路径。它不是实时跟随日志的监控服务；不会修改 Codex 配置或安装 hook，不调用模型 / API，不需要 API Key。

数据库默认 `~/.local/share/agent-stats/stats.sqlite3`，可通过 `AGENT_STATS_DB` 或全局 `--db` 指定。权限受限环境应显式指定可写路径：

```bash
python3 -m agent_stats --db .agent-stats/stats.sqlite3 serve --source ~/.codex/sessions --source ~/.codex/archived_sessions
```

- `--source` 可重复，接受 JSONL 文件或目录；显式传入会替换全部默认路径。
- `--instance` 为不同设备隔离来源身份；同一设备的活动 / 归档目录应使用同一 instance。
- `--port` 可修改端口；服务仅绑定 IPv4 回环地址。
- `--archive-only`（别名 `--no-import`）只消费已接收数据：启动和页面刷新都不读取源日志，`POST /api/refresh` 返回 `mode=archive_only` 的说明报告。

## 自动跟随 Trace（可选）

Trace 侧先按[服务配置](../../agent-trace/docs/service-config.md)启动 `serve --config`，为 Stats 客户端只授权 `metadata` 视图，并生成 bearer token。明文 token 只放进环境变量。示例配置见 [agent-stats.follow.example.json](../agent-stats.follow.example.json)：

```json
{
  "schema_version": 1,
  "trace_url": "http://127.0.0.1:8766",
  "token_env": "AGENT_TRACE_STATS_TOKEN",
  "database": "./.agent-stats/stats.sqlite3",
  "page_size": 500,
  "idle_seconds": 15,
  "request_timeout_seconds": 20,
  "max_backoff_seconds": 300
}
```

```bash
export AGENT_TRACE_STATS_TOKEN=...      # 缺失即失败，不回退匿名
python3 -m agent_stats config-check --config agent-stats.follow.json   # 只校验配置：不建库、不联网、不回显 token
python3 -m agent_stats follow --config agent-stats.follow.json
# 另一个终端：看板只读已接收数据
python3 -m agent_stats --db .agent-stats/stats.sqlite3 serve --archive-only
```

- 配置是严格 JSON，相对路径相对配置文件。未知键、非回环地址、带路径或凭据的 URL、越界页大小、`max_backoff_seconds < idle_seconds` 都会拒绝启动；`--db` 可显式覆盖配置中的目标数据库（相对当前目录）。
- 固定 `metadata` 视图：启动先请求 `/v1/status` 校验协议版本、服务端页上限与 `archive_id`，再按自身已提交游标请求 `/v1/events`。每页与游标在同一个本地事务提交，空页但游标前移同样提交；重放同一页按页指纹保持幂等。
- 新版 Trace 宣告 `protocol.event_removals` 后，Stats 请求 `revisions=1`，同步会话改写中替换或移除的事件。旧 Trace 仍可同步追加和整会话删除，但不会完整传播改写。若已有旧版消费游标，升级时 follow 报 `REBUILD_REQUIRED`，不重置旧库；历史改写没有移除标记，不能继续使用旧投影。升级两端后，保留现有库，使用原配置和项目范围以 `follow --config PATH --db NEW_DB` 回放到一个新的空库，核对汇总后再让看板和 follow 都使用新库。已在新版模式消费的库不能切回旧 Trace。
- 同一目标库同一视图只允许一个 worker。租约 30 秒，等待期间每 10 秒续租；第二个实例以 `FOLLOW_LOCKED` 退出（退出码 1）。持有者崩溃后，租约过期或同机进程确认消失即可接管，接管从数据库游标继续。
- 临时错误（连接拒绝 / 超时 / 5xx / 本地库 busy）从 `idle_seconds` 起指数退避，封顶 `max_backoff_seconds`；`429` 带 `Retry-After` 时取其与上限的较小值。永久错误（401、视图未授权、非法参数 / 游标、页过大、非法信封、`archive_id` 变化、身份冲突）停止该目标并以退出码 2 报告，不自动归零。
- stdout 为逐行 NDJSON（`follow.started` / `follow.page` / `follow.idle` / `follow.error` / `follow.state` / `follow.stopped`），不输出 token、正文或原始事件；stderr 输出单行错误 JSON。`Ctrl+C` / SIGTERM 不再取新页，等待当前事务结束并释放租约后以 0 退出。
- 归档身份变化、目标库重建或更换视图都是显式操作：重建目标库并从 0 回放，不要用同一库直接接收另一个归档；同名会话不会静默改写归属。
- 同步状态保存在目标库的 `follow_state`（身份、最近成功 / 错误、租约），业务游标在 `archive_cursors`；两者都能用 `sqlite3` 查询排错，但不要手工改写游标。
- 可选 `allowed_project_ids`（非空字符串数组，去重；项目 ID 精确匹配）把消费范围收窄为名单内项目：省略即全量（默认），写入后名单外事件在事务内跳过，不写统计投影也不是错误，游标照常前进；页面指纹仍按完整批次计算，重放同一页保持幂等。空数组 / 空字符串 / 非字符串值会拒绝启动；缩小范围不会清理已导入数据。
- `config-check --config PATH` 只解析校验配置并输出安全投影（含 `allowed_project_ids`，全量时为 `null`），不建库、不联网、不回显 token。
- 任务详情的正文范围仍由 Trace content 配置的项目集合决定，与 follow 的 `allowed_project_ids` 相互独立；两者不一致时统计已过滤、正文仍可读。

## 工作区名称

Stats 的「工作区」不使用 Trace 的项目 ID；`allowed_project_ids` 仍按归档项目过滤，Stats 工作区筛选仍以完整 `cwd` 为准。

- **DSH**：对本机来源，按会话 ID 读取 DSH 的工作区标题（只读 `$DSH_HOME/storages/workspace.json` 的 v2 索引，默认 `DSH_HOME=~/.dsh`）。不读会话正文，不连接 DSH 服务。自定义存储后端、无法识别的格式或没有唯一归属时回退到启动目录名。
- **Codex**：本机归档优先使用 Codex 项目元数据（会话关联优先，其次是匹配的项目根目录）。本机名称查询仅适用于 `local` 实例及 `$CODEX_HOME`（默认 `~/.codex`）下的 `sessions` / `archived_sessions` 来源；DSH 同样只对 `local` 实例和 `$DSH_HOME/sessions` 下的来源查本机索引。
- **pi**：会话格式没有独立的工作区名称，使用启动目录名。其他来源无法读取原生名称时也使用启动目录名；没有目录则显示「未知工作区」。

默认只从归档中的 `cwd` 推导名称，不读取本机 Agent 索引。确认 Stats 库只接收受信任的本机归档后，可给 `serve` 或 `summary` 加 `--native-workspaces` 启用上述只读查询；不要对外部或混合来源的库启用，因为归档里的实例名和来源路径不能证明来源身份。启用后，原生改名只需重新加载页面，无需重导或改写归档。

## macOS 登录自动启动（源码开发工具）

源码安装器使用隔离的服务名、状态路径与端口，不接管其他服务：`local.agent-observatory.agent-stats`、`local.agent-observatory.agent-trace`、`local.agent-observatory.agent-stats-follow`，状态和配置默认位于 `~/.local/share/agent-observatory/`，看板端口默认 18765。

```bash
python3 scripts/install-macos-service.py --dry-run  # 只输出计划，无文件或服务修改
# 审阅计划并明确授权后，才添加 --apply 安装隔离的只读看板
python3 scripts/install-macos-service.py --apply
```

- 默认只安装 archive-only、`--no-content` 的看板，不安装 Trace。
- `--with-trace --apply` 前必须自行配置隔离目录下的 `agent-trace/service.json`、`stats.follow.json` 与权限不宽于 0600 的 `stats.token`；安装器验证全部配置、token、目标 plist 与 Node 依赖，follow 库必须是隔离看板库，Trace 必须启用 metadata 视图并授权该 token。token 通过环境变量写入 follow job，不写入日志。
- 任何前置校验失败都不会启动任何服务；实际安装阶段若系统失败，已安装的前序服务不会自动回滚，需检查并手工处理。
- `--uninstall --dry-run` 可预览只影响隔离 labels 的卸载，`--uninstall --apply` 才执行，保留数据库与日志。
- 受管路径检查会拒绝符号链接、待替换 plist 与异常文件类型，但属于尽力预检，不是对抗本地恶意进程的沙箱；检查后路径仍可能被并发替换。
- 安装器是源码开发工具，不是发行包 API，仅支持 macOS；安装与卸载会改变当前用户服务，运行前应获得明确授权，并先读[安装器安全说明](../../../docs/SAFETY.md)。

## 合成演示

无需读取任何真实日志：

```bash
python3 -m agent_stats demo --output .agent-stats/demo
python3 -m agent_stats --db .agent-stats/demo.sqlite3 serve --source .agent-stats/demo
```

演示时间固定为 2026-10-22 至 2026-11-02，模型名为虚构标识。使用独立数据库，不与真实数据混合；重复生成会覆盖同名演示文件。

## 命令行与安装

```bash
python3 -m agent_stats --db .agent-stats/stats.sqlite3 import --source /path/to/rollouts --instance workstation
python3 -m agent_stats --db .agent-stats/stats.sqlite3 summary
python3 -m agent_stats --db .agent-stats/stats.sqlite3 summary --start 2026-11-01T00:00:00+08:00 --end 2026-11-02T00:00:00+08:00
```

时间筛选使用带时区的 ISO 8601，半开区间 `[start,end)`，按轮次开始时间归窗；项目与模型精确匹配；未知维度保留未知，不按整个会话最后模型重分配轮次用量。

可选安装到虚拟环境（打 wheel 需要 pip、setuptools、wheel；依赖解析可能需要网络）：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/agent-stats --help
```

无需安装也能使用全部功能。卸载时停止进程，执行 `pip uninstall agent-stats` 或移除虚拟环境；数据默认保留。删除指定 SQLite 文件及同名 `-wal` / `-shm` 文件可清除采集数据；删除源日志不会自动删除数据库里的已导入会话，需要彻底清理时停止服务并删除数据库，再重新导入。

## 页面与口径

- **总览（Overview）**：Token 已知小计、缓存读取与未缓存输入、缓存占输入与配对覆盖、有效样本、中位数 / P90、每日趋势、模型构成、费用估算与消耗集中度。
- **各轮明细**：会话与轮次两种视角，支持搜索、排序、筛选、逐轮用量、生命周期与工具元数据、来源定位；任务详情可加载正文时间线。
- **来源与覆盖**：接入能力、费用 / 请求数等未知指标的原因。

统计口径：

- 累计快照做差，重复事件不新增用量；模型或用量缺失时不猜测。费用按 `agent_stats/pricing.py` 中当前公开 API 列表价估算（USD）：OpenAI 行取 Standard 短上下文价，DeepSeek 行列出 peak 价并按逐请求时间套用 off-peak 半价（中国法定节假日未还原，缺少请求时间时按 peak 上限）。可在总览展开“估算依据与模型单价”查看核对日期、来源、覆盖与假设；它不是实际账单。
- 有来源记录成本时（如 pi 在请求时记录的 `usage.cost.total`）优先使用记录成本，不按当前价目表重算；没有记录成本的来源按 API 等价单价估算。看板区分两种口径。
- `codex-auto-review` 没有公开列表价：仅当来源标记会话为账号范围（`account_scoped=true`）且轮次开始时间不早于 `2026-10-06T00:00:00Z` 时按免费规则显示 0（`cost_basis=free`、`cost_source=free_waiver`），其他情况保留未知。该标记来自 Codex `creator_account_id` 的布尔含义，也可能来自 Agent 身份 / PAT，日志无法区分登录方式；缺失表示未知，不按 API Key 处理。
- `token_total` 仅在当前范围全部轮次有有效值时返回完整合计；`token_known` 是有效轮次的已知小计，无有效样本返回 `null`。父子会话同时在范围内但包含关系不明时，联合金额返回 `null`，各会话独立值仍可查。
- `observed_token_total` / `observed_token_known` 是各会话轮次观测值的直接相加，未对父子包含关系去重；页面用“会话观测 Token”“各会话观测小计（未去重）”标注，不能视为实际联合用量。缺失仍为 `null`，不补零。
- 分位数使用 Hyndman-Fan type 7 线性插值，只计算有效轮次，并附有效 / 总样本数；工具字节数不换算 Token 或费用。
- 缓存占输入按同批有效配对轮次的缓存读取总量 / 输入总量计算，并标注配对覆盖；它是 Token 比例，不是请求命中率。缺失分类不补零，零输入时比例未知；缓存写入按来源字段单独展示，不混入读取比例。
- `token_count` 中 `info: null` 且带非空 `rate_limits` 的事件只更新限额，不代表缺少用量；真正无有效累计值的用量记录仍会提示，并保留文件与行号定位。
- 精确模型请求数不提供：消息数、Token 快照数、工具数都不等于模型请求数。

## 本机 HTTP 接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/overview` | 同口径的 summary、sessions、turns、模型分组、每日趋势、coverage、warnings、last_import；turns 只带 `tools_count` 与 `tool_output_bytes` 聚合 |
| `GET /api/session?id=...` | 指定带命名空间的会话及轮次、工具和事件定位；只读取目标会话及其直接父会话，不扫描整库 |
| `GET /api/session-content?id=...` | 按需只读 Trace 正文；可选 native `turn_id`、`after`（默认 0）、`limit`（默认 50，最多 100）；续页传回 `archive_id` 与 `revision`，已加载内容变更时返回 409 要求重载 |
| `GET /api/session-content/blob?id=...&event_id=...&pointer=...` | 读取当前会话事件 body 中 JSON pointer 指向的外置正文，校验固定目录、常规文件、大小与 SHA-256；不接受浏览器文件路径，最多 16 MiB |
| `GET /api/capabilities` | 接入能力与降级原因 |
| `POST /api/refresh` | Content-Type 必须为 `application/json`；请求体可用 `{}`；仅刷新服务启动时配置的路径 |

- overview / session 接受 `start`、`end`、`project`、`model`、`source` 查询参数；项目、模型与来源精确匹配，来源取会话的 `source` 值（原生 Codex 为 `codex`，Trace 适配为 `pi` / `dsh`，自定义来源为 provider 声明值）。详情接收与总览相同的已归一化筛选范围。
- overview 的 turns 不下发整轮的 `tools` / `evidence` / `usage_records` 数组，只给 `tools_count` 与 `tool_output_bytes`（所有工具输出大小都已观察时求和，否则为未知）；详情接口保留完整记录。
- `/api/overview` 的响应按筛选参数缓存在服务进程内（最多 8 份）；follow 导入或 `/api/refresh` 写入数据库文件后自动失效，数据未变时刷新页面不重复重算。响应仍为 `Cache-Control: no-store`，浏览器不缓存。
- 不存在身份返回 404；无效时间 / 窗口 / 参数返回 400；`/api/refresh` 非 JSON 返回 415、请求体过大返回 413；正文归档变更冲突返回 409；外部正文路径越界返回 403。
- 错误 JSON 为 `{"error":"说明"}`。静态资源只托管入口页与 `/assets/` 下带内容哈希的 JS / CSS；没有 marker / compare 等优化比对接口。

## 隐私与运行边界

- 只在本机解析指定 JSONL 并持久化统计元数据，不上传。保存最多 80 字符的 Prompt 轮次摘要用于轮次名称；不保存完整 prompt、思考、命令、工具参数和输出正文。
- 项目路径、事件身份、来源文件定位与摘要仍可能暴露工作信息；数据库按 0600、目录按 0700 创建，使用 DELETE journal 模式避免长期保留 WAL 侧文件。数据库和备份请按本机敏感数据管理；源日志自身的保存策略不由本工具改变。
- 正文下钻只读取显式配置的 Trace content 归档：不写统计库、不依赖 Knowledge、不打开 Codex / pi 源日志。只读取配置项目范围内的未删除会话；单页正文最多 16 MiB、外置正文最多 16 MiB、单个会话最多 128 MiB，超限明确拒绝而不静默截断。正文按文本展示，不执行 HTML、脚本或命令；推理摘要不是完整思考，工具返回不等于执行成功。
- HTTP 服务仅绑定 IPv4 回环地址，拒绝不匹配 Host 与跨来源请求，响应带 CSP 等安全头；没有远程访问功能。服务端访问日志不打印源路径、查询串或请求体。
- 损坏记录显示错误 / 覆盖影响，其余可读记录继续采集；采集与 Codex 进程完全独立，失败不阻断 Agent。未知指标保持未知。
- follow token 只从环境变量读取，不写入配置、日志或 stdout。

## 当前限制

- Codex、pi、dsh 的本机日志格式与版本相关，不是稳定公开 API；版本升级后需重新核对字段。
- 没有可靠的逐请求身份：不提供精确模型请求数、逐请求费用或实际账单；缓存写入、完整工具错误率等无法精确统计。
- 父子与分叉计量依赖可确认的来源身份；无法确认时只展示带标注的观测小计，不按时间猜测归属。
- 真实 Codex 宿主的长期运行、launchd 监督下的 follow、断网 / DNS / 429 / 超大分页与磁盘故障恢复未纳入自动验证。
- macOS 安装器的受管路径预检是尽力检查，不是完整沙箱；多服务安装不是全局事务，运行期失败不自动回滚已安装服务。
- 本模块是本地单用户工具，不提供远程访问、多用户认证、跨设备同步、预算控制或因果诊断；优化比对不在当前范围。
