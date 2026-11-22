# Agent Observatory

Agent 执行观察与经验沉淀工具集：**一个仓库开发，四个功能独立安装，数据源可替换。**

## 模块

| 模块 | 职责 | 不运行 Trace 的用法 |
| --- | --- | --- |
| [Agent Trace](packages/agent-trace/README.md) | 采集 Codex / pi / dsh 日志，归档执行证据 | 本身是可选的证据基础设施，不依赖其他模块 |
| [Agent Stats](packages/agent-stats/README.md) | 用量、费用、会话统计与本地看板；可选 Knowledge 检索页 | 原生 Codex 日志，或标准化 session JSON / Python provider |
| [Agent Journal](packages/agent-journal/README.md) | 活动导入、确定性日报、可选模型总结 | 自己的 activity JSON，离线生成日报 |
| [Agent Knowledge](packages/agent-knowledge/README.md) | 本地知识索引、检索、来源核验与 MCP | 本地文档，或自定义 SourceScanner |

Trace 是默认可选数据来源，**不是其他三个模块的安装依赖**。Stats、Journal、Knowledge 的核心功能都使用自己的输入独立运行；自定义来源与正常运行不读取其他模块数据库。Stats 保留对显式配置的 Trace 正文库的只读下钻，独立使用时可用 `--no-content` 关闭；Knowledge 页也只在显式配置时按需调用 Knowledge CLI，不打开其数据库。不存在必须安装的总控服务或巨型 core 包，Node 与 Python 各自保留合适的工具链。

## 开发安装

要求 Node.js **24.15.0+**、npm **11+**、Python **3.9+**；打 Python wheel 还需要 pip、setuptools、wheel。

```sh
npm ci --cache .cache/npm
npm run check
```

根目录 npm workspace 管理三个 Node 包；Python Stats 在同一仓库独立打包。Stats 前端不是公共 npm 包，开发它时见[前端说明](packages/agent-stats/docs/FRONTEND.md)。根命令不会自动扫描真实会话、启动服务、访问模型或安装登录项。

## 先试不依赖 Trace 的功能

以下示例都使用合成数据，不需要 token、真实宿主日志或模型密钥。

### Stats：自己的统计数据

```sh
cd packages/agent-stats
mkdir -p .agent-stats
python3 -m agent_stats example --output .agent-stats/custom.json
python3 -m agent_stats --db .agent-stats/custom.sqlite import-json --input .agent-stats/custom.json
python3 -m agent_stats --db .agent-stats/custom.sqlite summary
# 可选：仅展示已导入的数据，不扫描本机 Codex，不连接 Trace 正文服务
python3 -m agent_stats --db .agent-stats/custom.sqlite serve --archive-only --no-content
```

输入格式见[Stats 数据源契约](packages/agent-stats/docs/SOURCES.md)。

### Journal：自己的活动记录

从仓库根目录运行（先完成构建）：

```sh
npm run build --workspace agent-journal
mkdir -p .agent-observatory-demo/journal
cp packages/agent-journal/examples/custom-config.json .agent-observatory-demo/journal/config.json
cp packages/agent-journal/examples/custom-activity.json .agent-observatory-demo/journal/activity.json
node packages/agent-journal/dist/cli.js import --config .agent-observatory-demo/journal/config.json --file .agent-observatory-demo/journal/activity.json
node packages/agent-journal/dist/cli.js dream --config .agent-observatory-demo/journal/config.json --date 2026-01-01 --no-sync --no-model
```

日报写到可写示例目录下的 `.agent-journal/daily/2026-01-01.md`，不会写入安装包目录。离线 import 不读取配置中的 Trace 字段，也不联网；不要用 `sync` / `run` 代替离线命令。自定义输入是完整的不可变追加快照，暂不支持删除，详见[Journal 数据源契约](packages/agent-journal/docs/SOURCES.md)。

### Knowledge：自己的知识来源

```sh
node packages/agent-knowledge/examples/memory-scanner.mjs
```

示例创建临时库、注入内存 scanner、检索合成知识并清理临时目录，不需要 Trace。要索引本地文件，见[本地使用说明](packages/agent-knowledge/docs/running.md)。

## 只安装一个模块

目前尚未向 npm / PyPI 发布，也未确认公共包名是否可用。先生成本地独立发行物：

```sh
npm run pack:modules
```

然后按需安装**其中一个**，无需安装其余模块：

```sh
npm install /absolute/path/to/agent-trace-0.1.0.tgz
npm install /absolute/path/to/agent-journal-0.1.0.tgz
npm install /absolute/path/to/agent-knowledge-0.1.0.tgz
python3 -m pip install /absolute/path/to/agent_stats-0.1.0-py3-none-any.whl
```

发行物位于 `artifacts/`。Node 包导出 JavaScript API 与 TypeScript 声明，CLI 使用编译后的 JavaScript，不要求用户安装 TS 编译器。Knowledge 安装自身的 MCP / 校验依赖，但不安装 Trace。源码级 macOS 安装脚本仅供仓库开发者使用：默认使用隔离服务名和状态目录，实际安装 / 卸载必须显式 `--apply`；`--dry-run` 不修改服务。运行前请读[安装器安全说明](docs/SAFETY.md)。

Git monorepo 默认仍会 clone 全仓库；独立发行包解决的是安装范围，不等于四个独立 Git 仓库。

## 文档

- [架构与依赖边界](docs/ARCHITECTURE.md)
- [开发、验证、CI 与发布](docs/DEVELOPMENT.md)
- [安装器安全与服务隔离](docs/SAFETY.md)
- [命名规则](docs/NAMING.md)
- [路线图](docs/ROADMAP.md)
- [当前执行待办](TODO.md)

各模块的命令、配置与输入契约见对应包的 README 与 `docs/`。

代码没有新增许可证授权；对外发布前需要确认原始代码与素材的授权，并核对公共包名、组织与发布权限。
