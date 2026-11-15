# 当前项目文档

本目录记录当前 Codex 版本的使用方法、实现边界、前端开发与实际验收结果。

同步：Stats 自己的 `follow --config` 主动拉取 Trace metadata，进度和重试留在 Stats；Trace 不向本项目推送。看板用 `serve --archive-only` 只读已接收数据，启动与刷新都不访问 Codex 源日志。见[消费方 follow 约定](../../agent-trace/docs/consumer-follow.md)和[工作区 TODO](../../../docs/ROADMAP.md)。Knowledge 侧 worker 已存在。

| 文档 | 内容 |
| --- | --- |
| [运行说明](RUNNING.md) | 启动、采集、安装、清理、HTTP 接口及 macOS 登录启动 |
| [前端开发](FRONTEND.md) | React + TypeScript 模块、开发命令与构建方式 |
| [Codex 接入能力](CODEX-CAPABILITIES.md) | 已核实字段、统计口径、支持范围与缺口 |
| [验收记录](VALIDATION.md) | 已执行检查、结果及尚未覆盖的场景 |

当前版本的合成数据预览：[总览](dashboard-preview.jpg) · [轮次详情](react-turn-detail.jpg)。

原仓库 history 历史资料未纳入本副本；以根目录当前架构、接入与验证文档为准。

以上文档纳入仓库版本管理。
