# Agent Stats 文档索引

本目录描述 Agent Stats 的当前用法、架构边界与输入契约。上层入口见[项目入口](../README.md)；仓库级架构、开发、安全与待办见根文档。

## 同步与数据来源

Stats 通过自己的 `follow --config` 主动拉取 Agent Trace 的本机 metadata API，进度、重试与租约都留在 Stats 本地；Trace 不向本项目推送，也不管理消费游标。看板用 `serve --archive-only` 只读已接收的统计库，启动与页面刷新都不访问 Codex 源日志。自定义 JSON / Python provider 不需要 Trace。相关约定见[消费方 follow 约定](../../agent-trace/docs/consumer-follow.md)。

日报与知识检索是两个独立的可选入口：Journal 只读显式配置的日报目录；Knowledge 需要已安装的 CLI 和显式配置，Stats 只按需调用 CLI，不打开其数据库。两者都未配置时不影响统计页面。

## 文档

| 文档 | 内容 |
| --- | --- |
| [运行说明](RUNNING.md) | 启动、命令、Trace follow、Journal / Knowledge 接入、macOS 登录启动、页面口径、HTTP 接口、隐私与当前限制 |
| [前端开发](FRONTEND.md) | React + TypeScript 模块、页面、开发命令与构建方式 |
| [Codex 接入能力](CODEX-CAPABILITIES.md) | 字段依据、能力声明、统计口径与降级 |
| [数据源契约](SOURCES.md) | 自定义 JSON v1、观测用量 / 费用 / 覆盖、旧归档兼容、Python provider API |

配套示例文件：

- [agent-stats.follow.example.json](../agent-stats.follow.example.json)：`follow` 配置样例。
- [custom-source.example.json](custom-source.example.json)：自定义来源 JSON v1 样例，与随包资源一致。

合成数据预览：[总览](dashboard-preview.jpg) · [轮次详情](react-turn-detail.jpg)。

## 根文档

- [架构与依赖边界](../../../docs/ARCHITECTURE.md)
- [开发指南](../../../docs/DEVELOPMENT.md)
- [安装器安全与服务隔离](../../../docs/SAFETY.md)
- [当前执行待办](../../../TODO.md)
