# 验证记录

日期：2026-11-15。环境：macOS、Node.js 24.15.0、npm 11.12.1、Python 3.9.6。以下为本轮交付缺口与安装器安全修复后的结果；远端 GitHub Actions 尚未执行。

## 当前本地结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 三个 Node 包类型 / 单测 / JS 与 .d.ts 构建、Python、工具测试与凭证扫描通过 |
| Trace | 72 通过，0 skip；含纯计划及真实 CLI 的副作用拦截测试 |
| Journal | 67 通过，0 skip；含 --apply 授权、dry-run、符号链接重定向及离线日报 |
| Knowledge | 59 通过，0 skip；合成协议测试不需要兄弟 Trace |
| Stats Python | 134 通过；含安装器 mock 安全测试与随包 example 导出 |
| Stats 前端 | 31 通过；format:check、TypeScript 与生产构建通过 |
| 根校验工具 | Python 6 + Node 2 通过；含归档 NUL + token、精确合成例外、Python / Node skipped 拒绝 |
| `npm run verify:sources` | 四模块各自在无兄弟模块的独立源码目录完成全套检查；Node 与 Python 显式验证无 skip / 非零测试 |
| `npm run verify:consumers` | 合成 Trace → Stats / Knowledge，独立游标、重放、删除传播通过 |
| `npm run verify:follow` | 合成临时回环服务及两个 worker，独立停止恢复与增量同步通过 |
| `npm run verify:packages` | 三个 tgz、一个 wheel 独立安装；暂存后无源码示例输入；API、CLI、静态资源及包内原始示例通过 |
| `npm run verify:originals` | 原模块 254 个文件与三个历史文档完整性通过，HEAD 未变、工作树干净 |

合计 **371 项本地模块、前端及工具测试通过**，另有无兄弟目录复跑、消费者 / follow 和发行物验证。源码隔离验证第一次发现 Stats 安装器测试仍间接需要兄弟 CLI，已改为受 mock 控制的本地合成 CLI 资源并重新完整通过；没有以跳过测试掩盖它。独立锁的部分传递版本不在根缓存中，源码校验现使用 prefer-offline，必要时下载，不再错误地假设根缓存包含全部独立锁版本。

## 安装器安全

三个源码安装器默认采用 local.agent-observatory.* 标签和独立状态路径，实际安装 / 卸载必须 --apply。默认拒绝路径先于写文件、联网或服务操作；dry-run 不执行 launchctl。Trace 对 dry-run + apply 的组合拒绝，Stats / Journal 以 dry-run 为准；Journal 计划仍会读取 / 校验指定配置。

新增逐级受管路径预检，防止默认状态目录、日志 / wrapper / plist 等符号链接将写入重定向到旧环境；用合成旧目录和 sentinel 验证拒绝后未变。Trace / Journal CLI 用预加载 mock 禁止子进程、网络与写入；Stats 使用 mock 校验所有操作。**没有真实调用 launchctl、没有安装 / 卸载服务。**实际部署及本地并发恶意路径替换不在本次证明范围；预检仍有 TOCTOU 竞态，不是完整沙箱。见[安全说明](SAFETY.md)。

## 发行物自包含

Trace 包内提供合成 Codex demo；Knowledge 包内提供示例文档并直接运行原始 memory-scanner，不重写 import；Journal 只从安装包读取示例并复制到用户可写位置；Stats 从已安装 wheel 的 console entry 导出 JSON，不需源码 docs。看板检查 HTML 实际引用的 JS / CSS 文件，不只判断目录里存在任意资源。

验证仍由开发环境构建，但每个包单独安装、无业务兄弟依赖。Node 安装使用根缓存；源码独立锁安装可下载缺少的传递依赖。没有修改依赖路由或发布公共包。

## 敏感信息与文档

- 扫描器检查历史归档，不豁免整个目录；凭证、敏感文件名、文本 NUL 等阻断。合成值仅限精确路径和完全相等的测试值，不是“含 synthetic 就放行”。
- 当前阻断发现为 0，但不可变 Journal 历史 TODO 保留一处原机器路径，明确报告 **1 项隐私警告**。`npm run check:privacy` 将其视为失败；公开前需另做隐私审核，不能声称本仓库已可直接公开。
- Stats 的五处失效历史引用已修正，历史原文保持逐字节不变；原文内旧链接不改写，映射见[归档说明](history/README.md)。
- CI 已配置凭证扫描、Python 3.9 / 3.13 矩阵、前端格式及汇总必过检查。只在本机验证了 Python 3.9；其他版本 / Linux 与实际 Actions 运行尚待远端执行。

## 历史与未覆盖范围

此前 monorepo 初次整理的 348 项基线、TODO / Review 原文归档及 YAML 本地解析均已记录并通过；本页以本轮最新复跑数为准。独立审查还曾修正自定义 Stats turn 缺少 evidence 导致详情渲染失败的问题，当前回归继续覆盖。

没有浏览器视觉验收、真实宿主长期运行、云模型调用或生产数据库接入；没有修改用户宿主 / MCP 配置、发布包或绑定远端。业务可信度待办仍见[当前 TODO](../TODO.md)与[后续规划](ROADMAP.md)。模块内历史文档提到的真实试点、真实模型费用与已安装 launchd 仅为历史参考，不计为新副本部署结果。
