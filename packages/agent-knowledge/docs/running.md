# 本地运行与 Codex 接入

本文说明 Agent Knowledge 的当前运行方式。它面向本机单用户，没有 HTTP 监听器、聊天采集、模型调用或团队权限系统。

## 安装与本地检查

在源码目录执行，要求 Node.js **24.15.0+**：

```sh
node --version
npm ci
npm run check
npm run cli -- sync --source demo
npm run cli -- search --query "verify_password_hash" --project demo
```

`npm run check` 依次执行类型检查、构建和自动化测试。生产入口为 `node dist/interfaces/cli.js`，开发入口为 `npm run cli --`。SQLite 使用 `node:sqlite`，依赖版本由 `package-lock.json` 锁定。

## 配置与作用域

复制 `agent-knowledge.example.json` 为自己的 JSON 配置。数据库和源根目录的相对路径均以**配置文件所在目录**为基准；`--config` 传绝对路径更适合宿主启动。默认配置只用于合成演示。

```json
{
  "schema_version": 1,
  "database": "./.knowrelay/knowledge.sqlite",
  "allowed_project_ids": ["my-project"],
  "sources": [
    {
      "id": "project-docs",
      "root": "./chosen-docs",
      "project_id": "my-project",
      "include_extensions": [".md", ".txt", ".ts", ".py"],
      "max_file_bytes": 1048576
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `schema_version` | 固定为 `1` |
| `database` | 知识库 SQLite 路径；归档证据库由它派生 |
| `allowed_project_ids` | 允许的本机项目范围；源必须绑定到其中某个项目 |
| `sources[].id` | 来源标识，必须唯一 |
| `sources[].root` | 源目录，必须存在；相对路径按配置文件解析 |
| `sources[].project_id` | 该来源绑定的项目，必须在 `allowed_project_ids` 中 |
| `sources[].include_extensions` | 可选扩展名白名单；省略时使用内置的 Markdown、文本和常用代码扩展名 |
| `sources[].max_file_bytes` | 可选单文件字节上限；默认 1 MiB，最大 100,000,000 |

配置是严格对象：未知字段、重复来源 ID、重复项目 ID、未授权的来源项目都会被拒绝。

- 身份来自当前 OS uid；工具参数不能设置身份或扩大项目范围。共享同一数据库的多个配置仍按各自的项目、来源和身份过滤搜索与直接读取。
- 只有配置中明确选择的来源会被导入。本地可信目录内不跟随符号链接，普通文件使用 `O_NOFOLLOW`，遍历和读取前后复核祖先目录与文件身份。
- 扫描器排除隐藏目录、依赖和构建目录、常见凭据文件、敏感命名目录及 `.gitignore` 中的路径；不读取 Git 全局排除配置。凭据命名规则偏保守，例如 `password.py` 也会跳过；可查看同步结果的 `skipped`，把公开源代码按实际内容合理命名。不能通过扩展名白名单绕过敏感命名规则。
- 示例继续使用 `.knowrelay/knowledge.sqlite`，以兼容已有本地数据库；该隐藏目录仅保存运行数据。

`allowed_project_ids` 同时是归档证据的**消费范围**：`follow` 与 `archive-import` 会跳过页面中名单外项目的事件（不写证据、不写墓碑），游标照常提交，不会因 Trace 出现新 `project_id` 而整页失败；只有显式指定 `--project` / `project_id` 查询名单外项目时才返回 `FORBIDDEN`。缩小消费范围不会清理已导入证据，扩大范围也不会回填已跳过的历史。配置本身属于本机信任边界，不是多人服务的认证机制。

## 同步、读取和删除

```sh
node dist/interfaces/cli.js sync --config /absolute/path/config.json --source project-docs
node dist/interfaces/cli.js search --config /absolute/path/config.json --query "认证" --project my-project --limit 5
node dist/interfaces/cli.js read --config /absolute/path/config.json --id RECORD_ID --project my-project
node dist/interfaces/cli.js rebuild-index --config /absolute/path/config.json
node dist/interfaces/cli.js delete-source --config /absolute/path/config.json --source project-docs
```

- 每次同步返回新增、更新、删除、未变更数量与跳过原因。
- `--request-key KEY` 用于重试同一个同步请求：同一 key 返回已提交结果；需要扫描新变化时使用新 key，省略时 CLI 自动生成。key 不能用于另一来源配置。
- 文件变化、删除、被忽略或失去读取权限后，查询/读取会检查当前文件并停止返回旧内容；新版本在再次同步后可检索。同步失败会回滚，扫描 I/O 失败不会把原索引误判为已删除。并发同步使用条件版本检查；冲突时换新 key 重试。
- 记录包含原文片段、相对路径、从 1 开始的行号、源版本 ID、文件 SHA-256 和可获取的 Git HEAD。HEAD 是导入时的仓库上下文，工作区可以有未提交修改，**内容以哈希和快照为准**。
- `read_record` / `read` 读取已索引记录，不接受任意文件路径。
- 文件更新保留被替代版本以便追溯，但不允许通过 MCP 读取。`delete-source` 在事务内清理来源的原文快照、记录、索引和幂等回执，留下只含元数据的删除标记和操作审计；它不删除原目录。重新导入需显式再次执行 `sync`。
- SQLite 的 WAL、外部备份或磁盘物理残留不属于此版本的安全擦除保证。

## 归档证据导入与读取

当 [agent-trace](../../agent-trace/README.md) 以 content 模式提供版本化 JSON 批次时，可以手动导入并查询执行证据：

```sh
node dist/interfaces/cli.js archive-import --config /absolute/path/config.json --input content-page.json
node dist/interfaces/cli.js archive-search --config /absolute/path/config.json --query "刷新令牌" --project my-project
node dist/interfaces/cli.js archive-read --config /absolute/path/config.json --archive ARCHIVE_ID --event EVENT_ID
```

- 归档证据保存在 `<配置 database>.archive-evidence.sqlite`，与活跃知识库分开，不依赖原日志仍存在。
- 导入按页原子提交：`after_cursor` 必须等于本地已提交游标；页面指纹覆盖完整批次，重复页是幂等重放；不合法或乱序事件、冲突身份或墓碑复活会使事务回滚且游标不前进。同一会话不能在不同项目间复用。
- 删除标记随页传播：清除该会话的证据并写入墓碑，旧页重放不会复活数据。
- 事件可能把超大正文外置为 `content_ref`（绝对路径、字节数、SHA-256，媒体类型为 `text/plain`）。导入时校验引用结构；Codex 事件还要求引用与 `raw` 一致。检索文本仍来自 `body`，MCP 原样返回引用而不读取该路径，正文读取需使用方按引用自行核验。
- 只读查询按 owner 和项目范围过滤；显式查询名单外项目返回 `FORBIDDEN`。
- 未知类型的事件按原样保留为证据，不赋予额外执行语义。`record_hash` 是归档给出的源行哈希声明，批次中的解析结果不足以独立重算原始字节哈希。
- 手动 `archive-import` 继续保留，用于一次性回放或显式重建。归档证据不会自动成为确认知识。

## Trace 自动拉取（follow）

当 Trace 以 `serve --config` 常驻运行并授权 Knowledge 的 `content` 视图时，使用独立的 follow worker 自动续读，不必手工导出和导入批次。follow 只读取 Trace 的本机只读 API（`GET /v1/status`、`GET /v1/events`），不读取 Codex/pi/dsh 源日志，也不改 Trace 数据库。Trace 的 metadata 与 content 是两个独立服务/数据库；Knowledge 只配置 content API，不需要启动 metadata。

复制 [agent-knowledge.follow.example.json](../agent-knowledge.follow.example.json)，把 `config` 指向既有的 Knowledge 配置（数据库、`allowed_project_ids` 与 owner 都来自它）：

```json
{
  "schema_version": 1,
  "trace_url": "http://127.0.0.1:8766",
  "token_env": "AGENT_TRACE_KNOWLEDGE_TOKEN",
  "config": "./agent-knowledge.json",
  "page_size": 200,
  "idle_seconds": 15,
  "request_timeout_seconds": 20,
  "max_backoff_seconds": 300
}
```

- `trace_url` 只能是回环 `http://` 地址并带端口，不能含路径、查询或凭据；必须与 Trace 的 `api.host` / `api.port` 一致。
- 明文 token 只从 `token_env` 指定的环境变量读取，缺失或首尾空白即启动失败，不回落匿名。Trace 配置只保存 token 的 SHA-256 摘要；Knowledge 的客户端必须被授权 `content` 视图。
- 未知字段、非回环地址、`view` / `database` 等额外字段一律拒绝。`view` 固定为 `content`，不提供切换开关。
- `page_size` 默认 200，不能超过 Trace 服务端上限（Trace 默认 1000）；超出时以 `PAGE_TOO_LARGE` 永久错误停止，需调小后重启。
- `idle_seconds` 默认 15，`request_timeout_seconds` 默认 20，`max_backoff_seconds` 默认 300；`max_backoff_seconds` 不能小于 `idle_seconds`。
- `config` 不能以 `~` 开头；相对路径按 follow 配置文件解析。

启动前台 worker（SIGINT/SIGTERM 触发优雅停止）：

```sh
AGENT_TRACE_KNOWLEDGE_TOKEN="$(cat /path/to/secret)" \
  node dist/interfaces/cli.js follow --config /absolute/path/follow.json
```

stdout 每行一个 NDJSON 事件（`follow.started`、`follow.page`、`follow.idle`、`follow.error`、`follow.state`、`follow.stopped`），不包含 token、正文或完整事件。`follow.page` 只在本地事务提交成功后输出，`next_cursor` 是已提交游标。stderr 只在启动失败或永久错误时输出单行 JSON。退出码：`0` 信号停止；`1` 配置/启动/租约失败；`2` 启动后遇到永久错误。临时错误（连接失败、超时、HTTP 408/429/5xx、本地库忙）不退出，按 `idle_seconds` 起指数退避、遵守 `Retry-After` 且不超过 `max_backoff_seconds`，游标不前进。

同步状态与业务游标都在 `<配置 database>.archive-evidence.sqlite`：

- 业务游标仍由 `importBatch` 与证据/墓碑同事务提交；worker 每轮都从数据库已提交游标继续，重启不会用内存状态覆盖它。
- `archive_follow_state` 记录 `trace_url`、`archive_id`、固定视图、最近尝试/成功时间、最近错误和单 worker 租约。同一证据库同时只允许一个 worker；第二个实例以 `FOLLOW_LOCKED` 退出（启动失败，退出码 1）。租约过期后可接管；同机已死亡进程的租约可立即接管。
- 首次绑定会沿用同一证据库中已有的手动导入游标；已绑定后 `archive_id`、`trace_url` 或视图变化都会以永久错误暂停（`ARCHIVE_CHANGED` / `TRACE_CHANGED` / `FOLLOW_STATE`），需要显式重建目标库或修正配置，禁止静默归零。
- `VIEW_UNAVAILABLE` 表示 Trace 归档是 `metadata` 模式，不能提供正文；应使用独立的 content 归档。
- 删除墓碑随页到达后在本地事务清除证据投影；已提交旧页的重试是幂等重放，不会复活数据。Trace 不按消费进度清理历史，离线期间墓碑仍需保留。
- 项目授权是消费过滤，不是整页投递门槛：Trace 可以服务更宽的归档（例如全量采集出现的 `unscoped`），Knowledge 只把 `allowed_project_ids` 内的事件写入证据库，名单外事件（含 `session.deleted`）被跳过而不是让整页失败，游标仍提交到 `next_cursor`。页面信封、`archive_seq` 顺序与范围、游标连续性和页面指纹（按完整批次计算，含被跳过事件）仍严格校验；重放同一页仍按原指纹识别为幂等。
- 缩小名单不会清理已导入证据，扩大名单也不会补回跳过的历史；需要重建时显式删除证据库并从 0 回放。

follow 与 MCP `serve`、看板类进程完全独立：worker 只打开证据库和本机 HTTP，无需 MCP 客户端在线；关闭聊天不会停止同步。反过来，follow 运行时 MCP 的只读查询仍可用（同一证据库的短事务）。手动 `archive-import` 继续保留，用于一次性回放或显式重建。

## MCP 与 Codex

服务通过 STDIO 提供四个只读工具，不提供导入、任意路径读取或身份设置参数：

| 工具 | 参数 |
| --- | --- |
| `search_context` | `query`、可选 `project_id`、`kind: "knowledge"`、`limit`（1–20，默认 5） |
| `read_record` | `record_id`、可选 `project_id` |
| `search_archive` | `query`、可选 `project_id`、`limit`（1–20，默认 5） |
| `read_archive_event` | `archive_id`、`event_id`（64 位小写十六进制）、可选 `project_id` |

归档证据由 `archive-import` 手动导入或由 follow worker 自动拉取，与确认知识分开；MCP 只读，不接受写入。

以 [Codex 官方 MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 为依据，构建并导入后可添加本地服务：

```sh
codex mcp add agent-knowledge -- /absolute/path/to/node /absolute/path/to/agent-knowledge/dist/interfaces/cli.js serve --config /absolute/path/to/agent-knowledge/agent-knowledge.example.json
```

使用 `command -v node` 获取 Node 绝对路径，并确认该版本符合要求。等价配置示例：

```toml
[mcp_servers.agent-knowledge]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agent-knowledge/dist/interfaces/cli.js", "serve", "--config", "/absolute/path/to/agent-knowledge/agent-knowledge.example.json"]
```

不要用带构建输出的命令包装 MCP STDIO；入口 stdout 只发送协议数据。本项目不自动改写宿主配置；服务退出随宿主断开，数据库由 CLI/MCP 进程共享。

将 `skills/agent-knowledge` 安装到宿主实际使用的技能目录后，在**全新会话**中执行：

> $agent-knowledge 使用 demo 项目知识回答刷新令牌保存在哪里。先 search_context，再 read_record，引用文件路径、行号与内容哈希。不要依据旧聊天回答。

核对工具日志和最终引用；再修改或删除样例、重新同步并在下一会话复测。skill 的自动选择由宿主根据描述决定，不保证每次触发；未触发时应记录宿主行为，而不是把检索结果当作技能已生效的证据。

## 当前边界

- 当前检索对授权有效片段全量内存评分，并按来源扫描文件验证新鲜度，适合小型本机语料。超大目录应先缩小允许范围；当前不提供向量、预计算倒排或文件监听。
- 词法命中表示有相同词项，不代表问题一定有答案；回答者必须读取来源核实。检索内容按数据处理，不能提供新的执行授权。
- 本地可信目录内不跟随符号链接，普通文件使用 `O_NOFOLLOW`，并在遍历和读取前后复核祖先目录身份、规范路径及文件身份；发现目录替换则中止。Node 路径 API 仍无法对恶意进程精确反复切换父目录提供完整 `openat` 级原子隔离。
- 尚未实现对话记忆、提取队列、模型提供方、经验反馈、自动 skill 修改和 Agent Stats 用量接入；没有批量读取历史会话。
- 归档证据是历史观察，不会自动成为确认知识；没有团队多用户认证或按授权过滤的导出流。
