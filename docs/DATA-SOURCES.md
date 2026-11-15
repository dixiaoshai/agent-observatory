# 数据源接入指南

先选你需要的功能，不需要为了接入自定义来源安装 Trace。

## Stats：标准化 session 快照

[输入格式与 Python API](../packages/agent-stats/docs/SOURCES.md)；[合成 JSON](../packages/agent-stats/docs/custom-source.example.json)。

- CLI：`agent-stats --db DB import-json --input FILE`。
- Python：`from agent_stats.sources import import_source, import_sessions, SourceProvider`。
- 稳定身份为 source + instance + session id，turn id 在 session 内唯一。
- 完整校验批次后事务写入；相同内容跳过，变更替换整个 session，未出现的 session 不删除。
- 不接受提示正文、任意扩展字段或 Trace event；转换应在 adapter 内完成。
- 用量按 session 自有口径提供，父子继承或重叠累计需在 adapter 中去重；未知值用 null。
- 看板用 `serve --archive-only --no-content`，避免默认扫描本地 Codex / 请求 Trace 正文。

旧 `import` 仍专指 Codex，`import-archive` / `follow` 仍专指 Trace v1 metadata，不把这几个入口冒充任意来源。

## Journal：不可变追加的活动快照

[输入契约](../packages/agent-journal/docs/SOURCES.md)；[合成活动](../packages/agent-journal/examples/custom-activity.json)；[离线配置](../packages/agent-journal/examples/custom-config.json)。

- CLI：`agent-journal import --config CONFIG --file FILE`。
- JS：`import { loadConfig, JournalStore, importActivitySnapshot } from 'agent-journal'`。
- 导入仅包含 user / assistant / final 活动，使用稳定 source 身份与 activity id。
- 每次提供完整历史前缀并在末尾追加；不能删、改、重排既有活动。重复前缀可重放。
- 每条活动独立提交，出错可能已提交前缀，重试同一份快照继续；不是全文件事务。
- 一个库绑定一个 custom source 或 Trace archive，切换来源用新库，不能复用游标。
- 不支持自定义删除、工具与用量事件；文本按既有日报规则压缩，不能用日报库代替原始归档。
- 本地渲染用 `dream --date YYYY-MM-DD --no-sync --no-model`，不需要模型密钥或 Trace token。

当前配置解析仍要求形式合法的 trace_url 与 token_env，仅为旧配置兼容；离线 import 不读取其值。`sync` / `run` 仍是 Trace 路径。注入的 `TraceSourceClient` 只是 Trace 协议传输接口，不是另一个通用数据协议。

## Knowledge：文档扫描快照

[输入契约](../packages/agent-knowledge/docs/SOURCES.md)；[内存来源示例](../packages/agent-knowledge/examples/memory-scanner.mjs)。

- CLI 默认索引配置里的本地文档，不需要 Trace。
- JS：`openApplication(configPath, { scanner })`；接口 `SourceScanner.scan(source)`。
- scanner 返回完整文件快照，包含 source-relative path、content、content_hash、git_commit 与 skipped。
- 内容 hash 必须与内容一致；缺失文件视作删除，不能拿不完整分页结果当作完整快照。
- 搜索/读取会再次扫描以检查新鲜度，adapter 应持续可用，不能只返回一次性数据。
- 适配器自行负责远端凭证、输入授权、路径与敏感内容检查。自定义 scanner 不自动继承文件 scanner 的安全过滤。

`archive-import` / `follow` 是可选 Trace v1 content 证据路径，和文档索引分离；执行中的 agent 自述与模型生成内容不应被自动确认为知识。

## 需要保留完整执行证据时

使用可选 Trace 的[采集说明](../packages/agent-trace/README.md)与[协议](../packages/agent-trace/docs/protocol.md)。metadata 与 content 数据库/权限应明确分离，消费方各自维护游标。新 provider 不应通过读取其他模块 SQLite 表来省略接口边界。
