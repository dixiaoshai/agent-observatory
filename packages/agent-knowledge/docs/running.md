# 本地运行与 Codex 接入

此版本只供当前操作系统用户使用，先运行项目自带合成资料。它没有 HTTP 监听器、聊天采集、模型调用或团队权限系统。

## 安装与验证

在项目根目录执行，Node.js 版本至少为 24.15：

```sh
node --version
npm ci
npm run check
npm run cli -- sync --source demo
npm run cli -- search --query "verify_password_hash" --project demo
```

`npm run check` 包含类型检查、自动化测试和构建。生产入口为 `node dist/interfaces/cli.js`，开发入口为 `npm run cli --`。SQLite 使用 `node:sqlite`，依赖版本由 `package-lock.json` 锁定。

## 配置与作用域

复制 `agent-knowledge.example.json` 为自己的 JSON 配置。数据库和根目录的相对路径均以**配置文件所在目录**为基准。`--config` 传绝对路径适合宿主启动；默认配置只用于合成演示。

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

只有配置中明确选择的来源会被导入。来源必须绑定到允许的项目；身份从当前 OS uid 获取，工具参数不能设置身份或扩大项目范围。共享同一数据库的多个配置仍按各自的项目、来源和身份过滤搜索与直接读取。`allowed_project_ids` 同时是归档证据的**消费范围**：`follow` 与 `archive-import` 会跳过页面中名单外项目的事件（不写证据、不写墓碑），游标照常提交前进，不会因 Trace 出现新 `project_id` 而整页失败；只有显式指定 `--project` / `project_id` 查询名单外项目时才返回 `FORBIDDEN`。缩小消费范围不会清理已导入证据，扩大范围也不会回填已跳过的历史。配置本身属于本机信任边界，不是多人服务的认证机制。

示例继续使用 `.knowrelay/knowledge.sqlite`，以兼容已有本地数据库；此隐藏目录仅保存运行数据。

扫描器支持 UTF-8 Markdown、文本和常用代码扩展名；默认文件上限 1 MiB。它排除隐藏目录、依赖和构建目录、常见凭据文件、敏感命名目录及 `.gitignore` 中的路径，拒绝跟随符号链接。规则包含嵌套 `.gitignore`，不读取 Git 全局排除配置。凭据命名规则偏保守，例如 `password.py` 也会跳过；可查看同步结果的 `skipped`，将公开的源代码按实际内容合理命名。不能通过扩展名白名单绕过敏感命名规则。

## 同步、读取和删除

```sh
node dist/interfaces/cli.js sync --config /absolute/path/config.json --source project-docs
node dist/interfaces/cli.js search --config /absolute/path/config.json --query "认证" --project my-project --limit 5
node dist/interfaces/cli.js read --config /absolute/path/config.json --id RECORD_ID --project my-project
node dist/interfaces/cli.js rebuild-index --config /absolute/path/config.json
node dist/interfaces/cli.js delete-source --config /absolute/path/config.json --source project-docs
```

每次同步返回新增、更新、删除、未变更数量与跳过原因。`--request-key KEY` 用于重试同一个同步请求；同一 key 返回已提交结果，需要扫描新变化时使用新 key，省略时 CLI 自动生成。key 不能用于另一来源配置。

文件变化、删除、被忽略或失去读取权限后，查询/读取会检查当前文件并停止返回旧内容；新版本在再次同步后可检索。同步失败会回滚，扫描 I/O 失败不会把原索引误判为已删除。并发同步使用条件版本检查；冲突时使用新 key 重试。

记录包含原文片段、相对路径、一开始为 1 的行号、源版本 ID、文件 SHA-256 和可获取的 Git HEAD。HEAD 是导入时仓库上下文，工作区可有未提交修改，**内容以哈希和快照为准**。`read_record` 读取已索引记录，不接受任意文件路径。

文件更新保留被替代版本以便追溯，但不允许通过 MCP 读取。`delete-source` 会在事务内清理来源的原文快照、记录、索引和幂等回执，留下只含元数据的删除标记和操作审计。它不删除原目录。重新导入需明确再次执行 `sync`。SQLite 的 WAL、外部备份或磁盘物理残留不属于此版本的安全擦除保证。

## Trace 自动拉取（follow）

当 [agent-trace](../../agent-trace/README.md) 以 `serve --config` 常驻运行并授权 Knowledge `content` 视图时，使用独立的 follow worker 自动续读，不必手工导出/导入批次。follow 只读取 Trace 的本机只读 API（`GET /v1/status`、`GET /v1/events`），不读取 Codex/pi/dsh 源日志，也不改 Trace 数据库。Trace metadata 与 content 是两个独立服务/数据库；Knowledge 只配置 content API，不需要启动 metadata。

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

- `trace_url` 只能是回环 `http://` 地址并带端口，不能含路径、查询或凭据；必须与 Trace 的 `api.host`/`api.port` 一致。
- 明文 token 只从 `token_env` 指定的环境变量读取，缺失或首尾空白即启动失败，不回落匿名。Trace 配置只保存 token 的 SHA-256 摘要；Knowledge 的客户端必须授权 `content` 视图。
- 未知字段、非回环地址、视图/数据库字段一律拒绝。`view` 固定为 `content`，不提供切换开关。
- `page_size` 不能超过 Trace 服务端上限（默认 1000）；超出时以 `PAGE_TOO_LARGE` 永久错误停止，需调小后重启。

启动前台 worker（SIGINT/SIGTERM 触发优雅停止）：

```sh
AGENT_TRACE_KNOWLEDGE_TOKEN="$(cat /path/to/secret)" \
  node dist/interfaces/cli.js follow --config /absolute/path/follow.json
```

stdout 每行一个 NDJSON 事件（`follow.started`、`follow.page`、`follow.idle`、`follow.error`、`follow.state`、`follow.stopped`），不包含 token、正文或完整事件。`follow.page` 只在本地事务提交成功后输出，`next_cursor` 是已提交游标。stderr 只在启动失败或永久错误时输出单行 JSON。退出码：`0` 信号停止；`1` 配置/启动/租约失败；`2` 启动后遇到永久错误。临时错误（连接失败、超时、HTTP 408/429/5xx、本地库忙）不退出，按 `idle_seconds` 起指数退避并遵守 `Retry-After`，游标不前进。

同步状态与业务游标都在 `<配置database>.archive-evidence.sqlite`：

- 业务游标仍由 `importBatch` 与证据/墓碑同事务提交；worker 每轮都从数据库已提交游标继续，重启不会用内存状态覆盖它。
- `archive_follow_state` 记录 `trace_url`、`archive_id`、固定视图、最近尝试/成功时间、最近错误和单 worker 租约。同一证据库同时只允许一个 worker；第二个实例以 `FOLLOW_LOCKED` 退出（启动失败，退出码 1）。崩溃后的租约可在过期后接管，死亡进程的租约可立即接管。
- 首次绑定会沿用同一证据库中已有的手动导入游标；已绑定后 `archive_id`、`trace_url` 或视图变化都会以永久错误暂停（`ARCHIVE_CHANGED` / `TRACE_CHANGED` / `FOLLOW_STATE`），需要显式重建目标库或修正配置，禁止静默归零。
- `VIEW_UNAVAILABLE` 表示 Trace 归档是 `metadata` 模式，不能提供正文；应使用独立的 content 归档。
- 删除墓碑随页到达后在本地事务清除证据投影；已提交旧页的重试是幂等重放，不会复活数据。Trace 不按消费进度清理历史，离线期间墓碑仍需保留。
- 项目授权是消费过滤，不是整页投递门槛：Trace 可以服务更宽的归档（例如全量采集出现的 `unscoped`），Knowledge 只把 `allowed_project_ids` 内的事件写入证据库，名单外事件（含 `session.deleted`）被跳过而不是让整页失败，游标仍提交到 `next_cursor`。页面信封、`archive_seq` 顺序与范围、游标连续性和页面指纹（按完整批次计算，含被跳过事件）仍严格校验；重放同一页仍按原指纹识别为幂等。缩小名单不会清理已导入证据，扩大名单也不会补回跳过的历史。

follow 与 MCP `serve`、看板类进程完全独立：worker 只打开证据库和本机 HTTP，无需 MCP 客户端在线；关闭聊天不会停止同步。反过来，follow 运行时 MCP 的只读查询仍可用（同一证据库的短事务）。手动 `archive-import` 继续保留，用于一次性回放或显式重建。

## MCP 与 Codex

服务通过 STDIO 提供四个只读工具，不提供导入、任意路径读取或身份设置参数：

| 工具 | 参数 |
| --- | --- |
| `search_context` | `query`、可选 `project_id`、`kind: "knowledge"`、`limit`（1–20，默认 5） |
| `read_record` | `record_id`、可选 `project_id` |
| `search_archive` | `query`、可选 `project_id`、`limit`（1–20，默认 5） |
| `read_archive_event` | `archive_id`、`event_id`、可选 `project_id` |

归档证据仍通过 `archive-import` 手动导入，与确认知识分开。下一阶段计划由本项目独立 worker 主动拉取 Trace 的 content 页；该 worker 不依赖 MCP 连接，当前尚未实现。见[目标设计](../../agent-trace/docs/continuous-collection.md)和[交接 TODO](../../../docs/ROADMAP.md)。

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

不要用带构建输出的命令包装 MCP STDIO；入口 stdout 只发送协议数据。此项目未自动改写宿主配置。服务退出随宿主断开，数据库由 CLI/MCP 进程共享。

将 `skills/agent-knowledge` 安装到宿主实际使用的技能目录后，在**全新会话**中执行：

> $agent-knowledge 使用 demo 项目知识回答刷新令牌保存在哪里。先 search_context，再 read_record，引用文件路径、行号与内容哈希。不要依据旧聊天回答。

核对工具日志和最终引用；再修改/删除样例、同步并在下一会话复测。另测代表性任务的 skill 自动选择，未触发时记录宿主行为。本机 PATH 中的 `codex` 启动器缺少平台二进制，验收脚本使用 ChatGPT 应用内置 CLI。此前以 KnowRelay 名称完成真实新会话的显式调用与文件生命周期验证；自动选择当时未观察到 skill 触发。重命名为 Agent Knowledge 后尚未重新进行客户端验收，详见[历史验证记录](validation.md)。

## 可重复的合成客户端验收

```sh
npm run verify:codex -- --case all --timeout-ms 90000
```

脚本会构建应用，在 `.knowrelay/acceptance/run-*` 中生成独立数据库、随机知识和工作目录，并将 skill 副本安装到该工作目录的 `.agents/skills/agent-knowledge`。按 [官方技能发现规则](https://learn.chatgpt.com/docs/build-skills)，这是项目内技能位置。它使用现有 Codex 登录启动全新临时只读会话，不改写用户的宿主配置或安装目录。

验收依次检查显式调用、自动选择、更新前、更新后和删除后的五个会话。知识答案只写入源文件，不放进问题。隔离 skill 正文另含一个随机输出探针，技能描述不变；只有检索前的助手消息输出该探针，才计为读取技能正文的证据。仅声称“使用了 skill”不会通过。这属于带探针的合成验收，不能代替真实任务中的长期触发率观察。

每轮保留 `summary.json`、各会话的 JSONL 调用、stderr 和最终回答。通过必须同时具备成功宿主版本检查、真实有序搜索/读取、相符的内容哈希和源版本、正确引用，以及对应 skill 探针。删除后需针对原问题得到空结果，并且没有旧来源残留。证据不全记为 `inconclusive`，连接/执行失败记为 `blocked`，均以非零退出码结束。

可用 `--case explicit`、`--case automatic` 或 `--case lifecycle` 单独复测；`--prepare-only` 仅准备合成资料，状态为 `prepared`，不代表验收通过。`--codex /absolute/path/to/codex` 可指定客户端，默认优先尝试 ChatGPT 应用内置二进制，绕开本机失效的 PATH 启动器；`--model MODEL` 可显式选择模型。

`--case unavailable` 另开不配置 Agent Knowledge MCP 的会话，要求带探针的技能只返回固定结构化拒答。所有非探针助手消息都参与核验；额外答案、来源或先编造后拒答均不通过。此用例独立于 `all` 的五个会话。

在本机连接排查中，补全子进程缺失的 `HTTP_PROXY`/`http_proxy` 为已有的 HTTPS 代理值，并临时关闭无关 Apps/插件连接后，新会话恢复。脚本仅在进程内应用这些设置，不输出代理或认证信息；这是一组本机验证有效的组合调整，尚未逐项归因。Apps 开关依据 [官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)，其余开关由本机 CLI `features list` 核对。各用例有超时与输出上限，失败日志会保留用于诊断。

## 当前边界

- 当前检索对授权有效片段全量内存评分，并按来源扫描文件验证新鲜度，适合小型试点。超大目录应先缩小允许范围；向量、预计算倒排和文件监听后续评估。
- 词法命中表示有相同词项，不代表问题一定有答案；回答者必须读取来源核实。检索内容按数据处理，不能提供新的执行授权。
- 本地可信目录内不跟随符号链接，普通文件使用 `O_NOFOLLOW`，并在遍历和读取前后复核祖先目录身份、规范路径及文件身份；发现目录替换则中止。Node 路径 API 仍无法对恶意进程精确反复切换父目录提供完整 `openat` 级原子隔离，团队服务前需加固。
- 尚未实现对话记忆、提取队列、模型提供方、经验反馈、自动 skill 修改和 Agent Stats 用量接入；没有批量读取历史会话。
