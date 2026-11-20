# Agent Observatory

Agent 的执行观察与经验沉淀工具集：**一个仓库开发，四个功能独立安装，数据源可替换。**

| 模块 | 职责 | 不运行 Trace 的用法 |
| --- | --- | --- |
| [Agent Trace](packages/agent-trace/README.md) | 采集 Codex / pi / dsh 日志，归档执行证据 | 本身是可选基础设施，不依赖其他模块 |
| [Agent Stats](packages/agent-stats/docs/SOURCES.md) | 用量、费用、会话统计与本地看板 | 原生 Codex 日志，或自己的标准化 session JSON / Python provider |
| [Agent Journal](packages/agent-journal/docs/SOURCES.md) | 日志回顾、确定性日报、可选模型总结 | 自己的 activity JSON，离线生成日报 |
| [Agent Knowledge](packages/agent-knowledge/docs/SOURCES.md) | 本地知识索引、检索与来源核验 | 本地文档，或自定义 SourceScanner |

Trace 是默认可选数据来源，**不是其他三个包的安装依赖**。自定义来源与核心功能无需读取其他模块数据库。Stats 保留原有的可选 Trace 正文只读下钻（会读取显式配置的 Trace 库）；独立使用时可用 `--no-content` 关闭。不存在必须安装的总控服务或巨型 core 包。Node 与 Python 保留各自适合的工具链。

## 开发安装

要求 Node.js **24.15.0+**、npm **11+**、Python **3.9+**；打 Python wheel 还需要 pip、setuptools、wheel。

```sh
npm ci --cache .cache/npm
npm run check
```

根目录 npm workspace 管理三个 Node 包；Python Stats 在同级目录独立打包。Stats 前端不是公共 npm 包，开发它时另见[前端指南](packages/agent-stats/docs/FRONTEND.md)。根命令不会自动扫描真实会话、启动服务、访问模型或安装登录项。

## 先试不依赖 Trace 的功能

以下都是合成数据，不需要 token、真实宿主日志或模型密钥。

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

### Journal：自己的活动记录

从仓库根目录运行（先完成构建）：

```sh
mkdir -p .agent-observatory-demo/journal
cp packages/agent-journal/examples/custom-config.json .agent-observatory-demo/journal/config.json
cp packages/agent-journal/examples/custom-activity.json .agent-observatory-demo/journal/activity.json
node packages/agent-journal/dist/cli.js import --config .agent-observatory-demo/journal/config.json --file .agent-observatory-demo/journal/activity.json
node packages/agent-journal/dist/cli.js dream --config .agent-observatory-demo/journal/config.json --date 2026-01-01 --no-sync --no-model
```

日报写到可写示例目录下的 `.agent-journal/daily/2026-01-01.md`，不会写入安装包目录。配置中 Trace 字段为旧配置兼容保留，离线 import 不使用；不要用 `sync` / `run` 代替离线命令。自定义输入是完整的不可变追加快照，暂不支持删除，详见[输入契约](packages/agent-journal/docs/SOURCES.md)。

### Knowledge：自己的知识来源

```sh
node packages/agent-knowledge/examples/memory-scanner.mjs
```

示例创建临时库、注入内存 scanner、检索合成知识并清理临时目录，无 Trace。要索引本地文件，见[本地使用说明](packages/agent-knowledge/docs/running.md)。

## 只安装一个模块

目前尚未向 npm / PyPI 发布，也未确认公共包名是否可用。先生成本地独立发行物：

```sh
npm run pack:modules
```

然后按需安装 **其中一个**，无需安装其余模块：

```sh
npm install /absolute/path/to/agent-trace-0.1.0.tgz
npm install /absolute/path/to/agent-journal-0.1.0.tgz
npm install /absolute/path/to/agent-knowledge-0.1.0.tgz
python3 -m pip install /absolute/path/to/agent_stats-0.1.0-py3-none-any.whl
```

发行物位于 `artifacts/`。Node 包导出 JavaScript API 与 TypeScript 声明，CLI 使用编译后的 JavaScript，不要求用户安装 TS 编译器。Knowledge 安装其自身 MCP / 校验依赖，但不安装 Trace。源码级 macOS 安装脚本仅供仓库开发者使用：默认使用隔离服务名和状态目录，实际安装 / 卸载必须显式 `--apply`；`--dry-run` 不修改服务。本次不执行真实部署。显式指定旧配置仍可能触及原数据，运行前请读[安装器安全说明](docs/SAFETY.md)。

如果希望只下载一个模块的**源码**，Git monorepo 默认仍会 clone 全仓库；独立发行包解决的是安装范围，不等于四个独立 Git 仓库。

## 文档与验证

- [项目 Review：使用追踪、消耗、复盘与经验沉淀](docs/REVIEW-2026-11-15.md)
- [架构与依赖边界](docs/ARCHITECTURE.md)
- [数据源接入指南](docs/DATA-SOURCES.md)
- [安装、开发与发布](docs/DEVELOPMENT.md)
- [安装器安全与服务隔离](docs/SAFETY.md)
- [迁移记录与原代码保护](docs/MIGRATION.md)
- [验证结果与已知限制](docs/VALIDATION.md)
- [当前执行待办](TODO.md) · [后续规划](docs/ROADMAP.md)
- [GitHub 配置与迁移状态](docs/GITHUB.md)
- [历史 TODO / Review 原文归档](docs/history/README.md)
- [命名规则](docs/NAMING.md)

```sh
npm run verify:consumers   # Trace → Stats / Knowledge 的合成端到端验证
npm run verify:follow      # 合成 Trace 服务及两个 follow worker 的进程测试
npm run verify:sources     # 无兄弟目录的完整单模块源码测试，拒绝 skip
npm run verify:packages    # 仅用安装包内的示例和资源，不回读仓库示例
npm run check:sensitive    # 凭证与敏感文件扫描；历史归档不豁免
npm run check:privacy      # 公开前严格路径隐私检查（原文归档目前会报告一处路径）
npm run verify:originals   # 仅迁移现场可用：检查相邻原项目 SHA-256 / Git 状态
```

本项目是对现有代码的独立副本整理，不包含原项目 Git 历史、个人数据库、密钥、真实日报、node_modules 或已有登录项配置。原模块文档保留作功能参考；涉及新目录与安装方式时，以本 README 和根 docs 为准。代码没有新增许可证授权；对外发布前需要确认原始代码与素材的授权。
