# 安装、开发与发布

## 开发环境

在仓库根目录执行：

```sh
npm ci --cache .cache/npm
npm run check
```

根 package-lock 是三个 Node workspace 的依赖锁。模块内原锁文件保留，支持复制单模块源码后独立 `npm ci`，不用于根 workspace 安装。新增依赖时需更新对应独立锁及根锁，或在未来移除独立锁并明确只支持 tarball 分发。根 Dependabot 只管理根 workspace 锁和独立 Stats 前端锁，不自动保证模块内历史锁同步；更新合并前需人工核对。配置、生效范围与未迁移项见[GitHub 指南](GITHUB.md)。

Python 模块无需第三方运行时依赖，源码开发可直接 `python3 -m agent_stats`；正式安装建议使用独立 venv：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install ./packages/agent-stats
```

根 Python 测试使用 `python3`。Stats 前端单独 `cd packages/agent-stats/frontend && npm ci && npm run format:check && npm test && npm run check && npm run build`；构建输出到该 Python 包的 static。仓库保留已构建的静态文件，普通 Python 用户不需要 Node。

`npm run verify:sources` 将各模块源码复制到无兄弟模块的独立临时目录，使用各自锁文件安装依赖并运行完整检查，显式拒绝 Node / Python 测试 skipped 和零测试。Journal 使用模块内合成协议 fixtures，Knowledge 的模块测试构造自己的合成页；缺必要资源会失败，不会静默少测。独立锁的传递版本可能不在根缓存中，此命令使用 prefer-offline，缺缓存时可正常下载；不是离线环境保证。

`npm run verify:packages` 构建并暂存发行物后，只从安装后的包读取示例、配置和 fixtures。Stats 用安装后的 `agent-stats example --output FILE` 提取随 wheel 提供的 JSON；Knowledge 直接运行 tarball 原始示例，不重写 import。配置复制到临时可写目录，不写 node_modules。

## 常用命令

| 命令 | 内容 |
| --- | --- |
| `npm run typecheck` | 三个 Node 包类型检查 |
| `npm test` | 所有 Node / Python 单元测试 |
| `npm run build` | Node JavaScript 与 .d.ts 构建 |
| `npm run test:tooling` | 扫描器与拒绝 skipped 的校验工具回归 |
| `npm run check:sensitive` | 凭证 / 敏感文件扫描，隐私路径明确警告 |
| `npm run check:privacy` | 公开前严格路径检查；不可变历史原文目前有一处待审查 |
| `npm run verify:sources` | 四模块无兄弟目录源码检查，拒绝跳过测试 |
| `npm run verify:consumers` | 合成 Trace → Stats / Knowledge 导入、去重、删除传播 |
| `npm run verify:follow` | 临时回环服务、独立 follow 游标与重启恢复 |
| `npm run pack:modules` | 三个独立 tgz 与 Stats wheel，写 artifacts |
| `npm run verify:packages` | 打包、全新临时目录独立安装、API / CLI 冒烟 |
| `npm run verify:originals` | 本地迁移现场校验原项目未改，不能在全新 clone 执行 |

测试只使用合成数据、临时目录、临时回环端口与 fake model provider。不运行 macOS 安装器，不接入真实日志或用户数据库。

## 独立发行

Node 包都提供 `bin`、`exports`、`types` 和 files 白名单；三个包之间没有运行时 package 依赖。Trace / Journal 无第三方运行时包，Knowledge 有自身 MCP SDK / ignore / zod 依赖。Stats 是独立 Python wheel，含看板静态资源。

本次只生成本地发行物，**不执行 npm publish / twine upload、不绑定远端、不承诺公共包名可用**。发布前必须：

1. 确认原代码、前端素材和文档授权；仓库未擅自添加许可证。
2. 确认 npm / PyPI 包名、组织、版本与维护者权限。
3. 各模块跑测试、独立安装与 API 校验；UI 改动另重建 Stats static。
4. 跨模块协议变更跑消费者和 follow 集成，明确兼容范围与版本升级。
5. 检查发行文件，无个人配置、凭证、运行库、真实会话或 node_modules。
6. 再由维护者显式发布。模块可分别发版本，不要求锁步。

## 初始化版本库

根目录是新的独立项目，原始四仓库没有迁移或合并历史。若尚未初始化，可在根目录手工执行 `git init -b main`，检查文件后提交并绑定你自己的远端。本次不代替用户提交或推送代码。
