# 离线活动数据源

## 安全试用随包示例

npm 包内提供 `examples/custom-config.json` 和 `examples/custom-activity.json`。先把**两个文件**从安装包的 `examples/` 复制到用户可写目录（以下假设在本地 npm 安装的项目中操作）：

```sh
mkdir -p ./journal-demo
cp ./node_modules/agent-journal/examples/custom-{config,activity}.json ./journal-demo/
./node_modules/.bin/agent-journal import --config ./journal-demo/custom-config.json --file ./journal-demo/custom-activity.json
./node_modules/.bin/agent-journal dream --config ./journal-demo/custom-config.json --date 2026-01-01 --no-sync --no-model
```

配置中的相对路径以配置文件所在目录为基准，因此产物写入 `journal-demo/.agent-journal/`，**不会**写进 `node_modules`。在源码仓库中，从本模块的 `examples/` 目录复制同样的两个文件，并用构建好的 `dist/cli.js` 代替已安装的命令行入口。这样只导入本地 JSON 并渲染确定性日报，不需要 Trace 进程、token、网络或模型。离线使用时，配置中的 `trace_url` 和 `token_env` 仍须语法有效，但导入过程不会使用它们的值。使用该示例前，需要把 `demo` 加入配置的 `projects`。

只有源码仓库包含 `scripts/install-macos-service.ts`，它不属于 npm 发行包。安装和卸载操作都需要在审阅 `--dry-run` 后显式提供 `--apply`；离线示例不需要安装器。

## 活动快照格式

快照是一个 JSON 对象，包含稳定且非空的 `source` 标识和 `activities` 数组。每条活动包含：

| 字段 | 契约 |
| --- | --- |
| `id` | 唯一且稳定的标识 |
| `project` | 必须出现在配置的 `projects` 中 |
| `session` | 会话标识；同一会话不能跨项目 |
| `at` | UTC 时间戳，精确到毫秒，例如 `2026-01-01T10:00:00.000Z` |
| `kind` | `user`、`assistant` 或 `final` |
| `text` | 非空文本，上限 100,000 字符 |

所有字段必填，未知字段会被拒绝。写入数据库时，现有的事件压缩逻辑会把文本截断到 8,000 字符。时间戳同时作为发生时间和观测时间。

## 追加与幂等语义

每次都必须提供**完整、只追加的快照**：按原顺序精确保留所有已有条目（包括 `id`），新条目追加在末尾。

- 原样重放未变化的条目是空操作。
- 重复 `id`、被修改或重排的条目、比已提交前缀更短的快照，以及不同的 `source` 标识都会被拒绝。
- 导入按条目逐条提交，因此失败的导入可能留下已提交的前缀；重新运行同一快照即可继续。
- 一个数据库只能绑定一个自定义数据源或一个 Trace 归档，不能同时绑定两者。每个数据源使用独立数据库，不要为不同数据集复用同一 `source` 标识。
- 该最小格式不支持删除标记，也不支持工具调用和用量等更丰富的事件。

## 程序化接入

程序化消费者可以从包入口调用 `parseActivitySnapshot` 和 `importActivitySnapshot`。`SyncOptions.client` 是结构化的 Trace 协议客户端，用于接入与 Trace 兼容的传输层；自定义活动不需要那层 HTTP 信封。
