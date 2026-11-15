# Agent Stats · Codex 首版

Python 3.9+ 后端无需第三方 Python 依赖；React 前端已附带构建产物，生产运行不需要 Node。原产品规格历史资料未包含在本副本；当前用法见[项目入口](../README.md)与[数据源指南](SOURCES.md)。

## 启动

自动同步已实现：Stats 自己跟随 Trace 的本机 API，不由 Trace 调用导入命令。`follow --config` 是独立的前台 worker，与看板可分别启停；`serve --archive-only` 是完整消费模式，启动和页面刷新都不访问 Codex 源日志。实施范围与遗留项见[工作区 TODO](../../../docs/ROADMAP.md)。

共享归档入口：`python3 -m agent_stats --db PATH import-archive --input metadata-page.json` 接收 agent-trace v1 批次，用于离线导入或显式重建。从 `--after 0` 导出，之后按导入结果的 `cursor` 继续；两个消费方页大小与游标独立。`has_more=true` 时继续取页。常规自动同步用 `follow`，看板用 `serve --archive-only` 读取消费后的统计库。不带 `--archive-only` 的 `/api/refresh` 仍是直接日志刷新，不承担共享归档采集。已接管会话不被直接刷新覆盖。删除标记消费后清除投影，旧导出文件与备份另行管理。

在项目根目录运行：

```bash
python3 -m agent_stats serve
```

打开 <http://127.0.0.1:8765/>。Ctrl+C 停止。启动时读取 `CODEX_HOME`（默认 `~/.codex`）下 `sessions`、`archived_sessions` 目录；页面“刷新采集”重新读取这些路径。不是实时跟随日志的监控服务。不会修改 Codex 配置或安装 hook，不调用模型/API，不需 API Key。

数据库默认 `~/.local/share/agent-stats/stats.sqlite3`，可通过 `AGENT_STATS_DB` 或全局 `--db` 指定。权限受限环境应显式指定可写路径：

```bash
python3 -m agent_stats --db .agent-stats/stats.sqlite3 serve --source ~/.codex/sessions --source ~/.codex/archived_sessions
```

`--source` 可重复，接受 JSONL 文件或目录。`--instance workstation` 为不同设备隔离来源身份；同一设备的活动/归档目录应使用同一 instance。显式传入 `--source` 会替换全部默认路径。`--port 8877` 可修改端口，仅绑定 IPv4 回环地址。`--archive-only`（`--no-import` 为别名）只消费已接收数据：启动和页面刷新都不读取 Codex 源日志。

## 自动跟随 Trace（可选）

Trace 侧先按[服务配置](../../agent-trace/docs/service-config.md)启动 `serve --config`，为 Stats 客户端只授权 `metadata` 视图，并生成 bearer token。明文 token 只放进环境变量。示例配置见 `agent-stats.follow.example.json`：

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

- 配置是严格 JSON，相对路径相对配置文件；未知键、非回环地址、越界页大小或 `max_backoff_seconds < idle_seconds` 都会拒绝启动。`--db` 可显式覆盖配置中的目标数据库（相对当前目录）。
- 固定 `metadata` 视图。启动先请求 `/v1/status` 校验协议与 `archive_id`，再按自身已提交游标请求 `/v1/events`。每页与游标在同一个本地事务提交；空页但游标前移同样提交。
- 同一目标库同一视图只允许一个 worker。第二个实例以 `FOLLOW_LOCKED` 退出（退出码 1）；持有者崩溃后租约过期或同机进程确认消失即可接管，接管从数据库游标继续。
- 临时错误（连接拒绝/超时/5xx/本地库 busy）按 `idle_seconds` 起指数退避，封顶 `max_backoff_seconds`；`429` 带 `Retry-After` 时取其与上限的较小值。永久错误（401、视图未授权、非法参数/游标、页过大、非法信封、`archive_id` 变化、身份冲突）停止该目标并以退出码 2 报告，不自动归零。
- stdout 为逐行 JSON（`follow.started/page/idle/error/state/stopped`），不输出 token、正文或原始事件。`Ctrl+C`/SIGTERM 不再取新页，等待当前事务结束并释放租约后以 0 退出。
- 归档身份变化、目标库重建或更换视图都是显式操作：重建目标库并从 0 回放，不要用同一库直接接收另一个归档；同名会话不会静默改写归属。
- 同步状态保存在目标库的 `follow_state`（身份、最近成功/错误、租约），业务游标仍在 `archive_cursors`；两者都能用 `sqlite3` 查询排错，但不要手工改写游标。
- 可选 `allowed_project_ids`（非空字符串数组，去重；项目 ID 精确匹配）把消费范围收窄为名单内项目：省略即全量（默认），写入后名单外事件在事务内跳过，不写统计投影也不是错误，游标照常前进；页面指纹仍按完整批次计算，重放同一页保持幂等。空数组/空字符串/非字符串值会拒绝启动；缩小范围不会清理已导入数据。`config-check --config PATH` 只解析校验配置并输出安全投影（含 `allowed_project_ids`，全量时为 `null`），不建库、不联网、不回显 token。
- 任务详情的正文范围仍由 Trace content 配置的项目集合决定，与 follow 的 `allowed_project_ids` 相互独立；两者不一致时统计已过滤、正文仍可读。

## macOS 登录自动启动（仅源码开发环境）

此副本使用隔离的 `local.agent-observatory.agent-stats`、`local.agent-observatory.agent-trace`、`local.agent-observatory.agent-stats-follow`，状态和配置默认位于 `~/.local/share/agent-observatory/`，看板端口默认 18765；不接管旧 `local.agent-*` 服务。**不得把旧服务当成此副本已部署的证明**。

```bash
python3 scripts/install-macos-service.py --dry-run  # 无文件或服务修改
# 审核计划并明确同意后，才添加 --apply 安装隔离的只读看板
python3 scripts/install-macos-service.py --apply
```

默认只安装 archive-only、`--no-content` 看板。可选 `--with-trace --apply` 前必须自行配置隔离目录下 `agent-trace/service.json`、`stats.follow.json` 与权限不宽于 0600 的 `stats.token`；安装前会验证全部配置、token、目标 plist 和节点依赖，follow 库必须是隔离看板库。若任何前置校验失败则不会启动任何服务；实际安装阶段若系统失败，已安装的前序服务不会自动回滚，需检查并手工处理。token 会写入权限 0600 的 follow plist。现有旧服务和数据不会自动迁移。`--uninstall --dry-run` 可预览只影响隔离 labels 的卸载，`--uninstall --apply` 才执行，保留库和日志。安装与卸载会改变当前用户服务，运行前应获得明确授权。

## 合成演示

无需读取任何真实日志：

```bash
python3 -m agent_stats demo --output .agent-stats/demo
python3 -m agent_stats --db .agent-stats/demo.sqlite3 serve --source .agent-stats/demo
```

演示时间固定为 2026-10-22 至 2026-11-02，模型名为虚构标识。使用独立数据库，不与真实数据混合。重复生成会覆盖同名演示文件。

## 命令行与安装

```bash
python3 -m agent_stats --db .agent-stats/stats.sqlite3 import --source /path/to/rollouts
python3 -m agent_stats --db .agent-stats/stats.sqlite3 summary
python3 -m agent_stats --db .agent-stats/stats.sqlite3 summary --start 2026-11-01T00:00:00+08:00 --end 2026-11-02T00:00:00+08:00
```

时间筛选使用带时区 ISO 8601，半开区间 `[start,end)`，按轮次开始时间归窗。项目/模型精确匹配；未知维度保留未知，不按整个会话最后模型重分配轮次用量。

可选安装到虚拟环境（打包需要 setuptools/wheel；依赖解析可能需要网络）：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/agent-stats --help
```

无需安装也能使用全部功能。卸载时停止进程，执行 `pip uninstall agent-stats-local` 或移除虚拟环境。数据默认保留；删除指定 SQLite 文件及同名 `-wal`/`-shm` 文件可清除采集数据。删除源日志不会自动删除数据库里的已导入会话；需要彻底清理时停止服务并删除数据库，再重新导入。

## 页面与口径

- 总览：Token 已知小计、缓存读取与未缓存输入、缓存占输入和配对覆盖、有效样本、中位数/P90、每日趋势、模型构成。
- 会话：排序和筛选，查看逐轮用量、生命周期及工具元数据、来源定位。
- 来源与覆盖：接入能力、费用/请求数等未知指标的原因。

累计快照做差，重复事件不新增用量。模型或用量缺失时不猜测。费用按当前公开 API Standard 短上下文单价估算（USD），可展开总览的“估算依据与模型单价”查看价格核对日期、覆盖与假设；不是实际账单。父子包含关系未知时分开展示，不能把独立观测相加当作联合总量。具体降级与限制见 [Codex 接入能力表](CODEX-CAPABILITIES.md)。

`token_total` 仅在当前范围全部轮次有有效值时返回完整合计；`token_known` 是有效轮次的已知小计，无有效样本返回 null。已知父子会话同时在范围内、但包含关系不明时，两种联合金额均返回 null，各会话独立值仍可查。分位数使用 type 7 线性插值，只计算有效轮次，附有效/总样本数。分类快照跨缺失轮次时保持未知，不把补报全部归给当前轮次。

总览、模型分组和每日趋势另提供 `observed_token_total` / `observed_token_known`：各会话轮次观测值直接相加，未对父子包含关系去重。父子同时出现时，页面用“会话观测 Token”“各会话观测小计（未去重）”显示这些数字及分类，不能视为去重后的实际联合用量；缺失仍为 null，不补零。费用估算同样标明父子未去重；未知价格或分类仅保留未知并降低估算覆盖。精确请求数仍暂不提供。

`token_count` 中 `info: null` 且附有非空 `rate_limits` 的事件仅更新限额，不代表缺少用量，不触发累计快照警告。真正无有效累计值的用量记录仍会提醒；同一来源、同一问题仅显示一次，保留文件和行号定位。

缓存占输入按同批有效配对轮次的缓存读取总量 / 输入总量计算，标注配对覆盖；不是请求命中率。缓存列可排序，轮次详情展示未缓存输入及比例；会话详情的缓存汇总沿用当前时间和模型筛选。缺失分类不补零，零输入比例显示未知；父子观测仍明确未去重。来源提供缓存写入用量时另行展示，不混入读取比例。

## 本机 HTTP 接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/overview` | 同口径的 summary、sessions、turns、模型分组、UTC 每日趋势、coverage、warnings、last_import |
| `GET /api/session?id=...` | 指定带命名空间的会话及轮次、工具和事件定位 |
| `GET /api/session-content?id=...` | 按需只读 Trace 正文；可选 native `turn_id`、`after`（默认 0）、`limit`（默认 50，最多 100）；续页传回 `archive_id` 与 `revision`，已加载内容变更时返回 409 要求重载 |
| `GET /api/session-content/blob?id=...&event_id=...&pointer=...` | 读取当前会话事件 body 中 JSON pointer 指向的外置正文，校验固定目录、常规文件、大小与 SHA-256；不接受浏览器文件路径，最多 16 MiB |
| `GET /api/capabilities` | 接入能力与降级原因 |
| `POST /api/refresh` | Content-Type 必须为 application/json；请求体可用 `{}`；仅刷新服务启动时配置的路径 |

overview/session 接受 `start`、`end`、`project`、`model`、`source` 查询参数；项目与模型精确匹配，来源首版仅 codex。详情接收与总览相同的已归一化筛选范围；不存在身份返回 404，无效时间/窗口返回 400；不支持的接口返回 404。错误 JSON 为 `{"error":"说明"}`。没有 marker/compare 接口。

## 隐私与运行边界

任务详情可直接读取 Agent Trace 已脱敏的独立 content 归档；正文只作为 HTTP 响应返回，不写入 Stats 数据库，不依赖 Knowledge，不打开 Codex/pi 源日志。启动时默认发现 `~/.local/share/agent-trace/content.json`，可通过 `serve --content-config PATH` 或 `AGENT_STATS_CONTENT_CONFIG` 指定，`serve --no-content` 禁用。只读取配置中项目范围内的未删除会话；该正文范围由 Trace content 配置决定，与 follow 的 `allowed_project_ids` 消费范围相互独立。无配置、无正文或读取失败时明确提示，统计功能独立可用。

正文时间线通过“查看执行正文”加载，工具和推理摘要默认折叠，大文件另行按需读取；正文按文本展示，不执行 HTML 或命令。会话全文不随统计时间/模型筛选裁剪，轮次详情按原生轮次身份过滤。多 rollout 使用与统计重建相同的最新版本选择；无显式轮次身份时仅依据同一来源内的生命周期/context 推断，不按时间间隔猜测。单页正文最多 16 MiB；过大的单条记录/会话会明确拒绝，不静默截断。

只在本机解析指定 JSONL 并持久化统计元数据，不上传。会保存最多 80 字符的 Prompt 轮次摘要，用于轮次名称；不会保存完整 prompt、思考、命令、工具参数和输出正文；项目路径、事件身份和来源文件定位仍可能暴露工作信息。数据库和备份请按本机敏感数据管理。源日志自身的保存策略不由本工具改变。

损坏记录显示错误/覆盖影响，其余可读记录继续采集；采集与 Codex 进程完全独立，失败不阻断 Agent。本地 HTTP 拒绝不匹配 Host 和跨来源请求，没有远程访问功能。

## 开发验证

```bash
python3 -m unittest discover -s tests -v
npm --prefix frontend run check
npm --prefix frontend run build
```

架构：`codex.py` 解释来源 → `core.py` SQLite/统一查询 → `server.py` HTTP → React 组件展示。前端开发源在 `frontend/src/`，`agent_stats/static/` 为 Vite 构建结果；开发细节见 [前端说明](FRONTEND.md)。新增 harness 应实现规范化会话事实，不在界面复制统计逻辑。首版不含优化标记、自动费率、预算、跨设备同步或因果诊断。
