# Agent Trace · 共享执行归档

Agent Trace 是可选日志采集与执行证据归档模块：读取 Codex、pi 与 DeepSeek Harness（`dsh`）已经写入的会话日志，把原生记录标准化为统一事件，保存到本地 SQLite，再通过批次文件或本机只读 API 向消费方提供 metadata / content 两种视图。它不安装 hook、不调用模型、不联网，也不重新执行日志中的工具；默认不导入用户历史，只有显式配置的来源才会被采集。

Trace 是工具集的默认可选数据源，不是其他模块的安装依赖。工具集总览见[根 README](../../README.md)，命名与目录规则见[命名说明](../../docs/NAMING.md)。

当前链路：**明确选择的 Codex / pi / dsh 会话 → 本地归档 → metadata / content 批次导出或本机只读分页 API → 消费方独立续读**。

- `metadata`：结构字段、最多 80 字符的请求标题、来源定位与用量，供 Agent Stats 统计。
- `content`：用户请求、回答、工具参数与输出、可见推理摘要和计划，供 Agent Knowledge 证据检索与 Agent Journal 日报。
- 两种模式使用不同数据库与捕获模式，各自维护独立消费游标，不能混用。
- dsh 当前日志是拼接的 Zstandard 帧（`session.vN.jsonl.zstd`），Trace 在导入时解码为逻辑 JSONL；源行号与 `record_hash` 指向解码后的追加顺序。

## 文档

完整入口见[文档索引](docs/README.md)。按需要阅读[架构说明](docs/architecture.md)、[服务配置](docs/service-config.md)、[本机只读 API](docs/local-api.md)、[消费方 follow 约定](docs/consumer-follow.md)、[v1 数据协议](docs/protocol.md)、[正文归档](docs/content-capture.md)与[使用与排错](docs/usage.md)。仓库级信息见[架构](../../docs/ARCHITECTURE.md)、[开发指南](../../docs/DEVELOPMENT.md)、[安全说明](../../docs/SAFETY.md)与[当前待办](../../TODO.md)。

## 运行

要求 Node.js **24.15.0+**。源码模式使用 Node 的 TypeScript 支持和内置 SQLite，无运行时第三方依赖；发行包使用编译后的 JavaScript 入口 `dist/cli.js`，避免 Node 对依赖目录内 TypeScript 的限制。`npm run build` 生成该入口，`npm pack` 前会自动构建。开发检查：

```sh
npm ci
npm run check
```

以下源码模式命令在模块源码目录执行；`npm run cli` 需要源码，不适用于已安装的 tgz。发行包包含合成 `fixtures/codex/demo.jsonl`，可复制到用户可写目录后再用已安装的 `agent-trace ingest` 导入；CLI 与数据库工作目录不要设在 node_modules。先运行合成示例：

```sh
npm run cli -- ingest --source fixtures/codex --instance demo-device --project demo --capture content --db .agent-trace/demo.sqlite
npm run cli -- status --db .agent-trace/demo.sqlite
npm run cli -- export --db .agent-trace/demo.sqlite --view metadata --limit 10000 --output .agent-trace/stats-page-1.json
npm run cli -- export --db .agent-trace/demo.sqlite --view content --limit 10000 --output .agent-trace/evidence-page-1.json
```

导出文件以 `0600` 权限新建，已存在则拒绝覆盖，为独立快照。消费方成功导入后保存回执中的 `cursor`，下一次导出把它作为 `--after`；`has_more=true` 时继续取页，即使没有新源文件也要取完。不要把一方的游标用于另一方。相同文件再次导入、移入归档目录或复制后导入都不会重复写入。

默认数据文件是 `.agent-trace/trace.sqlite`；仅当新默认库不存在且旧 `.agent-archive/archive.sqlite` 存在时才回退到旧库，显式 `--db` 始终优先。

## 常驻服务

`serve` 在前台运行扫描调度和/或本机只读 API，直到 SIGINT/SIGTERM。它在建库前校验配置，启动时检查来源目录、数据库捕获模式和采集租约；状态与扫描事件以 NDJSON 输出到 stdout，不含 token、正文或原始对象。

```sh
npm run cli -- config-check --config path/to/service.json
npm run cli -- serve --config path/to/service.json
npm run cli -- serve --config path/to/service.json --db path/to/other.sqlite
npm run cli -- reingest --config path/to/service.json
```

配置要求见[服务配置](docs/service-config.md)，API 授权与错误见[本机只读 API](docs/local-api.md)。示例配置默认关闭采集与 API；启用真实来源、正文和网络前必须显式替换路径、`capture_mode` 与 token 摘要。采集与 API 都关闭时 `serve` 拒绝启动。

`reingest` 重读采集器已导入的文件，为之后才出现在源文件里的记录补录事件（例如 dsh 的 `session.title` 会话名修订）；它需要单归档采集租约，须先停止 `serve`，重复执行保持幂等。它不能重算已归档事件的负载：适配器语义变化时归档会记录旧 `normalizer_version`，写入与 `serve` 以 `PROJECTION_MISMATCH` 拒绝，必须按[协议](docs/protocol.md#投影版本与归档升级)重建新归档并重建消费方数据库，而不是重导同一文件。`status` 报告归档版本与当前构建期望版本。

采集按配置来源扫描 `.jsonl`、`.jsonl.zstd` 与 `.jsonl.zst`（后两者为 dsh）：首次 `backfill=none` 只记录基线，之后新文件或变化文件整文件重读并按事件身份去重；`backfill=all` 首次即导入当前文件。归档前按会话 `cwd` 匹配项目，未知或歧义项目跳过并在状态中计数；给来源设置 `unmatched_project_id` 可把未命中会话归入兜底项目，实现全量采集。单归档只允许一个采集租约；崩溃后租约过期可接管，重启会从已提交归档和扫描状态继续。

一份配置对应一个归档数据库和一种 `capture_mode`。不要用同一份配置启动两个采集进程；API-only 可设置 `collection.enabled=false`。需要同时保留 metadata 与 content 时，使用两份配置、两个数据库启动两个 `serve`（例如 metadata 用 `8766`，content 用 `8767`）。它们不是重复进程：前者供 Stats 统计，后者只采集选定正文并供 Knowledge 同步与按需正文查看。不同数据库的采集进程可以同时运行；同一数据库仍只允许一个采集租约。

## macOS 常驻（content 采集）

**安全提示：安装器仅存在于源码仓库，不包含在 npm 发行包中。** 它使用隔离标签 `local.agent-observatory.trace-content` 与 `local.agent-observatory.knowledge-follow`，不操作其他服务标签；默认状态、配置与 token 位于 `~/.local/share/agent-observatory/agent-trace/` 和 `~/.local/share/agent-observatory/agent-knowledge/`，不会自动回退到其他配置。安装或卸载均必须显式 `--apply`；`--dry-run` 只输出计划，不读取配置或令牌、不调用 launchctl。两者互斥。

```sh
npm run install:content -- --dry-run
npm run install:content -- --apply  # 明确确认并准备隔离配置后才运行
npm run install:content -- --uninstall --apply
```

安装器不会替用户启用采集：配置必须已是 `capture_mode: "content"` 且 `collection.enabled=true`；实际安装会停止对应隔离服务、对所选配置执行 blob gc 并启动服务。**显式传入其他生产配置会操作该配置指向的数据，不受标签隔离保护**；请先确认数据库、blob 路径、token 及服务归属。详见[正文归档](docs/content-capture.md#常驻运行macos-launchd)。

## 身份、项目与来源

本模块不根据目录名猜测身份：`--instance` 标识来源设备或运行环境，`--project` 是统一项目标识；同一会话的项目绑定固定。采集器重新读取所选文件，按事件身份去重，不是基于字节偏移的 tail 守护进程。Codex / pi 源文件必须是完整 LF / CRLF 分行的 JSONL，未结束的尾行等待下次导入；dsh 源文件是拼接 Zstandard 帧，完整帧先归档，未写完的最后一帧标记为 pending。完整坏行或原位置内容变化使该文件整次导入失败。单文件上限 128 MiB，来源文件数上限 10000，不跟随符号链接。

## 消费方

Agent Stats 只消费 metadata，保留原有用量算法，不保存工具参数、返回正文或推理正文。归档拥有的会话不会被旧的直接日志刷新覆盖或复活；项目过滤继续使用原 `cwd`，项目显示名称使用归档的 `project_id`。在 Agent Stats 目录执行：

```sh
python3 -m agent_stats --db .agent-stats/shared-demo.sqlite import-archive --input ../agent-trace/.agent-trace/stats-page-1.json
python3 -m agent_stats --db .agent-stats/shared-demo.sqlite summary
python3 -m agent_stats --db .agent-stats/shared-demo.sqlite serve --archive-only
```

Agent Knowledge 消费 content，把归档证据投影保存在 `<knowledge database>.archive-evidence.sqlite`，与活跃知识记录分开，查询不依赖原日志仍在磁盘。在 Agent Knowledge 目录执行（先完成该项目的 `npm ci`）：

```sh
npm run cli -- archive-import --input ../agent-trace/.agent-trace/evidence-page-1.json --config agent-knowledge.example.json
npm run cli -- archive-search --query 幂等键 --project demo --config agent-knowledge.example.json
npm run cli -- archive-read --archive ARCHIVE_ID --event EVENT_ID --project demo --config agent-knowledge.example.json
```

按搜索结果的 `archive_id` 与 `event.event_id` 读取原始证据；MCP 提供只读 `search_archive`、`read_archive_event`。执行中的 agent 声明与工具结果属于待核实证据，不是已确认经验。

Agent Journal 是第三个 content 消费方：按本地日拉取增量并生成日报 Markdown。它有独立的 content 客户端、token 与游标，不读取上述两个消费方的数据库，也不由 Trace 执行其命令或模型调用。详见[项目文档](../agent-journal/README.md)。

Stats 与 Knowledge 都可以用 `follow` 常驻 worker 主动拉取 Trace API；Stats 侧 `follow` 是唯一写入者，看板只读统计库，Knowledge 只运行 content `follow`，CLI / MCP 按需读取。详见[消费方 follow 约定](docs/consumer-follow.md)。

## 内容与删除

新数据库默认 `metadata` 捕获，仅保存结构字段、最多 80 字符的请求标题与来源定位；这些字段仍可能敏感。需要正文证据时，针对明确选定的来源，在新建数据库时显式使用 `--capture content`。捕获模式建立后不可静默切换。

content 会保存用户请求、回答、工具参数和输出、可见推理摘要、计划与最终回答；不包含隐藏推理。进入归档前会脱敏常见凭据形态与敏感 JSON 字段，并把超大字符串外置为带 `bytes` / `sha256` 的 `content_ref` 文件，不静默截断。脱敏是启发式保护，不承诺发现所有散落密钥。metadata 导出固定剔除 `body` / `raw`。原始 `record_hash` 基于源行字节；消费方保留该来源声明，但批次只携带解析且已脱敏的对象，不能凭其重算原始行哈希。content 使用独立数据库与 blob 目录，步骤见[正文归档](docs/content-capture.md)。

```sh
npm run cli -- delete-session --runtime codex --instance demo-device --session archive-demo-session --db .agent-trace/demo.sqlite
```

删除会清除该会话的捕获事件并追加删除标记，提交后清理其引用的 blob。消费方必须继续消费到该标记才能清除自己的投影；旧页重试不会复活数据。已经导出的 JSON、备份和额外文件副本需单独清理。采集器拒绝静默重新导入已删除会话。详见[协议与可靠性约定](docs/protocol.md)。

## 验证

在模块目录或仓库根执行以下命令；两者都只使用临时目录与合成会话，不读取用户日志、不接触正式数据库：

```sh
npm run verify:consumers  # 合成 Trace → Stats / Knowledge：独立分页、重复导入、正文隔离、删除传播
npm run verify:follow     # 临时回环服务与两个真实 follow worker：续读、独立停机/重启、游标恢复
```

`verify:consumers` 需要 Agent Stats 与 Agent Knowledge 的依赖已就绪；`verify:follow` 可用 `AGENT_STATS_DIR` / `AGENT_KNOWLEDGE_DIR` 指向其他 worktree。二者是人工跨项目验收，不进入本模块 CI。

## 已知限制

- 导出流尚无按项目授权过滤；消费方必须被授权读取页内所有项目，否则整页拒绝。授权范围较窄时使用单独归档库，不要手工删页内事件并保留全局游标。
- 只监听回环地址，不提供多用户认证、浏览器前端或 Inspector UI 集成。
- 不自动提取、验证或晋升经验；归档只是执行证据链。
- 消费进度、重试与租约由各消费方自己维护，Trace 不保存目标列表、投递队列或确认游标。
- 采集是整文件重读 + 事件身份去重，没有字节偏移 tail 或文件系统通知。

## 开发与贡献

开发检查、CI、敏感信息扫描与发布流程见[开发指南](../../docs/DEVELOPMENT.md)；安全边界见[安全说明](../../docs/SAFETY.md)；当前执行事项见[根 TODO](../../TODO.md)。所有改动通过 Pull Request，合并前在最新 `main` 上按根文档运行检查。
