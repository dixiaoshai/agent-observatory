# 开发、验证与发布

## 开发环境

在仓库根目录执行：

```sh
npm ci --cache .cache/npm
npm run check
```

根 package-lock 是三个 Node workspace 的依赖锁。模块内保留的独立锁文件支持复制单模块源码后独立 `npm ci`，不用于根 workspace 安装。新增依赖时需更新对应独立锁及根锁，或明确取消独立锁并只支持 tarball 分发。根 Dependabot 只管理根 workspace 锁和独立 Stats 前端锁，不自动保证模块内独立锁同步；升级合并前需人工核对。

Python 模块无需第三方运行时依赖，源码开发可直接 `python3 -m agent_stats`；正式安装建议使用独立 venv：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install ./packages/agent-stats
```

Stats 前端单独开发：

```sh
cd packages/agent-stats/frontend
npm ci
npm run format:check
npm test
npm run check
npm run build
```

构建输出到 Python 包的 `agent_stats/static`，该目录是已跟踪的生成产物；普通 Python 用户不需要 Node。

## 常用命令

除特别注明外，在仓库根目录执行：

| 命令 | 内容 |
| --- | --- |
| `npm run typecheck` | 三个 Node 包类型检查 |
| `npm test` | 所有 Node / Python 单元测试 |
| `npm run build` | Node JavaScript 与 .d.ts 构建 |
| `npm run check` | 类型检查、构建、Node / Python 测试、工具回归与敏感扫描 |
| `npm run test:python` | Stats 后端 unittest |
| `npm run test:tooling` | 扫描器与拒绝 skipped 的校验工具回归 |
| `npm run check:sensitive` | 凭证 / 敏感文件扫描，隐私路径明确警告 |
| `npm run check:privacy` | 公开前严格路径检查 |
| `npm run verify:sources` | 四模块无兄弟目录源码检查，拒绝跳过测试 |
| `npm run verify:consumers` | 合成 Trace → Stats / Knowledge 导入、去重、删除传播 |
| `npm run verify:follow` | 临时回环服务、独立 follow 游标与重启恢复 |
| `npm run pack:modules` | 三个独立 tgz 与 Stats wheel，写入 `artifacts/` |
| `npm run verify:packages` | 打包、全新临时目录独立安装、API / CLI 冒烟 |

测试只使用合成数据、临时目录、临时回环端口与 fake model provider；不运行 macOS 安装器，不接入真实日志或用户数据库。

## CI 与仓库配置

仓库级 CI 定义在[根工作流](../.github/workflows/ci.yml)，模块内的原独立配置不生效。

| 任务 | 内容 |
| --- | --- |
| `modules` | Node 24.15.0 上的 `npm run check`、Stats 前端格式 / 测试 / 类型 / 构建，以及消费者、follow、无兄弟目录源码和发行包验证；上传本地构建发行物 |
| `python` | Python 3.9 与 3.13 矩阵安装 Stats 并运行 unittest 与安装器 mock 安全测试 |
| `sensitive` | 扫描器单测与 Git 跟踪文件敏感内容扫描 |
| `CI success` | 汇总检查；任一任务失败、取消或跳过都不会通过 |

CI 使用只读 `contents` 权限；同一 ref 的新运行取消旧运行；不使用 `pull_request_target`，不会把密钥注入外部 PR 代码。工作流只构建和上传发行物，不执行 npm / PyPI 发布。

Dependabot 配置在[根配置](../.github/dependabot.yml)：

- `github-actions`：检查根工作流，每周一更新。
- `npm` 根目录：以根 package-lock 管理三个 Node workspaces。
- `npm` 的 Stats 前端目录：对应独立前端 manifest / lock。

更新按 minor / patch 分组，major 需人工评估；所有更新人工审查，不启用自动合并。Stats 后端没有第三方运行时依赖，暂无 Python 运行时 lock。

分支保护、远端 Actions 运行结果和 Dependabot 实际行为需要在远端仓库现场核实，本仓库文档不记录历史运行状态。所有改动走 Pull Request，合并前在最新 `main` 上运行必要检查。

## 验证范围

`verify:consumers` 和 `verify:follow` 是仓库级集成检查，由根 CI 运行，不属于 Trace 的独立包检查。前者验证合成批次的独立分页、幂等重试、正文隔离、源文件删除后的证据读取和墓碑传播；后者使用临时回环服务验证 worker 重启后的独立恢复。实现见 Trace 的 [`verify-consumers.ts`](../packages/agent-trace/scripts/verify-consumers.ts)、[`verify-follow.ts`](../packages/agent-trace/scripts/verify-follow.ts)，共享协议样本见 [protocol fixtures](../packages/agent-trace/fixtures/protocol/README.md)。

`verify:sources` 将各模块源码复制到无兄弟模块的独立临时目录，使用各自锁文件安装依赖并运行完整检查，显式拒绝 Node / Python 测试 skipped 和零测试。Journal 使用模块内合成协议 fixtures，Knowledge 的模块测试构造自己的合成页；缺必要资源会失败，不会静默少测。独立锁的传递版本可能不在根缓存中，此命令使用 prefer-offline，缺缓存时可正常下载；不是离线环境保证。

`verify:packages` 构建并暂存发行物后，只从安装后的包读取示例、配置和 fixtures。Stats 用安装后的 `agent-stats example --output FILE` 提取随 wheel 提供的 JSON；Knowledge 直接运行 tarball 原始示例，不重写 import。配置复制到临时可写目录，不写 node_modules。

安装器安全只通过纯计划函数、临时目录、子进程 / 文件写入 / 网络 mock 验证拒绝路径和 dry-run；不实际调用 `launchctl`、不安装或卸载服务。真实部署另见[安全说明](SAFETY.md)。

## 独立发行

Node 包都提供 `bin`、`exports`、`types` 和 files 白名单；三个包之间没有运行时 package 依赖。Trace / Journal 无第三方运行时包，Knowledge 有自身 MCP SDK / ignore / zod 依赖。Stats 是独立 Python wheel，含看板静态资源。

本地打包不发布到 npm / PyPI，也不承诺公共包名可用。发布前必须：

1. 确认原代码、前端素材和文档授权；仓库未擅自添加许可证。
2. 确认 npm / PyPI 包名、组织、版本与维护者权限。
3. 各模块运行测试、独立安装与 API / CLI 校验；UI 改动另重建 Stats static。
4. 跨模块协议变更运行消费者和 follow 集成，明确兼容范围与版本升级。
5. 检查发行文件，无个人配置、凭证、运行库、真实会话或 node_modules。
6. 再由维护者显式发布；模块可分别发版本，不要求锁步。

```sh
npm run pack:modules
```

生成的 tgz 与 wheel 位于 `artifacts/`，安装示例见[根 README](../README.md)。
