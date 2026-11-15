# 下一 session 交接：常驻采集与消费方主动拉取

更新时间：2026-11-15（Asia/Shanghai）。**本文件是交接待办。P0/P1、P2 Stats/Knowledge 与 pi 接入已完成；真实采集与多个 launchd 登录项（Stats 看板/follow、Trace metadata、Trace content、Knowledge follow、Agent Journal）正在本机运行；P3 的长期真实宿主、故障矩阵与独立审查尚未完成。正文归档的保护机制已实现，合成测试、一次性真实试点与**常驻采集**（launchd 登录项：Trace content + Knowledge follow + Agent Journal）均已完成；试点发现的两条缺陷均已修（孤儿 blob + `gc`、脱敏过匹配）；仍需天级长跑与真实故障演练。**

## 目标与已确认决策

让 Agent Trace 常驻采集 Codex 日志并提供只读事件 API；Agent Stats、Agent Knowledge 各自在自己的项目中实现自动拉取。用户启动相应进程后，无需手工导出或导入批次。

- [x] 项目名称固定为 `agent-trace`、`agent-stats`、`agent-knowledge`，见 [命名规范](NAMING.md)。
- [x] 本阶段不用 hook。
- [x] 消费方主动拉取，Trace 不维护两个目标的投递状态、不调用它们的导入命令。
- [x] 保留 v1 协议、稳定事件身份、独立数据库/游标和原有手动 CLI。
- [x] 本阶段不做自动经验提取、新 UI、团队服务（pi 与 dsh 已在后续阶段接入）。
- [x] 方案已写入 [常驻采集与主动拉取设计](agent-trace/docs/continuous-collection.md)。

## 当前代码基线

| 项目 | 已有实现 | 本阶段缺口 |
| --- | --- | --- |
| Trace | Codex 手动采集、SQLite 归档、metadata/content 导出、删除标记；P1 常驻扫描、项目匹配、单归档租约/心跳、只读 HTTP API、优雅停止；pi 会话适配（可选 `runtime`）；dsh 拼接 Zstandard 会话与 v0/v4 事件适配；content 模式脱敏、外置大输出与独立库配置；已做一次性真实 content 回补试点 | 按项目过滤流、长期真实宿主验收、网络/超时矩阵、content 常驻启用 |
| Stats | 文件批次导入、事务游标、元数据统计、HTTP 看板；`follow` worker + `serve --archive-only`；pi 记录成本与 `cost_basis`；看板 Agent 来源筛选；本机已用真实 Codex/pi 日志切换正式看板 | 长期运行/网络故障矩阵、reviewer 审查 |
| Knowledge | 文件批次导入、事务游标、项目授权、证据搜索/读取、MCP；pi 归档兼容；`follow` 自动拉取、单 worker 租约、退避/状态 | 长期真实宿主验收、故障矩阵、reviewer 审查 |

之前最近一次代码验证：Trace 8 项、Stats 80 项、Knowledge 40 项，共 128 项通过；跨项目合成消费验证和 Trace 包安装布局验证通过。P0 完成后 Trace 增至 20 项（配置/API 契约）。P1 后 Trace 为 32 项测试。

2026-11-14 复跑基线（三项目工作区均干净）：Trace `npm run check` 32 项通过、Stats `python3 -m unittest discover -s tests` 80 项通过、Knowledge `npm run check` 40 项通过，合计 **152 项全绿**。P2 Stats 侧完成后 Stats 101 项；真实数据上线阶段又修复了 Trace 的多身份折叠、revision 选择与标题捕获，当时 Trace **44 项**、Stats **105 项**，三项目合计 **189 项**（Knowledge 仍 40）。pi 接入与命名兜底后的最新基线见下。

P1 已合入 `agent-trace` main：`4cd8487 feat(trace): resident collection and read-only local API`（32 项测试在 main 上复跑通过），工作分支 `feat/continuous-collection` 与其 worktree 已删除。

P2 Stats 侧已通过 PR 合入 GitHub `agent-stat` main：PR #1（<https://github.com/dixiaoshai/agent-stat/pull/1>），合并提交 `d7b20c4`，功能提交 `e3bfee4 feat: follow agent-trace metadata with archive-only dashboard`（101 项测试在 main 上复跑通过）。远程功能分支已删除，本地 main 已快进同步。

2026-11-14 真实数据上线修复已推送 GitHub：Trace [PR #2](https://github.com/dixiaoshai/agent-trace/pull/2)（`d4f94bc`，44 项测试），Stats [PR #14](https://github.com/dixiaoshai/agent-stat/pull/14)（`f9e8209`，105 项测试，CI 通过）。内容：多身份折叠、`source.series`、会话标题、revision winner，以及 archive-only 安装器。两仓库本地 main 已与 origin/main 同步。

pi 接入三仓库均已合并：Trace [PR #3](https://github.com/dixiaoshai/agent-trace/pull/3)（`81cd1c0`）与命名兜底 [PR #4](https://github.com/dixiaoshai/agent-trace/pull/4)（`ca78bed`），Stats [PR #17](https://github.com/dixiaoshai/agent-stat/pull/17)（`d6dbfb6`，其后 #18 文档、#19 看板 Agent 筛选），Knowledge [PR #1](https://github.com/dixiaoshai/agent-knowledge/pull/1)（`facd1d5`，远程功能分支已删除）。当时主线：Trace `ca78bed`、Stats `e517953`、Knowledge `0244428`。

2026-11-14 基线复跑：Trace `npm run check` **51 项**、Stats `python3 -m unittest discover -s tests` **109 项**、Knowledge `npm run check` **41 项**，合计 **201 项全绿**。

2026-11-14 正文归档实现后基线：Trace `npm run check` **57 项**、Stats **109 项**、Knowledge `npm run check` **42 项**，合计 **208 项全绿**；`npm run verify:consumers` 与 content 示例 `config-check` 通过。

2026-11-14 P2 Knowledge follow 完成后基线：Trace 57 项、Stats 109 项、Knowledge **57 项**，合计 **223 项全绿**；新增 `npm run verify:follow` 真实进程端到端通过（Trace `serve` + 两个真实 worker，临时目录/合成日志）。

P2 Knowledge follow 与 follow E2E 已合入 GitHub main：Knowledge [PR #4](https://github.com/dixiaoshai/agent-knowledge/pull/4)（合并提交 `af9ddc8`，功能提交 `aaf3479`，57 项测试），Trace [PR #7](https://github.com/dixiaoshai/agent-trace/pull/7)（合并提交 `9cc7e05`，功能提交 `d18aa3a`）。两仓库 CI（Node 24.15.0、敏感信息扫描、CI success）通过；远程功能分支与 worktree 已删除，main 工作区已同步并复跑：Trace 57、Stats 109、Knowledge 57，`verify:consumers`/`verify:follow` 均通过。

正文归档已通过 PR 合入 GitHub main：Trace [PR #5](https://github.com/dixiaoshai/agent-trace/pull/5)（合并提交 `4add933`，功能提交 `c8c5a2e`，57 项测试），Knowledge [PR #2](https://github.com/dixiaoshai/agent-knowledge/pull/2)（合并提交 `62502c4`，功能提交 `99ea750`，42 项测试）。远程功能分支与本地 worktree 均已删除，两个 main 工作区已快进同步。

## 阅读入口与修改位置

1. [工作区入口](README.md)、[命名/迁移规范](NAMING.md)。
2. [目标设计](agent-trace/docs/continuous-collection.md)、[现有架构](agent-trace/docs/architecture.md)、[v1 协议](agent-trace/docs/protocol.md)、[正文归档](agent-trace/docs/content-capture.md)。
3. Trace：[CLI](agent-trace/src/cli.ts)、[归档与分页](agent-trace/src/store.ts)、[Codex 标准化](agent-trace/src/codex.ts)、[数据库路径兼容](agent-trace/src/paths.ts)。
4. Stats：[批次消费](agent-stats/agent_stats/archive.py)、[Store](agent-stats/agent_stats/core.py)、[CLI](agent-stats/agent_stats/cli.py)、[HTTP/刷新](agent-stats/agent_stats/server.py)。
5. Knowledge：[批次证据消费](agent-knowledge/src/archive/index.ts)、[follow worker](agent-knowledge/src/follow/worker.ts)、[follow 配置](agent-knowledge/src/follow/config.ts)、[CLI](agent-knowledge/src/interfaces/cli.ts)、[MCP](agent-knowledge/src/interfaces/mcp.ts)、[组合入口](agent-knowledge/src/bootstrap.ts)。
6. [既有跨项目验证脚本](agent-trace/scripts/verify-consumers.ts)与三项目 tests，原验证脚本应保留。

## P0：先定接口与配置

- [x] 为 Trace 增加可校验的服务配置：数据库、捕获模式、回环地址/端口、明确来源、实例、项目与 cwd allowlist、历史回补策略、扫描间隔。实现见 `agent-trace/src/config.ts` 与 `config-check`。
- [x] 明确相对路径相对配置文件，保留默认数据库与旧配置兼容，不静默移动存量数据。数据库/来源/cwd 均按配置目录解析；省略数据库时沿用 `.agent-trace` 优先、旧 `.agent-archive` 回退。
- [x] 固定 `GET /v1/events?after=&limit=&view=` 返回现有 v1 Batch；固定 `GET /v1/status` 的归档身份、高水位和采集状态。契约与请求/状态类型见 `agent-trace/src/api.ts`、`docs/local-api.md`；服务端仍属 P1。
- [x] 明确本机 API 的客户端/视图访问策略、Host/Origin、参数和大小边界；Stats 只拉 metadata，Knowledge 只拉获授权的 content。固定为回环监听、必须 bearer token、token 摘要存配置、Host/Origin 校验、每页最多 1000 事件/32 MiB。
- [x] 约定两个消费方自己的 follow 配置、前台启动方式、状态输出及错误分类。命令固定为 `agent-stats follow --config`、`agent-knowledge follow --config`，见 `docs/consumer-follow.md`。
- [x] 进度只在消费方数据库中维护；不新增 Trace 端目标列表、ack API 或投递队列。配置、API 和 follow 契约均未引入确认接口或投递状态。

P0 完成记录（2026-11-14）：`npm run check` 通过，类型检查、20 项测试与 JavaScript 构建成功。新增覆盖配置严格校验与默认/旧库兼容、相对路径解析、项目/cwd 匹配、token 摘要与视图授权、Host/Origin、查询边界、错误映射、状态信封、`config-check` 无副作用及示例配置可用性。未实现 `serve`、扫描调度、HTTP 监听或消费方 worker；未读取真实历史、未启用采集、未修改全局配置。P0 契约尚未由独立 reviewer 审查，P1/P2 完成后按验收要求补审。

## P1：Trace 常驻采集与 API

- [x] 新增前台 `serve --config PATH`，调度扫描新文件和变化文件，复用归档去重逻辑。实现见 `src/service.ts`、`src/collector.ts`、`src/server.ts`。
- [x] 归档前按会话 metadata.cwd 匹配配置项目，避免日期目录包含多个项目时越界采集或错误归属；未知项目跳过并可观察。`importFile` 接受项目解析器，在同一解析快照内按 cwd 选项目。
- [x] 优先整文件重读+稳定去重，不先做字节偏移 tail；检查点只能在归档提交后推进。扫描器按设备/ino、大小、mtime/ctime 判断变化。
- [x] 保留半行等待、完整坏行回滚、文件移动去重、来源重写冲突和删除防复活；单来源失败不停止全部来源。
- [x] 单归档有效采集实例控制、任务不重入、运行心跳、停止信号和资源清理。SQLite `collection_lease` + 心跳续租，SIGINT/SIGTERM 优雅停止。
- [x] HTTP 复用 `exportBatch`，GET 不修改消费进度。非法/越界请求明确报错；metadata 无正文泄漏；页上限 32 MiB。
- [x] 保留既有 ingest/export/read/delete-session/status；状态扩展区分归档静态身份、进程心跳、最近扫描和来源错误。

P1 完成记录（2026-11-14）：`npm run check` 通过，类型检查、32 项测试和 JavaScript 构建成功。新增覆盖：`backfill none/all`、项目/cwd 匹配与配置修正重试、半行等待、坏行与重写冲突回滚、移动/复制去重、超大来源文件、删除防复活、单来源失败隔离、租约竞争/过期/任务不重入、HTTP 认证/Host/Origin/视图/游标/参数/字节上限、status 心跳字段、API-only 模式、SIGTERM 停止与租约释放。测试全部使用临时数据库、回环地址和合成日志；未读取用户真实历史，未启动真实采集，未启用看板/MCP 链路。P1 尚未由未参与实现的 reviewer 独立审查；P2/P3 未完成。

## P2：两个项目分别自动拉取（可并行）

### Agent Stats

- [x] 新增独立 follow worker，从自身库读取游标、请求 metadata 页、复用 `import_batch` 原子提交统计与游标。实现见 `agent_stats/follow.py`；游标仍在 `archive_cursors`，另建 `follow_state` 记录身份、健康与租约。
- [x] 加同步来源配置、同目标并发保护、请求超时、空闲等待、临时错误退避、永久错误停止与清晰状态。`agent-stats.follow.example.json`；租约 30 秒、每 10 秒续租，同机死进程可立即接管；退出码 0/1/2 与 NDJSON 事件按 `docs/consumer-follow.md`。
- [x] 增加明确的 Trace 消费模式；在此模式下启动和 `/api/refresh` 均不访问 Codex 源日志，刷新只读取已接收数据。`serve --archive-only`；刷新返回 `mode=archive_only` 的 0 导入报告并提示未读源日志。
- [x] 旧直接采集模式保留兼容；`--no-import` 已收紧。不带 `--archive-only`/`--no-import` 的 `serve` 行为不变。
- [x] 修正 `--no-import` 语义：现在是 `--archive-only` 的别名，启动与刷新都不读源日志。
- [x] 看板与 worker 可独立启停，使用同一统计投影时并发查询可见性与事务正确。测试：写入期间 `GET /api/overview` 连续 200；真实 Trace 烟测中 archive-only 看板读到 11/12 会话。

P2 Stats 完成记录（2026-11-14）：Stats 全套 101 项通过（新增 21 项）；与真实 `agent-trace serve --config` 做合成烟测：12 会话 / 30 轮 / 336,000 Token 与手动 `export`+`import-archive` 逐项一致；`delete-session` 墓碑跨重启生效且不重放；统计库中无工具参数/输出正文。验证记录见 `agent-stats/docs/VALIDATION.md`。尚未覆盖真实 Codex 宿主、DNS 断网/连接重置、429 Retry-After 与 32 MiB 页上限；Stats 侧未由未参与实现的 reviewer 独立审查。运行中的看板进程仍是本次改动前启动的旧代码（仍为默认直接采集模式），重启后才具备 `--archive-only`。
- 真实数据上线（2026-11-14）：按真实 `~/.codex` 重建归档后，逐会话对比切换前备份，122/123 会话 Token 完全一致；唯一差异来自源文件在两次导入之间被 Codex 改写，用当前文件做全新直接导入得到相同新值（数据漂移，非逻辑差异）。会话标题全部保留，另有 2 个旧会话从空项目名变为 Trace 项目名。详见 `agent-stats/docs/VALIDATION.md`。

### Agent Knowledge

- [x] 新增独立 follow worker，从自身证据库读取游标、请求 content 页、复用 `importBatch` 事务提交。（`src/follow/`；游标仍在 `archive_evidence_cursors`，`archive_follow_state` 记录绑定、健康与租约。）
- [x] owner/project 授权不放宽，来源引用与 body/raw 缺失语义不变；不同视图不混用。（视图固定 `content`，`importBatch` 继续执行 owner/project 与 `content_ref` 校验。）
- [x] worker 与 MCP 生命周期分离，MCP 客户端断开不停止拉取。（`follow` 只打开证据库与回环 HTTP，不启动 MCP 或知识库。）
- [x] 增加与 Stats 同等级的超时/退避/实例保护/状态报告；MCP 与同步并发读写可用。（30 秒租约/10 秒续租、`FOLLOW_LOCKED`/死进程接管、指数退避 + `Retry-After`、NDJSON 状态/退出码；并发读取测试通过。）
- [x] 只更新证据投影，不添加模型调用或把历史声明升级为确认知识。（无模型调用；证据库与知识库仍分离。）

P2 Knowledge 完成记录（2026-11-14）：新增 `src/follow/{config,client,worker,errors}.ts` 与 `follow --config` 命令；证据库新增 `archive_follow_state`（绑定/健康/租约），业务游标仍由 `importBatch` 与证据同事务提交。严格配置（回环 URL、token 环境变量、页大小/空闲/超时/退避边界、未知键拒绝）、`/v1/status` 探针绑定 `archive_id`、content 视图校验、分页校验（顺序/范围/空洞/信封）、单 worker 30 秒租约（10 秒续租、死进程接管）、transient 指数退避 + `Retry-After`、permanent 退出码 2、信号停止退出码 0、NDJSON 状态。`npm run check` **57 项**通过（新增 15 项 follow 测试），`agent-knowledge.follow.example.json` 可用。真实进程 E2E：`npm run verify:follow`（Trace `serve` + Stats `follow` + Knowledge `follow`）通过：追加自动到达、双向停止/重启补取、独立游标、Token/工具不重复、Knowledge 事件无重复。未覆盖真实 Codex/pi 长跑、真实网络中断/Trace 重启/租约过期矩阵、目标库重建交互与 reviewer 审查。
- 合并：Knowledge [PR #4](https://github.com/dixiaoshai/agent-knowledge/pull/4)（`af9ddc8`），Trace [PR #7](https://github.com/dixiaoshai/agent-trace/pull/7)（`9cc7e05`，E2E 脚本与文档）；CI 通过，worktree 已清理。

## P3：恢复、删除和故障处理

- [x] HTTP 失败、无效页或本地事务回滚后不推进游标；进程重启从本地已提交游标恢复。（Knowledge follow 覆盖 401/403/5xx/超时/拒绝连接、非法页、重复事件回滚与重启续读；Stats 已有同类回归。）
- [x] 分别停掉任意消费方，另一方和 Trace 继续工作；恢复后补取，不重复计数。（`npm run verify:follow`：双向停止/重启、Trace 继续 ingest/status、统计 Token/工具不重复、Knowledge 事件 ID 无重复。）
- [x] `archive_id` 变化、目标库重建、视图/来源变化时明确暂停或进入显式重建流程，不静默重置进度。（`ARCHIVE_CHANGED`/`TRACE_CHANGED`/`FOLLOW_STATE`/`VIEW_UNAVAILABLE` 永久暂停；目标库重建仍要求显式删除后从 0 回放，未提供自动重置。）
- [x] 删除期间旧页与墓碑的先后关系测试；消费到墓碑后清除投影，不能被旧页重试或直接日志刷新复活。（Knowledge/Stats 墓碑回归；旧页完整重试为幂等重放；Stats `serve --archive-only` 不读源日志。）
- [x] 序列空洞合法；高水位与游标差不是精确事件积压数量。（Knowledge 直接与 follow 测试覆盖空洞；协议与运行文档明确该差值不是积压数。）
- [x] 不实现按未确认消费进度自动清理 Trace 历史；保留策略单独明确，确保离线消费方仍可获得墓碑。（没有自动清理实现；文档保留策略与离线补取要求。）

P3 完成记录（2026-11-14）：合成/进程级覆盖 HTTP 失败、非法页、事务回滚、重启续读、独立停机补取、身份/视图变化暂停、墓碑与旧页重放、序列空洞、并发读写；`verify:follow` 验证两个真实 worker 与 Trace 的独立启停和补取。明确未做：真实 Codex/pi 长期同步、真实 DNS/断网/连接重置/Trace 重启/租约过期矩阵、目标库重建交互、blob 外置正文读取、reviewer 独立审查。Trace 不按未确认消费进度清理历史；保留策略仍需单独定义。

## 验收与完成条件

- [x] 使用临时目录和合成日志，启动 Trace 与两个真实 worker；追加日志后两侧自动更新，不手工搬批次。（`npm run verify:follow`，结果见 `agent-trace/docs/validation.md`。）
- [x] 覆盖完整行/半行、重启、新文件、移动、坏行、来源冲突、项目匹配和超限。（Trace collector/service/archive 测试；本轮 E2E 另覆盖追加与重启。）
- [x] 覆盖断网/超时/服务不可用、回滚前后退出、身份变化、双实例、独立游标和删除。（Knowledge/Stats follow 故障回归；`verify:follow` 覆盖独立游标与重启；Trace 测试覆盖采集侧半行/坏行/冲突。真实网络中断矩阵仍未实测。）
- [x] 验证 Stats 消费模式和页面刷新不会触碰原日志；metadata 无正文。（2026-11-14 已用合成数据验证；E2E 再次确认统计库无工具正文；见 `agent-stats/docs/VALIDATION.md` 的 P2 记录）
- [x] 验证 Knowledge 在 MCP 离线时继续拉取，查询并发可用，证据与知识分开。（follow 测试不启动 MCP；并发读取回归；`archive-mcp` 测试验证证据与确认知识分离。）
- [ ] 跑三项目现有检查并新增有意义的守护进程/API/worker 端到端测试；复杂实现由未参与实现的 reviewer 独立审查。（检查与 E2E 已完成：Trace 57、Stats 109、Knowledge 57，`verify:consumers`/`verify:follow` 通过；**reviewer 独立审查尚未执行**，因此保持未完成。）
- [x] 更新架构、运行说明、配置例子、停止方式、验证记录；未实测场景不标记完成。（Trace `consumer-follow`/`continuous-collection`/`validation`；Knowledge `running`/`architecture`/`validation`；新增两个 follow 示例配置。）

## 运行状态与数据边界

- 2026-11-14 已切换正式看板：三个 LaunchAgent 同时运行 —— `local.agent-trace`（回环 `127.0.0.1:18766`，库 `~/.local/share/agent-trace/trace.sqlite`）、`local.agent-stats-follow`（token 在 0600 plist）、`local.agent-stats`（`serve --archive-only`，`127.0.0.1:8765`）。Trace 采集 `~/.codex/sessions`、`~/.codex/archived_sessions` 与 `~/.pi/agent/sessions`（`runtime: pi`）；看板与 follow 都不打开这些源日志。Trace 由 launchd `KeepAlive` 托管，重启用 `launchctl kickstart -k gui/$(id -u)/local.agent-trace`，手工再起会因归档租约冲突以 `COLLECTION_LOCKED` 退出。
- 真实统计库 `~/.local/share/agent-stats/stats.sqlite3` 现为 162 会话（141 Codex + 21 pi）/ 768 轮 / 4,101 次工具调用 / 92 个有名称的会话（均为 Codex，21 个 pi 会话尚无名称）；切换前备份在 `stats.sqlite3.direct-backup-20261114`（0600）。回滚步骤见 `agent-stats/docs/RUNNING.md`。
- Trace 归档现有 27,916 个事件 / 111 个会话（Codex 90、pi 21），其中 Codex 由真实 `~/.codex` 的 163 个文件回填；14 个缺 cwd 的文件按数据问题跳过（`PROJECT_UNMATCHED`），51 个源文件已被删除的会话只保留在旧备份/现库历史行中。
- 已知数据漂移：`01a1ca78` 会话因源文件在两次导入之间被改写，Token 从 8,605,750 变为 8,674,460（6→8 轮）；当前文件的全新直接导入结果与归档一致，不是 Trace/Stats 逻辑差异。
- 测试使用临时库和合成资料，真实验证记录见 `agent-stats/docs/VALIDATION.md`。新增来源或项目前仍需明确日志范围、项目匹配、历史回补、正文模式、目标库和端口；实现阶段可先用合成配置推进，无需为此读取全量历史。
- 不新增 hook，不改全局 Codex 配置，不迁移/清空用户现有数据库。本机已用 `scripts/install-macos-service.py` 装三个 LaunchAgent（archive-only 看板 + Trace + follow，幂等，bootout 后等待卸载）；Knowledge 未接入当前聊天的 MCP。新机器仍应先明确日志范围、项目匹配、历史回补、目标库与端口再安装。
- 目录已经统一，外部旧绝对路径需按 NAMING 迁移。Knowledge 的旧 root 绑定可能触发 `SOURCE_CHANGED`；不要绕过校验或自动删除来源来“修复”。
- 三项目均为独立 Git 仓库。Stats：本地与 GitHub main 均为 `e517953`（PR #17/#18/#19 已合并，CI 绿）。Trace：本地与 GitHub main 均为 `9cc7e05`（PR #2/#3/#4/#5/#7 已合并，57 项测试，含 `verify:follow`）。Knowledge：本地与 GitHub main 均为 `af9ddc8`（PR #1 pi 归档兼容、PR #2 content_ref 兼容、PR #4 follow worker 已合并，57 项测试）。Stats 仓库的 dependabot 仍在持续合并前端依赖 PR，验证前先 `git fetch` 看 main 是否前移。接手先看状态，保留现有修改，不重置他人工作。
- 开发流程已切到 worktrunk + git worktree：`wt switch --create <branch>` 建分支工作区，各仓库 `.config/wt.toml` 定义了 `post-start`（复制 node_modules，reflink）/`pre-merge`（Trace 与 Knowledge 跑 `npm run check`，Stats 跑 unittest）。验证命令必须走 worktree，不要直接改 main 工作区。

## 正文归档（2026-11-14 保护机制 + 试点 + 常驻采集已启用）

目的：为执行复盘、证据检索和后续经验提炼保留正文。当前正式 Trace 归档使用 `metadata` 模式，消息、推理摘要和工具事件的 `body/raw` 均未保存。2026-11-14 已实现脱敏、外置大输出、独立 content 配置与消费方引用兼容，并用**一次性真实回补**完成试点（50 会话 / 17,086 事件；台账见 `agent-trace/docs/validation.md#正文归档真实试点2026-11-14`）。内容不入常驻采集：未装 LaunchAgent、未持续运行。

- [ ] 先以 `agent-trace`、`agent-stats`、`agent-knowledge` 三个项目试点，配置明确的 cwd 范围与历史回补策略，验证价值后再扩大范围。示例配置与文档已就绪（`agent-trace.content.example.json`、`agent-trace/docs/content-capture.md`）。2026-11-14 已按用户要求一次性试点：范围 = 三个项目 + 历史上错误拼写（`agent-stat`/`agent-knpwledge`/`knowrelay`）+ worktree + 父级 `plugins-workspace`（不含父目录时 `agent-trace` 项目回补为 0 会话，因为其会话都从父目录启动），回补 `all` 后即停止；常驻启用与范围扩大仍未决定。
- [x] 保存用户请求、补充要求与纠正、Agent 最终回答，以及源日志中可获取的过程更新、计划和推理摘要；不把摘要当作完整内部推理或执行事实。（2026-11-14：Codex `task_complete.last_agent_message` 新增为 `turn.completed` 正文；pi 终止轮次沿用已有回答事件。）
- [x] 保存脱敏后的工具参数、返回结果及源日志已有的退出码/错误信息；大型输出采用可核验的本地文件引用，保留来源与完整性信息，避免无提示截断。（2026-11-14：超过 `content.max_inline_bytes` 的字符串写入 `content_ref` 文件，带绝对路径/字节数/SHA-256；退出码与错误信息以源记录为准。）
- [x] 正文落库前增加密钥、授权头、token 等敏感字段的脱敏；覆盖 `body`、`raw`、外置输出与运行日志，避免原始记录绕过脱敏，并验证 metadata 导出仍不泄漏正文。（2026-11-14：`src/content.ts` 固定规则 + 结构化敏感键，`serve` 日志额外脱敏；metadata 仍固定 `body/raw=null`。）
- [x] 为 `content` 模式建立独立数据库与采集配置；归档模式建库后固定，不能通过修改现有 metadata 配置恢复历史正文。保持现有统计链路可用，明确新归档身份及消费方独立游标，避免重复计数。（2026-11-14：新增 `content` 配置与示例，建库模式仍固定并报 `CAPTURE_MODE`；正式 metadata 库与现有游标不变。）
- [x] 接入 Knowledge 的 content 证据消费、按项目检索与原文读取；记录先作为执行证据，自动经验提取和已确认知识晋升仍按后续阶段推进。（2026-11-14：Knowledge 接受并校验 `content_ref`，检索/读取/项目范围保持；外置正文读取按引用校验本地文件，不复制进知识库。）
- [x] 使用合成敏感样本验证脱敏、正文读取、大输出引用及删除传播，再验证三个试点项目的实际复盘效果；记录正文保留、清理与回滚方式。合成样本验证已完成（Trace 57 项、Knowledge 42 项测试）。2026-11-14 一次性真实试点：17,086 事件入库、Knowledge `follow` 全量拉取（17,086 行 = 17,086 个唯一 `event_id`），按项目检索 + `archive-read` 来源核对 + `content_ref` 读取均可用；metadata 视图仍 `body/raw=null`；重启同 archive_id 无重复；真实停机时 worker 记录 transient `CONNECTION_ERROR` 不退出并从游标续传。保留 30 天（至 2026-12-14），清理与回滚命令见 `agent-trace/docs/validation.md`（删除 `content-state/` 与 Knowledge 试点证据库即可，不动 metadata 库）。真实删除传播仍未做（合成已覆盖）。
- [x] 修脱敏过匹配（PR #11，`3ed5430`）：裸方案词后的值必须像凭据（含数字 / ≥12 位大小写混用 / ≥24 位带分隔符），显式 `Authorization:` 头仍严格；键值规则只匹配单数键名，`$`/`<`/`{`/`^`/`~` 开头的引用与占位符跳过。真实 87 个源文件上标记 2,030 → 1,165，逐条枚举少掉的 865 处全是散文、计数与占位符；保留值全是凭据形态。59 项测试通过。只影响新采集，历史事件保留旧标记。
- [x] 修孤儿 blob（PR #10）：导入器记录本次写出的 blob，在旧 revision、`SESSION_DELETED`、`SOURCE_CONFLICT`、存储/SQL 异常时删除未被已提交事件引用的部分；新增 `gc --config PATH [--dry-run]` 只回收 blob 目录内形如 `<event_id>-<sha256>.txt` 的未引用文件。新回归 2 项（59 项全绿）。真实库上回收了试点留下的 75 个孤儿（107 → 32 个文件，全部可校验）。
- [x] content 常驻（PR #10）：`scripts/install-content-service.ts`（`npm run install:content`）安装 `local.agent-trace-content` 与 `local.agent-knowledge-follow`，顺序为停止旧任务 → `config-check` → `gc` → bootstrap，支持 `--dry-run`（令牌 `<redacted>`）与 `--uninstall`。配置更名 `~/.local/share/agent-trace/content.json`/`content.token`、`~/.local/share/agent-knowledge/content.json`/`content.follow.json`，`backfill` 改 `none`，follow `idle_seconds=15`。本机已验证两个登录项运行、首轮扫描 334 事件、Knowledge 从 17,142 续到 17,488、`kickstart -k` 重启无重复、常驻期间 `gc` 孤儿为 0。保留期仍为手动（30 天，至 2026-12-14）。
- [ ] 天级长跑与故障演练：观察磁盘增长，做真实 `kill -9`/断电孤儿回收演练，确定定期 `gc` 节奏；README 与文档已写“长期运行建议定期 gc”，但未实测。
- [x] 合并 Trace PR #8（`docs/content-pilot-validation`，合并提交 `707442b`）、计数修正 PR #9（`fd99d0b`）、常驻采集 PR #10（`4963f14`）。远程分支与 worktree 已清理。仍需未参与实现者复审试点与常驻结论（与 P3 独立审查合并做）。

- [x] Agent Stats 任务详情展示正文（2026-11-14）：会话/轮次详情新增按需加载的执行时间线，展示用户请求、回复、最终回答、推理摘要、工具输入输出；工具与摘要默认折叠，支持来源证据、分页及外置正文完整性校验。直接只读 Trace content 库，不依赖 Knowledge，正文不写入统计库；未配置/未采集/不可用有明确提示。正文沿用统计的 rollout 版本选择，按时间与来源行排序；续页校验已加载前缀，归档改写时要求重载。后端 119 项、前端 21 项测试、构建和独立审查通过；真实正文页面/加载更多/375px 窄屏验证通过。正式看板 `127.0.0.1:8765` 已重启，新正文接口实测 200/available。

### 正文归档完成记录（2026-11-14）

- 实现：`agent-trace/src/content.ts` 固定脱敏规则（私钥、认证头、常见 API token、JWT、URL 凭据、键值/JSON 敏感字段、结构化敏感键），入库前作用于 `body`、`raw` 与标题；`serve` 的 NDJSON 事件在输出前再次脱敏。
- 大输出：超过 `content.max_inline_bytes`（默认 65536）的字符串写入内容寻址 blob（`0600`，目录 `0700`），以 `{content_ref:{path,bytes,sha256,media_type}}` 替换，`body/raw` 同步；不截断。会话删除与 revision 替换清理引用文件，事务回滚可能留下无引用文件。
- 配置：新增可选 `content.max_inline_bytes` / `content.blob_directory`，默认跟随数据库目录；示例 `agent-trace.content.example.json` 使用独立库、三个项目 allowlist 与 codex/pi 来源，采集与 API 默认关闭。
- 消费方：Stats metadata 链路不变；Knowledge 校验 `content_ref`（绝对路径、字节数、SHA-256、`text/plain`，且 `body` 与 `raw` 一致），仍按 owner/project 检索与读取。
- 验证：Trace 57 项、Stats 109 项、Knowledge 42 项通过；`npm run verify:consumers` 与 content 示例 `config-check` 通过。真实 Codex/pi 历史 content 试点、脱敏命中/误报评估、blob GC 与保留期、reviewer 审查当时均未执行；同日晚些时候完成了真实试点，结果见下节。
- 合并：Trace [PR #5](https://github.com/dixiaoshai/agent-trace/pull/5)（`4add933`）、Knowledge [PR #2](https://github.com/dixiaoshai/agent-knowledge/pull/2)（`62502c4`）；本地 main、origin/main 与两个 worktree 清理已完成。

### 正文归档真实试点记录（2026-11-14 晚）

- 决定：用户要求完成本节最后一项，因此执行一次性真实回补（非常驻）。库在 `~/.local/share/agent-trace/content-state/`，Knowledge 证据库在 `~/.local/share/agent-knowledge/pilot.sqlite.archive-evidence.sqlite`，四个配置/令牌文件均 `0600`；正式 metadata 库、Stats 库与三个 LaunchAgent 全程未动。
- 结果：50 会话 / 17,086 事件（agent-stats 17、agent-knowledge 10、plugins-workspace 23、agent-trace 0），86 个文件导入、103 个范围外跳过、0 错误；657 事件含脱敏标记（2,447 处），51 个 `content_ref`（32 个唯一文件、7.15 MB）全文校验通过。Knowledge `follow` 全量拉到 17,086 个唯一事件，按项目检索/读取与 `content_ref` 读取均可用；真实 Trace 停机时 worker 只报 transient `CONNECTION_ERROR`，恢复后续传无重复。
- 发现：① 散文误伤（`basic instructions` 被替为 `[REDACTED:credential]`，504 处 credential 标记约 418 处无认证上下文）；② 旧 revision 早退不清 blob（首次回补 107 个文件里 75 个无引用）；③ `agent-trace` 项目 0 会话，因其历史会话都从父目录启动；④ live pi 会话会被自身采集，回补期间事件计数持续增长。
- 台账：`agent-trace/docs/validation.md#正文归档真实试点2026-11-14`（本机）；PR 见 Trace [PR #8](https://github.com/dixiaoshai/agent-trace/pull/8)（仅文档）。具体后续项已列在本节顶部。

### 常驻 content 采集记录（2026-11-14）

- 服务：`local.agent-trace-content`（`serve --config ~/.local/share/agent-trace/content.json`，扫描 + 本机 API :18767）与 `local.agent-knowledge-follow`（Knowledge `follow`），均由 `npm run install:content` 安装，`RunAtLoad` + `KeepAlive`。日志：`~/.local/share/agent-trace/content.log|err`、`~/.local/share/agent-knowledge/follow.log|err`（`0600`）。
- 配置：原试点文件已更名为 `content.json` / `content.token` / `content.follow.json`（Knowledge 库改为 `content.sqlite*`），`backfill: "none"`，Knowledge follow `idle_seconds=15`。范围仍是三个项目 + 父级 `plugins-workspace`。
- 修复：导入器不再为被丢弃的 revision 留 blob；新增 `gc --config PATH [--dry-run]`，只删 blob 目录内形如 `<event_id>-<sha256>.txt` 的未引用文件。真实库回收 75 个孤儿（107 → 32 个文件），32 个引用全部通过字节数/SHA-256 校验。
- 验证：两个登录项 `state = running`；首轮 `files=190 imported=334 skipped=306 errors=0`；Knowledge 游标 17,142 → 17,488 无重复；`kickstart -k` 重启同 archive_id、无重复；常驻期间 `gc --dry-run` 孤儿 0；`content.err`/`follow.err` 为空。
- 台账：`agent-trace/docs/validation.md#常驻-content-采集2026-11-14`；Trace [PR #10](https://github.com/dixiaoshai/agent-trace/pull/10)（`4963f14`）。
- 待办：天级长跑与磁盘增长观察、真实 `kill -9` 孤儿回收演练、reviewer 复审。脱敏过匹配已在 PR #11（`3ed5430`）修复并重启服务生效。

## pi 接入（2026-11-14，已合并并在真实数据上线）

三个 PR 已合并入各自 main，本机真实 pi 会话也已通过 Trace → follow → Stats 跑通；但仍**未做全量 pi 历史与 fork/clone 样本的真实宿主验收**：

- Trace（PR #3 `9e67ce5` + 命名兜底 PR #4 `ca78bed`）：新增 `src/pi.ts`，把 pi session JSONL 映射为 v1 事件（合成轮次、请求级 usage、工具、记录成本、fork 身份）；来源配置新增可选 `runtime: auto|codex|pi`，`ingest --runtime` 可选，识别不一致报 `RUNTIME_MISMATCH`。PR #4 补会话命名兜底：无 `session_info` 名称时回退首条可读用户 prompt（单行、≤80 字符，与 pi 自身会话选择器一致）。`npm run check` 51 项通过。
- Stats（PR #17 `d6dbfb6`）：接受 `runtime=pi`，按事件 runtime 重建会话/父键，从 usage 取模型；费用优先用 pi 的 `cost_usd`/`cost_source`，新增 `cost_basis` 与 `recorded_cost*` 聚合，看板区分记录/估算；PR #19 让看板 Agent 来源筛选可切换。`python3 -m unittest discover -s tests` 109 项通过。
- Knowledge（PR #1 `aeacd40`）：内容消费允许 `source.series`、会话标题、记录成本字段，pi raw 不再按 Codex payload 形状校验。`npm run check` 41 项通过。
- 协议：`usage.snapshot` 新增可选 `cost_usd`（非负数字）与 `cost_source`（`provider|model_rates`）；不升 schema_version，三个消费方同批放宽。
- 真实数据：`~/.local/share/agent-trace/service.json` 已加入 `runtime: pi` 的 `~/.pi/agent/sessions` 来源；Trace 归档现有 21 个 pi 会话，Stats 看板可见同样 21 个会话。
- 待办：补 pi 的 follow 配置示例（通用 follow 已按 archive_id 工作）；滚动覆盖全量 pi 历史与 fork/clone 样本，做页面/筛选对照；确认 pi 成本口径与用户预期一致；未实测不标记真实宿主验收完成。
- 已知缺口（当前不回填）：命名兜底只对之后新采集或文件被追加的会话生效。collector 会跳过 size/mtime 未变的文件，`store.ts` 也只替换 `record_hash` 变化的行，因此正常化逻辑升级不会刷新既有 payload；库中 21 个 pi 会话仍显示「未命名会话」。回填需显式重建（Trace 侧重规范 + 消费方从 0 回放，或 Stats 侧从首轮 prompt 推导后重建投影），已按用户决定暂不做。

## Agent Journal（2026-11-15，J1a+J1b+J1c 1.1/1.2 已实现）

详细交接 / 下一步见 **[agent-journal/TODO.md](agent-journal/TODO.md)**（J1c 剩余：连续两天自然运行观察、三天质量核对、map 缓存；J2：Knowledge `generated: true` 索引）。

决策：次日出 D-1 终版（每天 06:30，宽限 6 小时）；云模型 API；Journal 独立实现窄版 pull（不复用 Knowledge 的 follow 代码，只共享协议与 conformance fixtures）；日报以 Markdown 文件交给 Knowledge 作为 source 索引（需要 source 级 `generated: true`，未实现）。详见 [agent-journal/README.md](agent-journal/README.md) 与 [P0 验证报告](journal-spike/REPORT.md)。

已完成（P0 预实现验证）：

- [x] 真实 content 归档单日切片（2026-11-14）：22,363 事件 / 59 会话 / 5 项目 / 15.9 MB 正文 → 108,256 字符（约 43,392 tokens 上界），压缩 99.3%。
- [x] HTTP content 全量回放验证：86 页 / 249.7 MB / 0 错误；确认日常必须靠 cursor 只拉增量。
- [x] 确定性投影规则与无模型 Markdown 骨架（`journal-spike/slice.mjs`）。
- [x] Protocol conformance fixtures 草案（`agent-trace/fixtures/protocol/`）：4 个有效页 + 16 个无效页 + manifest + generator；用 Knowledge 当前构建验证有效页导入/删除/读取、无效页全部 `INVALID_ARCHIVE` 拒绝。
- [x] 数据问题清单与设计修正：历史回补假日报、pi/dsh 最终答复位置、跨午夜、子代理归组、注入指令块、工具输出占比、`content_ref` 不读取等。

J1a（已完成 2026-11-15）：

- [x] `agent-journal` 骨架：严格配置、Trace 窄版 pull、SQLite cursor/租约/日缓冲、确定性投影。
- [x] `sync` / `dream --date` / `dream --today` / `run` / `status` / `config-check`；50 项测试通过（含 Trace protocol fixtures、合成 Trace E2E、mock provider 与 fake map/reduce）；J1c 1.2 后总数为 **58 项**。
- [x] 真实归档验证：2026-11-14，59 会话 / 22,362 事件 → 43,110 tokens 上界、107,130 字符、78 KB Markdown；重跑 skipped；`run` 增量 25 事件 7.5s。

J1b（模型已完成）+ J1c 1.1/1.2（2026-11-15 完成）：
- [x] 云模型 provider + 按会话 map / 跨会话 reduce；引用校验、幂等/revision、预算裁剪、usage 记录、`--no-model`。
- [x] 真实 provider 单日核对（2026-11-14，`deepseek-flash`，17 calls / 138,674 tokens / 3m47s）。
- [ ] 真实 provider 三天质量/成本核对。
- [x] 独立 Trace content 客户端与 token：Trace `api.clients` 新增 `agent-journal`；token 在 `~/.local/share/agent-journal/content.token`（0600），新 token `sync` 成功、旧 Knowledge token 未被 Journal 使用（备份 `content.json.bak-journal-20261115111245`）。
- [x] launchd 安装器 `scripts/install-macos-service.ts`（dry-run/uninstall/wrapper 注入 0600 token/key、日志 0600）；`npm run check` 58 项测试通过。
- [x] launchd `local.agent-journal`（06:30、`RunAtLoad` false）已安装并 kickstart 验证：`last exit code = 0`、日报 `skipped` 且 sha256 不变、租约冲突良性、401/断网失败不覆盖日报、日志无 token/key。
- [ ] 连续两天自然 06:30 运行（待 11-16/11-17 观察）与休眠唤醒真机实测。
- [ ] map 缓存/重试（reduce 失败不重复 map 计费，详见 `agent-journal/TODO.md` 1.4）。
- [ ] 与 Knowledge 的文件契约：source 目录 + `generated: true` 标记（Knowledge 侧改动，未实现）。
- [x] 测试：protocol fixtures 一致性、合成 Trace E2E、真实单日复跑、假 provider、launchd dry-run/wrapper。
- [x] 实现后补验收记录（`agent-journal/TODO.md` 6），不把未实测场景写进 README 或验证文档。

未实现/未验证：真实 provider 的三天质量与成本、launchd 连续两天自然运行与休眠唤醒、Knowledge 索引（`generated: true`）、map 缓存、跨天经验整合（J3）、Knowledge 的 `record_memory`/`record_feedback`、真实宿主长期运行。

## 项目范围解耦（2026-11-15）

目标：Trace 可采集任意项目/全部会话，Stats、Knowledge、Journal 各自配置“消费范围”，匹配不上就跳过而不是报错停摆。

已完成（代码 + live 配置 + 重启验证）：

- [x] Trace：每个 `collection.sources[]` 新增可选 `unmatched_project_id`。设置后 cwd 未命中任何 `cwd_allowlist`（或缺失/非法）的会话归入兜底项目，实现全量采集；已声明项目仍按最长路径匹配保留精确归属；歧义仍是配置错误。`sourceScopeHash` 包含该字段，启用后自动补采之前 unmatched 的文件。见 [service-config.md](agent-trace/docs/service-config.md#全量采集示例)。
- [x] Knowledge：`allowed_project_ids` 改为消费过滤，名单外事件（含删除标记）跳过、游标前进、不再 `FORBIDDEN`；显式查询名单外项目仍拒绝。见 [README](agent-knowledge/README.md)。
- [x] Journal：顶层 `projects` 改为消费过滤，名单外事件跳过、不再 `FORBIDDEN`；页面信封/cursor 语义不变。见 [README](agent-journal/README.md)。
- [x] Stats：`follow` 新增可选 `allowed_project_ids`（默认全量=既有行为），名单外事件跳过、游标前进；新增只读 `config-check`。见 [README](agent-stats/README.md)。
- [x] live 切换：`~/.local/share/agent-trace/service.json` 与 `content.json` 的 4 个来源均设 `unmatched_project_id: "unscoped"`，content `backfill: all`；备份 `*.bak-norestrict-20261115115305`。重启后 metadata 98 个、content 305 个 unmatched 文件全部补采，`unscoped` 会话出现。
- [x] 测试：Trace 67 项、Knowledge 58 项、Journal 61 项、Stats 124 项全部通过；`agent-knowledge` dist 已重建（launchd 使用 dist/interfaces/cli.js）。

未做：Trace 的“消费方按客户端过滤页面”（当前由消费方各自过滤）；Claude Code/Cursor 适配器；缩小范围后的历史数据清理/回填工具。

## 可粘贴给下一 session 的任务

本文档及目标设计已与三个已实现项目入口、Agent Journal 设计文档、现有批次协议和分页实现做一致性核对。P0/P1 与 P2 Stats 已实现并有合成测试；P2 Knowledge 与 P3 仍需实施。

> P0/P1 与 P2 Stats/Knowledge 已完成；Stats 已在真实数据上用 `follow` + `serve --archive-only` 正式运行（三 LaunchAgent），pi 适配也已合并在真实 pi 会话上跑通；正文归档的保护机制、合成验证、一次性真实试点（50 会话 / 17,086 事件）、常驻采集（两个 launchd 登录项）与两条缺陷修复（孤儿 blob + `gc`、脱敏过匹配）均已完成；仍需天级长跑与真实 `kill -9`/断电演练、reviewer 复审。P3 已补齐合成/进程级验证，剩余长期真实宿主、故障矩阵与独立审查。均已实现：Trace 服务配置校验、`/v1/events`/`/v1/status` 契约、授权/边界、常驻扫描、项目匹配、单归档租约/心跳、只读 HTTP API 与优雅停止；Stats 侧 `follow --config` 自动拉取、单 worker 租约、页+游标同事务、错误分类/退出码，以及 `serve --archive-only` 的完整消费模式（`--no-import` 已收紧为别名）；Knowledge `follow` 已实现并经真实进程 E2E 验证（`npm run verify:follow`）。见 `agent-trace/docs/{service-config,local-api,consumer-follow,content-capture,validation}.md` 和 `agent-stats/docs/{RUNNING,VALIDATION}.md`；Trace 59 项、Stats 109 项、Knowledge 57 项测试通过（含 content 常驻）。接着阅读工作区 `TODO.md`、`NAMING.md` 和 `agent-trace/docs/continuous-collection.md`；接下来优先做天级长跑与真实 `kill -9`/断电孤儿回收演练，并完成未参与实现的 reviewer 对脱敏规则、试点/常驻、follow/API/租约/删除链路的独立审查；之后再在真实 `agent-trace serve` + 两个 worker 上做断网/Trace 重启/租约过期与目标库重建演练。不要改全局配置；content 已改为全量采集（`unmatched_project_id` 兜底），各消费方用自身的项目范围收窄即可；hook 或自动经验提取暂不实现（pi 与 dsh 已完成，剩余真实宿主验收）。Agent Journal 已完成 J1a 确定性流水线 + J1b 云模型 map/reduce + J1c 1.1/1.2（独立 Trace 客户端与 token、launchd 06:30 安装器已安装并 kickstart 验证；58 项测试 + 真实单日验证），真实 provider 三天核对、连续两天自然运行观察与 Knowledge 索引未完成（单日真实 DeepSeek 日报已生成）。先读 `agent-journal/README.md` 与 `journal-spike/REPORT.md`。
