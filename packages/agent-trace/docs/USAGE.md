# 使用与排错

本文按“先合成、后真实”的顺序说明本模块的常用操作。所有示例都使用合成数据或占位路径；导入真实来源前，先确认项目范围、捕获模式、数据库和消费方授权。

## 环境与安装

要求 Node.js **24.15.0+**。运行使用 Node 自带 TypeScript 和 SQLite；`npm ci` 安装锁定的开发类型检查依赖。在模块目录执行：

```sh
npm ci
npm run check
npm run cli -- help
```

## 创建合成归档

以下命令均在 Agent Trace 目录执行；示例库应使用未被其他捕获模式占用的新文件：

```sh
npm run cli -- ingest --source fixtures/codex/demo.jsonl --instance demo-device --project demo --runtime auto --capture content --db .agent-trace/demo.sqlite
npm run cli -- status --db .agent-trace/demo.sqlite
```

合成 fixture 固定包含 11 条事件：首次导入应全部为 `imported`，再次运行同一导入应为 `imported: 0`、`skipped: 11`。`status` 显示归档身份、捕获模式、标准化版本和会话 / 事件数量。

`--instance` 是来源设备或运行环境的稳定命名空间；`--project` 是统一项目 ID。日常续采不要改变它们。同一会话的项目归属固定；同实例 / 原生会话在不同目录的副本保持同一身份。

默认捕获模式是 `metadata`。上例显式使用 `content`，因为后续要读取正文。既有 metadata 库不能直接切换成 content；即使导出 content 视图，其中未捕获的 `body` / `raw` 仍为空。

## 导出批次

在 Agent Trace 目录导出：

```sh
npm run cli -- export --db .agent-trace/demo.sqlite --after 0 --limit 10000 --view metadata --output .agent-trace/stats-page-1.json
npm run cli -- export --db .agent-trace/demo.sqlite --after 0 --limit 10000 --view content --output .agent-trace/evidence-page-1.json
```

目录由先前建库创建。文件以 `0600` 权限新建，已存在则拒绝覆盖；重复演示时使用新的输出文件名。每页上限 10000 事件，默认 500。导出 JSON 含 `archive_id` / `after_cursor` / `next_cursor` / `has_more` / `events`，不要编辑其中的事件、身份或游标。

## 追加与续读

对相同来源、实例、项目和数据库再次执行 `ingest`，或让常驻 `serve` 自动扫描。使用上次确认的游标续读，例如：

```sh
npm run cli -- export --db .agent-trace/demo.sqlite --after 11 --view metadata --output .agent-trace/stats-page-2.json
```

`has_more=true` 时继续取页。仅查看归档时可用返回的 `next_cursor`；向其他模块导入时，应以各消费方成功回执中的 `cursor` 为准。回执丢失时重试原批次，不要重新导出同一范围来替换它。没有新事件时返回空页是正常结果。跨模块导入与同步示例见源码仓库的[跨模块消费指南](../../../docs/TRACE-CONSUMERS.md)。

## 启动常驻采集与只读 API

先校验配置；`config-check` 不建库、不扫描、不监听：

```sh
npm run cli -- config-check --config agent-trace.service.example.json
npm run cli -- config-check --config path/to/service.json --db path/to/trace.sqlite
```

示例默认关闭采集与 API。正式启用前按[服务配置](SERVICE-CONFIG.md)替换来源、项目 `cwd_allowlist`、数据库、捕获模式和 token 摘要；需要采集来源下全部会话时给来源增加 `unmatched_project_id`（见[全量采集示例](SERVICE-CONFIG.md#全量采集示例)）。`config-check` 通过不代表目录存在或数据库捕获模式匹配，`serve` 启动时会再检查并获取采集租约。

前台启动：

```sh
npm run cli -- serve --config path/to/service.json
```

- `collection.enabled=true` 时按 `scan_interval_seconds` 扫描配置来源；`backfill=none` 首次只记录基线，`all` 首次导入当前文件。
- `api.enabled=true` 时只监听配置的回环地址 / 端口。API 请求必须带配置中某个客户端的 bearer token，且 token 必须被授权读取所请求视图。
- 启动、每次扫描、采集错误和停止输出 NDJSON 到 stdout；不会输出 token、正文或原始事件。
- `Ctrl+C` / SIGTERM 优雅停止：不再调度新扫描，等待当前文件事务结束，关闭监听并释放租约。
- 同一归档只能有一个采集实例；第二个进程报 `COLLECTION_LOCKED`。租约默认 5 分钟，进程每 15 秒续租，崩溃后过期可接管。
- 采集和 API 都关闭时 `serve` 拒绝启动；只读已有归档可设 `collection.enabled=false`。

用本机 API 核对（token 放在消费方自己的环境变量，不要写进命令历史或日志）：

```sh
curl -sS -H "Authorization: Bearer $AGENT_TRACE_STATS_TOKEN" \
  "http://127.0.0.1:8766/v1/status"
curl -sS -H "Authorization: Bearer $AGENT_TRACE_STATS_TOKEN" \
  "http://127.0.0.1:8766/v1/events?after=0&limit=500&view=metadata"
```

`GET` 幂等且不推进任何进度。`has_more=true` 时用返回的 `next_cursor` 继续取；`metadata` 不包含正文 / 原始对象。不要用一个消费方的游标代替另一个消费方的进度。

协议错误、非法游标、越权视图和超过 32 MiB 的页会返回明确错误，不会返回空页伪装成追平。完整契约见[本机只读 API](LOCAL-API.md)。

## 补录与 blob 回收

`reingest` 重读采集器已导入的文件，为之后才出现在源文件里的记录补录事件；它需要采集租约，必须先停止 `serve`：

```sh
npm run cli -- reingest --config path/to/service.json
```

`gc` 删除 content 归档中未被任何已提交事件引用的 blob 文件；先预览再执行：

```sh
npm run cli -- gc --config path/to/content.json --dry-run
npm run cli -- gc --config path/to/content.json
```

## 读取归档本身的证据

```sh
npm run cli -- read --db .agent-trace/demo.sqlite --event EVENT_ID --view content
```

默认读取视图为 metadata。content 包含已捕获的方便读取正文和解析对象（已脱敏），未知原生记录可能只在 `raw` 中有内容。超大字符串被替换为 `content_ref`，需按绝对路径、`bytes` 和 `sha256` 读取并校验文件；`content_ref` 是保留键。工具返回仅证明记录中观察到了结果，不是外部操作成功的独立保证。

## 选定真实来源

确定捕获范围和模式后，使用明确文件或目录及独立数据库：

```sh
npm run cli -- ingest --source /absolute/path/to/selected-rollout.jsonl --instance workstation-a --project project-a --capture content --db .agent-trace/trace.sqlite
```

路径是待替换的示例，不会自动查找 `CODEX_HOME` 或 `~/.dsh`。可重复使用 `--source` 指定多个文件或目录；目录递归接收 `.jsonl`、`.jsonl.zstd` 和 `.jsonl.zst`（DeepSeek Harness，运行时 `dsh`），跳过符号链接。单文件大小上限 128 MiB，dsh 解码后上限 256 MiB，来源文件数上限 10000。

在多项目目录上运行一次命令会把所有导入会话绑定到该次 `--project`，因此应按项目分次选择来源。导出和 API 不按项目过滤；对需要限制可见项目的客户端，按授权范围创建独立归档。

content 捕获包含请求、回答、最终回答、工具参数 / 输出、可见推理摘要与计划，并在落库前脱敏常见凭据形态与敏感字段；超过内联上限的字符串外置为可核验文件，不截断。脱敏仍是启发式，不能发现所有正文秘密。metadata 仍包含（也会脱敏的）标题与路径。选择恰当范围后再导入，不要以导出视图替代捕获策略。详见[正文归档](CONTENT-CAPTURE.md)。

## 删除归档会话

以下命令会删除合成示例会话的归档事件：

```sh
npm run cli -- delete-session --db .agent-trace/demo.sqlite --runtime codex --instance demo-device --session archive-demo-session
```

删除在归档事务中追加墓碑，提交后清理该会话的 blob。离线消费方只有在续读到墓碑后，才会清除自己的投影。

同会话再次删除返回 `deleted: false`；同身份再次导入被拒绝。已有 JSON 导出和备份是额外副本，需要按其生命周期分别清理。没有自动恢复或迁移命令；更换归档数据库前应规划消费方重建，不能把同一会话直接交由另一个归档覆盖现有投影。

## 错误与处理

| 错误或现象 | 原因 | 处理 |
| --- | --- | --- |
| `CAPTURE_MODE` | 既有库的捕获模式与请求不同 | 核对原库模式；需要不同策略时使用新数据库并规划消费方接入 |
| `SOURCE_CONFLICT` | 同会话被归到另一个项目 | 核对项目 / 实例和 cwd 配置；勿仅靠换实例绕过，以免重复统计 |
| `SESSION_DELETED` | 同身份已显式删除 | 停止重导；确认是否需要另行规划恢复 |
| `COLLECTION_LOCKED` | 同一归档已有采集进程持有有效租约 | 检查现有 `serve`；不要强抢运行中的租约，等它停止或租约过期 |
| `COLLECTION_BUSY` | `reingest` 时采集租约被占用 | 先停止 `serve`，或等待租约过期 |
| `INVALID_RECORD` | 完整行不是受支持的 Codex / pi / dsh JSON 记录 | 核对来源格式；该文件本次事件未提交 |
| `RUNTIME_MISMATCH` | 显式 `--runtime` 与实际文件格式不一致 | 去掉 `--runtime` 使用 `auto`，或改正参数 |
| `PROJECTION_MISMATCH` | 归档由不同标准化版本写入 | 按协议重建新归档并重建消费方库，不能靠重导同一文件修复 |
| `pending` 非空 | 文件末尾尚无结束换行，或 dsh 最后一个 Zstandard 帧未写完整 | 等日志写完后再次导入；已完整的帧会先归档 |
| `FILE_TOO_LARGE` / `TOO_MANY_SOURCES` | 超过采集范围限制 | 缩小所选来源，保留原始事件顺序和身份 |
| 输出文件已存在 | 导出使用只新建策略 | 使用新文件名，保留原成功页用于可靠重试 |
| 正文为空 | 建库时没有捕获正文，或源记录无该内容 | 核对 capture 模式及原生记录，不把空值当成数据损坏 |

`ingest` 有任一文件失败会以非零状态退出，并在回执的 `errors` 中报告路径和代码；此前其他文件的成功提交仍保留。恢复与一致性规则见[架构说明](ARCHITECTURE.md)和 [v1 协议](PROTOCOL.md)。
