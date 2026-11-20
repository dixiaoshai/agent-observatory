# Agent Trace · 共享执行归档

Agent Trace 是可选日志采集与执行证据归档模块：读取 Codex、pi 与 DeepSeek Harness（`dsh`）已经写入的会话日志，把原生记录标准化为统一事件，保存到本地 SQLite，再通过批次文件或本机只读 API 向消费方提供 metadata / content 两种视图。它不安装 hook、不调用模型、不联网，也不重新执行日志中的工具；默认不导入用户历史，只有显式配置的来源才会被采集。

Trace 可独立安装和使用，不是其他模块的安装依赖。

- `metadata`：结构字段、最多 80 字符的请求标题、来源定位与用量。
- `content`：用户请求、回答、工具参数与输出、可见推理摘要和计划。
- 捕获模式在建库时固定；导出视图不能补回未捕获的内容。
- dsh 当前日志是拼接的 Zstandard 帧（`session.vN.jsonl.zstd`），Trace 在导入时解码为逻辑 JSONL；源行号与 `record_hash` 指向解码后的追加顺序。

## 文档

Trace 的架构、命令、配置与协议见[文档索引](docs/README.md)。在源码仓库中，四模块分工见[整体架构](../../docs/ARCHITECTURE.md)，导入、持续同步与删除传播见[跨模块消费指南](../../docs/TRACE-CONSUMERS.md)。这些仓库级文档不随独立 npm 包发行。

## 运行

要求 Node.js **24.15.0+**。源码模式使用 Node 的 TypeScript 支持和内置 SQLite，无运行时第三方依赖；发行包使用编译后的 JavaScript 入口 `dist/cli.js`，避免 Node 对依赖目录内 TypeScript 的限制。`npm run build` 生成该入口，`npm pack` 前会自动构建。开发检查：

```sh
npm ci
npm run check
```

下面的命令在 Trace 源码目录执行。若使用 npm 发行包，将随包提供的 `fixtures/codex/demo.jsonl` 复制到用户可写目录，在该目录执行：把 `npm run cli --` 换成 `agent-trace`，并把 `--source fixtures/codex` 换成 `--source ./demo.jsonl`。不要在 `node_modules` 中创建数据库。

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

配置要求见[服务配置](docs/SERVICE-CONFIG.md)，API 授权与错误见[本机只读 API](docs/LOCAL-API.md)。示例配置默认关闭采集与 API；启用真实来源、正文和网络前必须显式替换路径、`capture_mode` 与 token 摘要。采集与 API 都关闭时 `serve` 拒绝启动。

`reingest` 重读采集器已导入的文件，为之后才出现在源文件里的记录补录事件（例如 dsh 的 `session.title` 会话名修订）；它需要单归档采集租约，须先停止 `serve`，重复执行保持幂等。它不能重算已归档事件的负载：适配器语义变化时归档会记录旧 `normalizer_version`，写入与 `serve` 以 `PROJECTION_MISMATCH` 拒绝，必须按[协议](docs/PROTOCOL.md#投影版本与归档升级)重建新归档并重建消费方数据库，而不是重导同一文件。`status` 报告归档版本与当前构建期望版本。

采集按配置来源扫描 `.jsonl`、`.jsonl.zstd` 与 `.jsonl.zst`（后两者为 dsh）：首次 `backfill=none` 只记录基线，之后新文件或变化文件整文件重读并按事件身份去重；`backfill=all` 首次即导入当前文件。归档前按会话 `cwd` 匹配项目，未知或歧义项目跳过并在状态中计数；给来源设置 `unmatched_project_id` 可把未命中会话归入兜底项目，实现全量采集。单归档只允许一个采集租约；崩溃后租约过期可接管，重启会从已提交归档和扫描状态继续。

一份配置对应一个归档数据库和一种 `capture_mode`。不要用同一份配置启动两个采集进程；API-only 可设置 `collection.enabled=false`。需要同时保留 metadata 与 content 时，使用两份配置、两个数据库启动两个 `serve`（例如 metadata 用 `8766`，content 用 `8767`）。两者可以独立配置来源范围和 token。不同数据库的采集进程可以同时运行；同一数据库仍只允许一个采集租约。

macOS 源码安装器不随 npm 包发行。需要用 launchd 常驻时，参见仓库的[安装器安全说明](../../docs/SAFETY.md#trace-content-与可选-knowledge-worker-的-macos-源码部署)。

## 身份、项目与来源

本模块不根据目录名猜测身份：`--instance` 标识来源设备或运行环境，`--project` 是统一项目标识；同一会话的项目绑定固定。采集器重新读取所选文件，按事件身份去重，不是基于字节偏移的 tail 守护进程。Codex / pi 源文件必须是完整 LF / CRLF 分行的 JSONL，未结束的尾行等待下次导入；dsh 源文件是拼接 Zstandard 帧，完整帧先归档，未写完的最后一帧标记为 pending。完整坏行或原位置内容变化使该文件整次导入失败。单文件上限 128 MiB，来源文件数上限 10000，不跟随符号链接。

## 内容与删除

新数据库默认 `metadata` 捕获，仅保存结构字段、最多 80 字符的请求标题与来源定位；这些字段仍可能敏感。需要正文证据时，针对明确选定的来源，在新建数据库时显式使用 `--capture content`。捕获模式建立后不可静默切换。

content 会保存用户请求、回答、工具参数和输出、可见推理摘要、计划与最终回答；不包含隐藏推理。进入归档前会脱敏常见凭据形态与敏感 JSON 字段，并把超大字符串外置为带 `bytes` / `sha256` 的 `content_ref` 文件，不静默截断。脱敏是启发式保护，不承诺发现所有散落密钥。metadata 导出固定剔除 `body` / `raw`。原始 `record_hash` 基于源行字节；消费方保留该来源声明，但批次只携带解析且已脱敏的对象，不能凭其重算原始行哈希。content 使用独立数据库与 blob 目录，步骤见[正文归档](docs/CONTENT-CAPTURE.md)。

```sh
npm run cli -- delete-session --runtime codex --instance demo-device --session archive-demo-session --db .agent-trace/demo.sqlite
```

删除会清除该会话的捕获事件并追加删除标记，提交后清理其引用的 blob。消费方必须继续消费到该标记才能清除自己的投影；旧页重试不会复活数据。已经导出的 JSON、备份和额外文件副本需单独清理。采集器拒绝静默重新导入已删除会话。详见[协议与可靠性约定](docs/PROTOCOL.md)。

## 已知限制

- 导出和 API 不按项目过滤；需要让客户端只能读取特定项目时，使用独立归档，不要手工改页。
- 只监听回环地址，不提供多用户认证、浏览器前端或 Inspector UI 集成。
- 不自动提取、验证或晋升经验；归档只是执行证据链。
- 消费进度、重试与租约由各消费方自己维护，Trace 不保存目标列表、投递队列或确认游标。
- 采集是整文件重读 + 事件身份去重，没有字节偏移 tail 或文件系统通知。
