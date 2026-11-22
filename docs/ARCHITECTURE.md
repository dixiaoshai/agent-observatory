# 架构与依赖边界

## 总览：monorepo + 独立发行

Agent Observatory 是一个源码仓库里的四个可独立安装工具，不是必须部署的运行时。三个 Node 包使用 npm workspaces，Stats 使用 Python setuptools。模块保持现有名称和命令，分别构建、分别发行；不要求锁步升级。当前版本均为 0.1.0，不代表已发布。

```text
packages/
  agent-trace/       # Node，采集与归档
  agent-stats/       # Python；frontend 为私有构建项目
  agent-journal/     # Node，日报
  agent-knowledge/   # Node，知识索引与 MCP
```

各模块自行定义输入契约，不把所有领域压进一个万能 DataSource。

## 依赖与数据流

Trace 是默认可选数据来源，不是其他模块的安装依赖。数据流描述的是可选协作，不是包依赖：

```text
Codex / pi / dsh → Trace → metadata → Stats
                        content  → Journal
                        content  → Knowledge 证据库
自定义用量            → Stats provider / JSON importer
自定义活动            → Journal activity importer
本地文件 / 自定义 scanner → Knowledge 文档索引
本地知识库            → Knowledge CLI（按需进程调用）→ Stats Knowledge 页
```

| 消费模块 | 自有输入 | 可选默认适配器 |
| --- | --- | --- |
| Stats | SourceProvider → 标准化 session / turn / usage | 直接 Codex reader；Trace metadata importer / follow；Knowledge CLI 按需检索（显式配置） |
| Journal | JournalActivitySnapshot → 现有日期投影与缓冲 | Trace content client / sync |
| Knowledge | SourceScanner → 文档完整快照 | 内置文件 scanner；Trace evidence 为独立可选路径 |

## 数据源接入契约

需要完整执行证据时，使用可选 Trace 的[采集说明](../packages/agent-trace/README.md)与[协议](../packages/agent-trace/docs/protocol.md)。metadata 与 content 数据库 / 权限应明确分离，消费方各自维护游标。新 provider 不应通过读取其他模块 SQLite 表来省略接口边界。

### Stats：标准化 session 快照

[输入格式与 Python API](../packages/agent-stats/docs/SOURCES.md)；[合成 JSON](../packages/agent-stats/docs/custom-source.example.json)。

- CLI：`agent-stats --db DB import-json --input FILE`。
- Python：`from agent_stats.sources import import_source, import_sessions, SourceProvider`。
- 稳定身份为 source + instance + session id，turn id 在 session 内唯一。
- 完整校验批次后事务写入；相同内容跳过，变更替换整个 session，未出现的 session 不删除。
- 不接受提示正文、任意扩展字段或 Trace event；转换应在 adapter 内完成。
- 用量按 session 自有口径提供，父子继承或重叠累计需在 adapter 中去重；未知值用 null。
- 看板用 `serve --archive-only --no-content`，避免默认扫描本地 Codex / 请求 Trace 正文。

旧 `import` 仍专指 Codex，`import-archive` / `follow` 仍专指 Trace v1 metadata，不把这几个入口冒充任意来源。

### Journal：不可变追加的活动快照

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

### Knowledge：文档扫描快照

[输入契约](../packages/agent-knowledge/docs/SOURCES.md)；[内存来源示例](../packages/agent-knowledge/examples/memory-scanner.mjs)。

- CLI 默认索引配置里的本地文档，不需要 Trace。
- JS：`openApplication(configPath, { scanner })`；接口 `SourceScanner.scan(source)`。
- scanner 返回完整文件快照，包含 source-relative path、content、content_hash、git_commit 与 skipped。
- 内容 hash 必须与内容一致；缺失文件视作删除，不能拿不完整分页结果当作完整快照。
- 搜索 / 读取会再次扫描以检查新鲜度，adapter 应持续可用，不能只返回一次性数据。
- 适配器自行负责远端凭证、输入授权、路径与敏感内容检查。自定义 scanner 不自动继承文件 scanner 的安全过滤。

`archive-import` / `follow` 是可选 Trace v1 content 证据路径，和文档索引分离；执行中的 agent 自述与模型生成内容不应被自动确认为知识。

## 边界约束

1. Stats / Journal / Knowledge 的独立核心功能不依赖 Trace npm 包、数据库文件或源码。为兼容旧功能，Stats 的可选正文下钻仍直接只读配置的 Trace content 库；自定义来源不需要它，可用 `--no-content` 关闭。这是保留的可选适配器耦合，不是必须部署的基础设施。Trace 不启动下游命令，也不管理下游游标。Stats 的 Knowledge 页同样可选：只按需启动 Knowledge CLI，不打开其数据库；未配置时完全禁用。
2. 保留旧 Trace v1 协议校验，普通自定义输入不必伪造它。Journal 内部复用既有 event 投影，不把内部表示当作自定义输入要求。
3. 每个模块拥有自己的状态库、租约、事务与数据来源身份。独立安装不等于可把不同来源的状态混入同一数据库。
4. Stats 的自定义 session 身份使用独立命名空间；Journal 的一个库只能绑定一个来源；Knowledge 按 source / project / owner 约束来源。
5. 自定义 adapter 是受信任代码，不是沙箱。尤其 Knowledge 自定义 scanner 必须自行实现输入授权、目录与敏感内容保护。
6. 未知用量保留 null，不能补成 0；API 等价费用估算不冒充实际账单；归档证据不自动变成已确认知识。
7. 仓库内集成测试可以引用兄弟模块 fixtures，正常运行和发行包不可要求兄弟模块存在。源码安装器与跨模块验收命令是开发功能。

## 共享模型与拆仓库

现有 Python 与 TypeScript 跨语言、各消费方领域不同。抽取一个运行时公共包只会增加安装与版本耦合。当前共享的是上面列出的接入约定、Trace 的[协议文档](../packages/agent-trace/docs/protocol.md)与合成 fixtures；没有新建必装 core。未来确有稳定共享模型时，再抽取小范围版本化 JSON Schema 或类型，不让消费者导入 Trace 内部实现。

出现独立团队 / 权限、不同授权、互不相关的发布周期或需要独立源码分发时再拆仓库。保持每包独立构建、入口和文档，未来拆分不需要重写领域逻辑。
