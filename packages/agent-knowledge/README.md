# Agent Knowledge · 知续

让知识流动，让经验延续。

Agent Knowledge 让 agent 从文档和代码获取知识，从执行归档中核对证据，并通过 MCP 在后续会话中复用。它面向本机单用户：索引受配置限制的源目录，检索时按项目范围过滤并核验来源版本。

本文只描述当前实现。工具集入口见 [根 README](../../README.md)。

## 定位

- **有来源的本地检索**：导入指定目录中的 Markdown、文本和代码，按原文片段和行号返回结果；每次查询和读取都会核对当前文件与源版本。
- **执行归档证据**：通过版本化 content 批次消费 [agent-trace](../agent-trace/README.md) 的执行证据，与 `allowed_project_ids` 范围一起使用；归档证据是历史观察，不会自动变成已确认知识。
- **只读 MCP**：通过 STDIO 暴露知识读取和归档证据读取工具；导入、删除和重建索引由 CLI 管理。
- **独立运行**：文档和代码索引不依赖 Trace，使用内置文件扫描器即可完成 `sync`、`search`、`read`；`follow` 是可选的数据源接入方式。

当前没有对话记忆提取、模型提供方、经验反馈、自动 skill 修改或团队多用户权限；归档证据入库后也不会被自动晋升为确认事实。

## 独立安装后使用

无需 Trace。在用户自己的可写项目中安装发行包后，可以直接运行随包提供的合成内存示例（使用包内已构建的 JavaScript，并自行创建和删除临时数据库）：

```sh
node node_modules/agent-knowledge/examples/memory-scanner.mjs
```

要使用本地文档 CLI，把发行包中的 `agent-knowledge.example.json` 和 `fixtures/` **复制到可写目录**后再使用；不要把运行库或数据库写进 `node_modules`。数据库和源目录的相对路径都以复制后的配置文件所在目录为基准。完整的复制、`sync`、`search` 命令和自定义目录配置见[来源与适配器](docs/SOURCES.md)。普通用户不需要在已安装包中执行构建。

## 源码开发

本地文档和代码的 `sync`、`search`、`read` 可独立使用，不需要 Trace。程序化接入、自定义扫描器信任边界和无 Trace 的内存示例同样见[来源与适配器](docs/SOURCES.md)。

要求 Node.js **24.15.0+**。SQLite 使用 Node 内置的 `node:sqlite`，无需额外数据库服务。

在源码目录执行：

```sh
npm ci
npm run build
npm run cli -- sync --source demo
npm run cli -- search --query "刷新令牌保存在哪里" --project demo
```

默认使用[合成样例配置](agent-knowledge.example.json)，只索引项目内的 `fixtures/` 示例文档和代码，不读取历史聊天或用户其他目录。搜索返回记录 ID、原文、相对路径、行号、源版本和文件 SHA-256；使用 `read --id <记录ID>` 核对完整记录。

生产入口是 `node dist/interfaces/cli.js`，源码开发入口是 `npm run cli --`。示例配置沿用存量数据库路径 `.knowrelay/knowledge.sqlite`，以兼容已有本地知识数据；该隐藏目录只存放运行数据。

## 归档证据与自动拉取

- 手动导入：`archive-import --input BATCH_JSON` 导入 v1 content 批次；`archive-search` / `archive-read` 按项目和事件核对来源。
- 自动拉取：`agent-knowledge follow --config <follow.json>` 启动独立 worker，持续读取 Trace 的 content 页。它的业务游标、单 worker 租约和重试都在本项目内，与 MCP 生命周期分离。
- 归档证据保存在 `<配置 database>.archive-evidence.sqlite`，与活跃知识库分开；证据投影和游标同事务提交，删除标记随页传播。
- `allowed_project_ids` 对归档是**消费范围**：名单外事件（含删除标记）被跳过、不写库，游标仍前进；显式查询名单外项目仍返回 `FORBIDDEN`。
- 缩小或扩大消费范围都不会改动已有证据：缩小时不清理已导入证据，扩大时不回填已跳过的历史。

配置、命令、follow 状态和故障语义见[运行指南](docs/running.md)。

## MCP 与 skill

MCP 服务通过 STDIO 提供四个只读工具：`search_context`、`read_record`、`search_archive`、`read_archive_event`。它不提供导入、任意路径读取、身份设置或记忆写入；导入与删除由 CLI 完成。

```sh
node dist/interfaces/cli.js serve --config /absolute/path/to/agent-knowledge.example.json
```

将 `skills/agent-knowledge` 安装到宿主实际使用的技能目录后，agent 会在任务开始时按需检索知识、读取来源核实，并在获得新事实或验证结果时保存有来源的记忆（写入工具尚未实现，skill 不会虚构这些能力）。兼容目录 `skills/knowrelay` 只作为旧名称入口。

宿主接入、工具参数和边界见[运行指南](docs/running.md)。

## 文档索引

- [运行指南](docs/running.md)：安装、配置、同步与读取、删除、归档证据、follow、MCP 与当前边界。
- [架构](docs/architecture.md)：职责、边界、技术结构、存储接口、检索与数据可靠性。
- [来源与适配器](docs/SOURCES.md)：独立安装示例、程序化扫描器契约与信任边界。
- [知识使用 skill](skills/agent-knowledge/SKILL.md)：检索、来源核实、记忆保存的行为约定。
- 根文档：[架构](../../docs/ARCHITECTURE.md)、[开发指南](../../docs/DEVELOPMENT.md)、[安全说明](../../docs/SAFETY.md)、[命名规则](../../docs/NAMING.md)、[当前任务](../../TODO.md)。
