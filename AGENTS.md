# AGENTS.md

本指南适用于整个 Agent Observatory 仓库。修改前先阅读相关实现与测试，保持改动聚焦，保留用户未提交的工作；不要顺手重构、提交或推送代码。

## 项目地图与文档入口

Agent Observatory 是四个可独立安装的工具组成的 monorepo，不是必须部署的统一运行时。

| 目录 | 职责与工具链 |
| --- | --- |
| [Trace](packages/agent-trace/) | Codex / pi / dsh 日志采集、归档、metadata / content API；Node + TypeScript |
| [Stats](packages/agent-stats/) | 用量、费用与会话统计；Python 标准库后端 |
| [Stats 前端](packages/agent-stats/frontend/) | React + TypeScript + Vite，独立 npm 项目，不在根 workspaces 中 |
| [Journal](packages/agent-journal/) | 活动导入、确定性日报、可选模型总结；Node + TypeScript |
| [Knowledge](packages/agent-knowledge/) | 文档索引、检索、来源核验与 MCP；Node + TypeScript |
| [根工具脚本](scripts/) | 打包、独立安装验证、敏感数据扫描和工具回归 |

优先参考[根 README](README.md)、[架构](docs/ARCHITECTURE.md)、[开发指南](docs/DEVELOPMENT.md)、[安全说明](docs/SAFETY.md)和[命名规则](docs/NAMING.md)。当前任务见[TODO](TODO.md)，后续方向见[路线图](docs/ROADMAP.md)。子包文档用于功能细节；涉及 monorepo 路径、安装与部署时以根文档为准。文档只描述当前架构与用法，不把历史验证数字、旧部署声明或迁移记录写入文档；需要当前结果时实际运行检查。

## 架构与数据约束

- 根 npm workspaces 只有 Trace、Journal、Knowledge。Stats 独立使用 setuptools 打包；不要将其强行纳入 Node 运行时。
- 四模块分别发行，不要求锁步升级。Trace 是可选数据源，不是其他模块的必装依赖；不要新增强制兄弟包依赖、统一总控服务或万能 core / DataSource 包。
- 消费方核心功能必须能使用自身输入独立运行：Stats 的 provider / session JSON、Journal 的 activity snapshot、Knowledge 的文件 / SourceScanner。正常运行与发行包不能要求兄弟目录存在；合成集成测试可引用兄弟 fixtures。
- Trace metadata 与 content 契约分离。各消费者拥有自己的状态库、来源身份、事务、租约与消费游标，不能混用来源或共享消费进度；修改协议需保留版本校验、幂等和删除传播语义。
- 不应新增读取其他模块数据库的耦合。已有例外是 Stats 显式配置的 Trace content **只读**下钻；独立用法可通过 `--no-content` 关闭，不能据此把 Trace 变成必需项。
- 未知用量保留 `null`，不能补成零；缓存、推理及父子会话聚合不能重复计数；API 等价费用估算不代表真实账单。归档证据不能自动视为已确认知识。
- 自定义 adapter / scanner 是受信任代码，不是沙箱；新增接入必须明确授权范围、目录限制与敏感内容保护。

## 环境与依赖

- Node.js **24.15.0+**、npm **11+**、Python **3.9+**。生成 Python wheel 还需要 pip、setuptools、wheel。
- 使用 npm，不引入 yarn / pnpm 锁文件。根安装使用[根锁文件](package-lock.json)；子包保留的独立锁用于无兄弟目录源码安装。变更 Node 子包依赖时同步核对根锁和对应子包锁。
- Stats 前端使用[自己的锁文件](packages/agent-stats/frontend/package-lock.json)，需单独安装依赖。
- Python 运行时无需第三方依赖；新依赖需确有必要，并维持支持的 Python 版本范围。

## 常用开发与验证命令

除特别注明外，在仓库根目录执行：

```sh
npm ci --cache .cache/npm
npm run check
```

`check` 包括三个 Node 包的类型检查、构建、Node / Python 测试、工具回归与敏感数据扫描；**不包括 Stats 前端检查**。

按改动范围先做定向验证，再运行必要的全量检查：

```sh
# Node 单包；将 agent-trace 替换为 agent-journal 或 agent-knowledge
npm run typecheck --workspace agent-trace
npm run build --workspace agent-trace
npm test --workspace agent-trace

# Stats 后端，根命令会切换到正确目录运行 unittest
npm run test:python

# 根脚本与扫描器
npm run test:tooling
npm run check:sensitive
```

修改 Stats 前端时另外执行：

```sh
npm ci --prefix packages/agent-stats/frontend --cache .cache/npm
npm run format:check --prefix packages/agent-stats/frontend
npm test --prefix packages/agent-stats/frontend
npm run check --prefix packages/agent-stats/frontend
npm run build --prefix packages/agent-stats/frontend
```

跨包契约、数据源、依赖或发行配置变更，按影响追加：

| 命令 | 用途 |
| --- | --- |
| `npm run verify:consumers` | 合成 Trace → Stats / Knowledge 导入、去重与删除传播 |
| `npm run verify:follow` | 临时回环服务、follow worker 游标与重启恢复 |
| `npm run verify:sources` | 无兄弟目录的独立源码安装与完整测试，拒绝 skipped / 零测试；可能下载依赖 |
| `npm run verify:packages` | 构建发行物、临时目录独立安装及包内 API / CLI 冒烟 |
| `npm run pack:modules` | 只生成本地 Node tgz 和 Python wheel，写入发行物目录 |
| `npm run check:privacy` | 公开前严格路径隐私检查 |

## 代码与产物约定

- 遵循所在文件的风格，避免无关格式化。Node 包使用 ESM 与严格 TypeScript；保持既有导入扩展名和构建转换方式，不为源码直跑而破坏发行后的 JavaScript / 类型声明。
- TypeScript 使用 camelCase，Python 使用 snake_case；JSON / 数据库字段沿用 snake_case，领域 ID 不机械更名。保留现有 CLI 与兼容别名，新环境变量遵循 `AGENT_模块名_用途`，详见[命名规则](docs/NAMING.md)。
- 修复行为问题时，在对应包的测试目录补回归；仅用合成 fixtures、临时目录、临时回环端口及 fake model provider，不以跳过测试代替修复。
- 不手改依赖、缓存与生成目录：`node_modules/`、`dist/`、`build/`、`.cache/`、`artifacts/`、`__pycache__/`、`*.egg-info/`。
- [Stats 静态资源](packages/agent-stats/agent_stats/static/)是**已跟踪、随 Python 包分发**的生成产物。修改[前端源码](packages/agent-stats/frontend/src/)后通过前端 build 更新，并检查生成 diff；不要直接修改哈希 JS / CSS。
- 正常运行和包内示例不能回读仓库兄弟目录。修改公共 API、CLI、配置或输入契约时，同步相关文档、示例、测试及发行文件白名单。
- 文档改动保持中文、结构清晰、无重复段落；删除过时内容时同步修正全仓链接与示例，不保留指向已删除文件的引用。

## 安全边界与交付

- 默认只使用新建临时库和合成输入。未经明确授权，不读取真实宿主会话、个人数据库、凭证或日报，不调用付费模型，不修改 MCP / 宿主配置或全局安装。
- 不自行执行服务安装 / 卸载、`launchctl` 或安装器 `--apply`。先读[安全说明](docs/SAFETY.md)，需要预览时只用对应安装器的 `--dry-run`；真实部署必须另获授权并核对服务名、端口、配置和所有数据路径。
- 不触碰相邻项目，不自动迁移数据库、修改来源绑定或复用他人配置。隔离服务名并不保证数据路径隔离。
- 不将密钥、个人绝对路径、真实日志、数据库或运行状态加入 fixtures、文档或提交。默认敏感扫描覆盖 Git 已跟踪文件；新增未暂存文件需扫描时运行 `python3 scripts/check-sensitive.py --all-files`。
- 未经明确要求，不发布 npm / PyPI 包、不绑定远端、不提交或推送；不擅自添加许可证或承诺公共包名可用。
- 完成后简述变更与实际执行的验证；明确列出未执行、失败或受环境限制的检查，不把旧验证记录当作本次通过。
