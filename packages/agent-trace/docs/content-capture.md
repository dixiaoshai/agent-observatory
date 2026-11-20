# 正文归档（content 捕获）

正文归档用于执行复盘、证据检索与后续经验提炼。它只属于 Trace 的 content 捕获模式，默认的 metadata 模式不受影响；升级代码不会自动补回历史正文。协议细节见 [v1 协议](protocol.md)，服务配置见[服务配置](service-config.md)。

## 边界

- 只有显式选择 `capture_mode: "content"` 并新建数据库时才保存正文。已有 metadata 库保持 metadata；打开时请求不同模式会报 `CAPTURE_MODE`，不能用修改配置的方式补回历史正文。
- 正文库应独立于 metadata 库（不同数据库、不同归档身份、不同 blob 目录）。各消费方按 `archive_id` 分别维护游标，不能把同一个会话在两个归档间静默覆盖。
- 保存的是源日志中可见的内容：提示、回答、工具参数 / 结果、可见推理摘要与计划。不恢复隐藏 / 加密推理，不把摘要当执行事实，不把工具返回当任务成功。
- 脱敏是启发式保护，不是“已证明无密钥”。选择来源时仍需假设库、blob 目录和导出文件都是私密数据。

## 捕获内容

| 事件 | content 模式下保存 |
| --- | --- |
| `session.started` | 会话 `cwd`、标题与来源身份（仍在 metadata） |
| `message.user` | 用户请求、补充要求与纠正的完整文本 |
| `message.assistant` | 每条可见回答，包括中间进展 |
| `turn.completed` | Codex `task_complete.last_agent_message`（有则保存）；pi 的最终回答由终止前的 `message.assistant` 保留 |
| `reasoning.summary` | 源日志已有的可见推理摘要 |
| `tool.called` | 工具名、调用 ID 与参数（含计划类工具调用的结构化参数） |
| `tool.returned` | 返回结果原文、退出码 / 错误信息（若在源记录中） |
| `context.compacted` | 压缩摘要 |
| `source.unknown` | 原始记录在 `raw` 中，便于以后解释未知类型 |

## 脱敏

入库前对 `body`、`raw` 的每个字符串以及 `data.title` 执行确定性替换，命中内容变为显式的 `[REDACTED:<类别>]`，不做静默删除。结构化字段名命中敏感键（如 `password`、`access_token`、`client_secret`、`*_token`）时整个值被替换。

| 类别 | 示例形态 |
| --- | --- |
| 私钥 | `-----BEGIN ... PRIVATE KEY-----` 块 |
| 认证头 / 方案 | `Authorization: Bearer ...`、裸 `Bearer ...` |
| 常见 API 密钥 | `sk-...`、`ghp_...` / `github_pat_...`、`AKIA...`、`xox[baprs]-...`、`AIza...`、`glpat-...`、`npm_...` |
| JWT | `eyJ...` 三段式 |
| URL 用户信息 | `https://user:password@host` |
| 键值 / JSON 字段 | `password=...`、`"token": "..."`、`api_key: ...` |
| 结构化敏感键 | `{"password": "..."}`、`{"GITHUB_TOKEN": "..."}` |

过匹配抑制：

- 裸方案词（`Bearer` / `Basic` / `Digest` / `Token`）后的值必须像凭据：含数字、≥12 位且大小写混用、或 ≥24 位且带分隔符。`basic instructions`、`Digest algorithm`、`Token coverage`、`Basic category.` 因此保持原文。
- 显式 `Authorization: <scheme> …` 头仍按原文替换，不要求值形态。
- 键值规则只匹配显式单数键名（`token`、`password`、`client_secret` 等），不把 `tokens` / `js-tokens` / `fewer tokens:` 这类复数或复合词当敏感键；`$OPENAI_API_KEY`、`<your token>`、`{placeholder}`、`^7.29.7` 这类引用 / 占位符也不替换。
- 代价：纯小写字母且无分隔符的裸方案值是漏检面（仍会被显式头规则或具体 token 形态规则覆盖）；结构化敏感键不覆盖复数键名（`{"tokens": 10000}` 不会被整值替换）。

限制：

- 规则只覆盖常见形态。自由散文、代码片段、私有格式和拆分拼接的密钥仍可能漏检。
- 脱敏后 `source.record_hash` 仍是**原始源行**的哈希，不是脱敏副本的哈希；这是来源声明，不是“副本可复原原字节”的保证。
- `raw` 是脱敏后的原始解析对象。依赖逐字节原文的用途请回到源文件；协议仍只承诺解析对象与来源哈希。
- 运行日志（`serve` 的 NDJSON 事件与错误消息）在输出前再次做同样的字符串脱敏；日志不应包含正文，但错误消息可能引用路径或片段。

## 大输出外置

字符串超过 `content.max_inline_bytes`（默认 65536 字节）时，不截断，而是：

1. 先把脱敏后的完整字符串写入 `content.blob_directory` 下的文件；
2. 用 `content_ref` 对象替换该字符串，`body` 与 `raw` 同步替换，保持两者一致；
3. 文件按内容寻址：`<event_id>-<sha256>.txt`，权限 `0600`，目录 `0700`；
4. 引用结构：

```json
{
  "content_ref": {
    "path": "/private/agent-trace/content-blobs/<event-id>-<sha256>.txt",
    "bytes": 4133,
    "sha256": "<64-hex>",
    "media_type": "text/plain"
  }
}
```

可核验性：读取者应检查文件路径在预期目录内、字节数等于 `bytes`、SHA-256 等于 `sha256`。文件名带事件 ID，因此不同会话不共享文件；删除会话或替换旧 revision 时，归档会清理对应 blob。导入器在事务回滚、旧 revision、已删除会话或来源冲突时会删除本次写入且未被已提交事件引用的文件，避免产生孤儿。

`content_ref` 是保留键。消费方遇到带该键的对象必须按引用校验，不能当作普通正文；不认识的引用形态应拒绝整页而不是跳过。

## 消费方

- **Agent Stats**：只拉 `metadata`，导出与 API 固定把 `body` / `raw` 置空；即便归档是 content 模式，统计库也不会得到正文、脱敏标记或 blob 路径。
- **Agent Knowledge**：拉 `content`。除原有 owner / project 范围、来源引用和原文读取外，还接受 `content_ref`：校验路径为绝对路径、`bytes` 为非负整数、`sha256` 为 64 位十六进制、`media_type` 为 `text/plain`，并要求 `body` 与 `raw` 的引用一致。检索文本仍来自 `body`，因此大输出按引用路径可检索，正文需按引用读取文件并校验哈希。知识库不复制 blob，也不读取任意路径。
- **Agent Journal**：按日拉取 `content` 增量生成日报；证据与日报产物留在 Journal 自己的数据库和输出目录，不与 Stats / Knowledge 共享游标。
- 各消费方都必须以 `archive_id` 区分内容库与元数据库，不能混用游标。删除墓碑仍会清除证据投影与统计会话，Trace 侧同时删除 blob。

## 配置与启动

以明确项目为范围、使用独立库与独立 blob 目录的示例见 [agent-trace.content.example.json](../agent-trace.content.example.json)。要点：

- `database` 使用与 metadata 库不同的文件（例如 `content-state/trace-content.sqlite`）。
- `content.blob_directory` 指向同一个私密目录，不与源日志、代码仓库同目录。
- 每个来源的 `projects[].cwd_allowlist` 明确列出允许的项目目录，不写整个 home 或 `/`。
- 首次回补用 `backfill: "all"`，之后改回 `"none"`；回补前确认磁盘、隐私与保留期。
- 给已有 content 库增加项目范围时，先改配置并重启 content `serve`。如果 `backfill: "none"` 已把旧文件记为基线，新范围内的旧文件不会自动回补；需要对选定文件显式导入，或临时使用 `backfill: "all"` 完成一次回补后改回 `"none"`。
- 同步修改消费方的项目授权：Stats 正文查看从 content 配置派生项目范围；Knowledge 必须把新项目加入 `allowed_project_ids`，否则 follow 会以 `FORBIDDEN` 退出。
- API 客户端沿用 `token_sha256`；Knowledge 只授权 `content`，Stats 只授权 `metadata`；需要同时读两个归档时使用不同配置与游标。

启动前只做校验，不建库、不扫描：

```sh
npm run cli -- config-check --config /absolute/path/agent-trace.content.example.json
```

确认后前台启动：

```sh
npm run cli -- serve --config /absolute/path/agent-trace.content.example.json
```

## blob 回收

`gc` 删除配置目录里名字形如 `<event_id>-<sha256>.txt` 且没有任何已提交事件引用的文件。只删除配置的 blob 目录下的这一类文件名，不会碰其他文件。

```sh
npm run cli -- gc --config ~/.local/share/agent-observatory/agent-trace/content.json --dry-run
# 检查配置和预览结果后，才显式执行实际 gc
npm run cli -- gc --config ~/.local/share/agent-observatory/agent-trace/content.json
```

- 正常运行时孤儿文件应保持为 0：导入器只在确认会提交该 revision 后保留 blob，旧 revision、已删除会话、冲突和存储 / SQL 异常都会清掉本次写入但没有已提交事件引用的文件。
- 只有进程在写 blob 与提交事务之间被强杀（例如 `kill -9`、崩溃）才会留下孤儿；安装器启动前会回收一次，长期运行建议定期执行 `gc`。
- 归档保留期仍由使用者决定：`gc` 只清未被引用的文件，不按时间删除事件或 blob。

## 常驻运行（macOS launchd）

**仅源码仓库提供安装器，发行包不包含该脚本。** 安装器使用隔离的登录项和状态路径，不自动读取其他配置；显式传入其他配置会操作该配置指向的数据。

| 登录项 | 作用 | 默认日志目录 |
| --- | --- | --- |
| `local.agent-observatory.trace-content` | Trace content `serve` | `~/.local/share/agent-observatory/agent-trace/` |
| `local.agent-observatory.knowledge-follow` | Knowledge `follow` | `~/.local/share/agent-observatory/agent-knowledge/` |

```sh
npm run install:content -- --dry-run
npm run install:content -- --apply   # 确认隔离配置后才执行
npm run install:content -- --uninstall --apply
```

安装、卸载均需 `--apply`，与 `--dry-run` 互斥；预览不读取配置或 token、不启动子进程或 launchctl。默认配置 `~/.local/share/agent-observatory/agent-trace/content.json`、令牌同目录 `content.token`、Knowledge follow 配置 `~/.local/share/agent-observatory/agent-knowledge/content.follow.json`；Knowledge 源码默认同级 `../agent-knowledge`。可用 `--config`、`--token-file`、`--knowledge-follow`、`--knowledge-dir`、`--no-knowledge` 覆盖。

行为与边界：

- 安装器不会替你开启采集：配置必须已是 `capture_mode: "content"` 且 `collection.enabled = true`；不满足就报错退出。
- 安装顺序为“校验配置和必要凭证 → 创建隔离状态目录和日志 → 停止隔离任务 → `gc` → 写入 plist → bootstrap”。先停再回收，避免删除正在写入的 blob；`gc` 失败则中止安装。配置可能显式指向非隔离库或 blob，操作前必须人工核对。
- 两个任务都是 `RunAtLoad` + `KeepAlive` + `ThrottleInterval=30`；崩溃后由 launchd 重启，重启会重新获取采集租约、从已提交游标继续。
- Knowledge follow 的明文 token 只写进其 plist 的 `EnvironmentVariables`（plist `0600`），不写入日志；Trace 侧配置只保存 `token_sha256`。`--dry-run` 不读取令牌文件。
- 常驻不改变协议：仍是单归档租约、单 worker、按 `archive_id` 独立游标；Stats 继续只读 metadata。
- 首次回补仍是显式动作。已回补过的库把 `collection.backfill` 改回 `"none"`，否则每次启动都会重扫全部历史（去重后事件不重复，但会浪费时间）。

## 当前限制

- 脱敏仍是启发式：自由散文、代码片段和私有格式中的密钥可能漏检；已知过匹配为 `Basic` / `Digest` / `Token` 后跟普通单词时的误伤，修正规则需要同时评估漏检。
- 未实现按时间删除事件、blob 加密或独立保留期策略；`gc` 只清理未被引用的 blob。
- 未把外置正文复制进 Knowledge 数据库；大输出检索命中基于引用元数据，正文读取需要访问对应 blob 并校验哈希。
- 未做按项目过滤的 content 流；窄范围仍需独立归档。
- 未对真实宿主的长周期磁盘增长、休眠唤醒和跨机部署做自动保障，需要按部署环境自行监控与演练。
