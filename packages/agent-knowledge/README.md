# Agent Knowledge · 知续

> 本文是随代码保留的历史模块文档；其中真实部署与运行声明不构成本新项目的验证。工具集入口见[根文档](../../README.md)。当前项目验证见[验证记录](../../docs/VALIDATION.md)。独立源码副本中的数据源说明见[来源说明](docs/SOURCES.md)。

让知识流动，让经验延续。

让 agent 从文档和代码获取知识，从对话和执行结果沉淀经验，并在后续会话中复用。

当前状态：第一阶段本地知识检索已实现；新增共享归档批次的执行证据导入、独立游标、按项目搜索/读取和删除传播，以及独立的 `follow` 自动拉取 worker。自动经验提取与晋升尚未实现。此前以 KnowRelay 名称完成 Codex 全新会话中的合成知识检索、显式 skill 调用、文件更新/删除及无工具拒答验收；更名后已完成 40 项测试、类型检查、构建及跨项目回归，尚未重新运行真实 Codex 宿主验收。自动选择此前未观察到 skill 触发。尚未全局安装、导入真实试点资料或启用自动聊天采集。

项目命名与迁移规则见[统一命名说明](../../docs/NAMING.md)。

`agent-knowledge follow --config <follow.json>` 主动拉取 Trace content 页，进度、重试和授权检查留在本项目；worker 与 MCP 生命周期分离，不由 Trace 运行导入命令，也不读取源日志。手动 `archive-import` 继续保留。方案不用 hook，暂不增加自动经验提取。见[运行指南](docs/running.md#trace-自动拉取follow)、[消费方约定](../agent-trace/docs/consumer-follow.md)和[实施 TODO](../../docs/ROADMAP.md)。

## 独立安装后使用

无需 Trace。在用户自己的可写项目中安装发行包后，运行随包提供的合成内存示例：

```sh
node node_modules/agent-knowledge/examples/memory-scanner.mjs
```

要使用本地文档 CLI，将发行包中的 `agent-knowledge.example.json` 和 `fixtures/` **复制到可写目录**后再使用；不要直接使用 `node_modules` 中的配置，否则数据库会写到包目录。完整的复制、sync、search 命令和自定义目录配置见 [来源与适配器](docs/SOURCES.md#installed-package-no-source-checkout)。普通用户不需要在已安装包中运行 `npm run build`。

## 源码开发

本地文档/代码的 `sync`、`search` 和 `read` 可独立使用，不需要 Trace。程序化接入、自定义扫描器信任边界和无 Trace 的内存示例见 [来源与适配器](docs/SOURCES.md)。以下命令仅适用于源码目录，非 npm 安装目录。

要求 Node.js **24.15 或更高版本**。SQLite 使用 Node 内置驱动，无需额外数据库服务。

```sh
npm ci
npm run check
npm run cli -- sync --source demo
npm run cli -- search --query "刷新令牌保存在哪里" --project demo
```

默认使用 [合成样例配置](agent-knowledge.example.json)，只导入项目内的示例文档和代码，不读取历史聊天或用户其他目录。搜索返回记录 ID、原文、路径、行号、源版本及 SHA-256；使用 `read --id <记录ID>` 核对完整记录。

示例配置沿用存量数据库路径 `.knowrelay/knowledge.sqlite`，以兼容已有本地知识数据；该隐藏目录仅存放运行数据。

```sh
node dist/interfaces/cli.js read --id RECORD_ID
node dist/interfaces/cli.js serve --config /absolute/path/to/agent-knowledge.example.json
```

`npm run check` 会构建 `dist`。MCP 暴露知识读取 `search_context`、`read_record` 和归档证据读取 `search_archive`、`read_archive_event`；导入、删除和重建索引由 CLI 管理。配置、更新与删除、Codex 接入及限制见 [运行指南](docs/running.md)，实际测试结果见 [验证记录](docs/validation.md)。

使用 `npm run verify:codex -- --case all` 重跑显式调用、自动选择和文件生命周期的合成客户端验收；`--case unavailable` 单独验证无工具拒答。脚本仅在隔离目录安装带探针的 skill 副本，保留调用记录，证据不足不会记为通过。

## 已确定的方向

新增共享归档消费：在独立 [agent-trace](../agent-trace/README.md) 明确采集选定会话后，使用 `archive-import --input content-page.json` 导入 v1 content 批次。`archive-search --query TEXT [--project ID]` 检索，`archive-read --archive ARCHIVE_ID --event EVENT_ID` 核对来源。归档证据保存在 `<配置database>.archive-evidence.sqlite`，与活跃知识分开，不依赖原日志仍存在，也不会把工具输出或 agent 声明自动升为确认事实。`follow` 使用同一证据库保存业务游标和单 worker 租约；每页与游标同事务提交，删除标记随页传播。`allowed_project_ids` 是归档的**消费范围**而不是投递门槛：页面中名单外项目的事件（含删除标记）在导入时跳过、不写库，游标照常提交前进，不会因 Trace 新增项目或全量采集而停摆；显式查询名单外项目仍按 `FORBIDDEN` 拒绝。缩小或扩大消费范围都不会迁移已导入数据：缩小时已有证据保留、不自动清理，扩大的历史不会回填（游标已前进）；需要重建时显式删除证据库并从 0 回放。

- 首先接入 Codex，后续扩展其他 agent。
- 首先在本机验证，再部署团队共享服务。
- 知识和记忆由独立服务管理，agent 通过适配器接入。
- 自主实现统一内核；参考 Graphiti、Letta、graphify、agentmemory 的机制，通过通用库完成解析、存储和协议接入。
- 自学习先实现为有证据、可回滚的记忆和流程改进。
- 模块通过领域接口协作；SQLite 是首个存储适配器，后续数据库实现遵守同一行为契约。
- 第一轮包含 Agent Knowledge 使用 skill，指导检索、核对来源与保存经验；Agent Stats 通过可选用量适配器后续接入。
- 每日回顾由独立 [Agent Journal](../agent-journal/README.md) 消费 Trace content 并输出 Markdown；Knowledge 只按 source 目录索引，且需要 source 级 `generated` 标记（未实现），避免把模型生成物当作来源事实。

## 实施顺序

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| 1. 知识检索 | 导入指定目录内的 Markdown、文本和代码，提供搜索与来源读取 | Codex 在新会话中回答预先准备的问题，引用正确的文件和版本；修改、删除文件后结果同步更新 |
| 2. 对话记忆 | 采集试点会话的新增事件，提取偏好、决策和经验候选，支持修正与删除 | 新会话复用上次的明确决策；重复事件不会重复写入；推测不会变成已确认事实 |
| 3. 持续改进 | 根据任务结果验证经验，记录有效和失效反馈 | 相似任务能召回已验证经验；错误经验可撤回；流程修改有验证结果和回滚点 |
| 4. 团队共享 | 增加身份、服务端权限、项目与团队共享范围，再接入第二种 agent | 不同 agent 能复用同一条授权经验，未授权主体无法通过搜索或直接读取获取内容 |

首个试点使用用户明确选择的一组文档与一个代码目录。在选择之前，使用项目内的合成示例验证，不批量导入历史聊天。

## 第一项开发任务与进度

本地知识检索闭环：目录导入 → 索引更新 → MCP 搜索与读取 → Codex 新会话引用来源。已完成应用测试、STDIO 协议测试及真实客户端合成验收；真实资料的检索质量仍需试点验证。

实现使用 TypeScript、本地 SQLite 存储和 STDIO MCP 接口。应用层通过存储、扫描和检索端口调用适配器；后续模型提取器另行实现。先验证检索质量，再根据中文和代码问题的实际结果决定是否加入向量检索。

详细数据约定、Codex 接入边界和验收案例见 [MVP 方案](docs/mvp.md)，实现边界和模块划分见 [架构决策](docs/architecture.md)。

## 使用 skill

第一轮交付包含 [Agent Knowledge skill](skills/agent-knowledge/SKILL.md)：任务开始按需检索相关知识和经验，读取来源核实后使用，在获得新事实或验证结果时保存有来源的记忆。

当前 skill 位于项目内，已在隔离工作目录安装副本并验证显式调用，尚未全局安装。查询与读取工具已实现；保存记忆和反馈仍在后续阶段。历史显式调用验证使用旧 skill 名称 `$knowrelay`；新名称 `$agent-knowledge` 尚未在真实客户端重新验收。自动选择由宿主根据 skill 描述决定；本次未观察到触发，已保存对应调用记录，不保证每次自动启用。

## 官方接入资料

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：外部知识和记忆工具的入口。
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)：后续接入评估资料；本阶段明确不用 hook，采用 Trace 日志扫描。
- [Codex Memories](https://learn.chatgpt.com/docs/customization/memories)：原生本地记忆的能力与控制方式。

资料核对日期：2026-11-08。MCP 已完成本机合成验收；Hooks 与记忆采集仍待后续实现及客户端验证。

## 参与贡献

CI 会在每个 Pull Request 上运行 Node 24.15.0 的 typecheck / 测试 / 构建，以及敏感信息扫描，结果汇总为 `CI success`，`main` 要求该检查通过后才能合并。分支与合并、本地检查、CI 与分支保护、敏感信息检查的说明见 [CONTRIBUTING.md](CONTRIBUTING.md)；所有改动走 Pull Request，合并前在最新 `main` 上复跑 `npm run check`，涉及宿主接入或 skill 行为变化再跑 `npm run verify:codex`。
