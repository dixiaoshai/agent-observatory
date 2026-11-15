# 架构与依赖边界

## 选择：monorepo + 独立发行

Agent Observatory 是工具集与开发仓库，不是必须安装的运行时。三个 Node 包使用 npm workspaces，Stats 使用 Python setuptools。模块保持现有名称和命令，分别发布版本与发行物；不要求锁步升级。当前初始版本同为 0.1.0，不代表已发布。

```text
packages/
  agent-trace/       # Node，采集与归档
  agent-stats/       # Python；frontend 为私有构建项目
  agent-journal/     # Node，日报
  agent-knowledge/   # Node，知识索引与 MCP
```

各模块自行定义输入契约，不把所有领域压进一个万能 DataSource。

| 消费模块 | 自有输入 | 可选默认适配器 |
| --- | --- | --- |
| Stats | SourceProvider → 标准化 session / turn / usage | 直接 Codex reader；Trace metadata importer / follow |
| Journal | JournalActivitySnapshot → 现有日期投影与缓冲 | Trace content client / sync |
| Knowledge | SourceScanner → 文档完整快照 | 内置文件 scanner；Trace evidence 为独立可选路径 |

数据流（不是 npm 依赖）：

```text
Codex / pi / dsh → Trace → metadata → Stats
                         content  → Journal
                         content  → Knowledge 证据库
自定义用量       → Stats provider / JSON importer
自定义活动       → Journal activity importer
本地文件 / 自定义 scanner → Knowledge 文档索引
```

## 边界约束

1. Stats / Journal / Knowledge 的独立核心功能不依赖 Trace npm 包、数据库文件或源码。为兼容旧功能，Stats 的可选正文下钻仍直接只读配置的 Trace content 库；自定义来源不需要它，可用 --no-content 关闭。这是保留的历史适配器耦合，不是必须部署的基础设施。Trace 不启动下游命令，也不管理下游游标。
2. 保留旧 Trace v1 协议校验，普通自定义输入不必伪造它。Journal 内部复用既有 event 投影，不把内部表示当作自定义输入要求。
3. 每个模块拥有自己的状态库、租约、事务与数据来源身份。独立安装不等于可把不同来源的状态混入同一数据库。
4. Stats 的自定义 session 身份使用独立命名空间；Journal 的一个库只能绑定一个来源；Knowledge 按 source / project / owner 约束来源。
5. 自定义 adapter 是受信任代码，不是沙箱。尤其 Knowledge 自定义 scanner 必须自行实现输入授权、目录与敏感内容保护。
6. 未知用量保留 null，不能补成 0；API 等价费用估算不冒充实际账单；归档证据不自动变成已确认知识。
7. 仓库内集成测试可以引用兄弟模块 fixtures，正常运行和发行包不可要求兄弟模块存在。源码安装器与跨模块验收命令是开发功能。

## 为什么暂时不建 contracts 包

现有 Python 与 TypeScript 跨语言、各消费方领域不同。抽取一个运行时公共包只会增加安装与版本耦合。本次共享的是[接入约定](DATA-SOURCES.md)、Trace 的既有[协议文档](../packages/agent-trace/docs/protocol.md)与合成 fixtures；没有新建必装 core。未来确有稳定共享模型时，再抽取小范围版本化 JSON Schema 或类型，不让消费者导入 Trace 内部实现。

## 何时拆仓库

出现独立团队/权限、不同授权、互不相关的发布周期或需要独立源码分发时再拆。保持每包独立构建、入口和文档，未来拆分不需要重写领域逻辑。
