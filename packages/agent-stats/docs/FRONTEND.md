# React + TypeScript 前端

界面使用 React 19、TypeScript 与 Vite，构建产物随 Python 包分发。业务视图写在 TSX 组件中，`frontend/index.html` 只提供浏览器挂载入口。当前合成预览见[总览](dashboard-preview.jpg)与[轮次详情](react-turn-detail.jpg)。

## 页面

- **Overview（总览）**：概况卡、单轮中位数卡、趋势、缓存与覆盖、费率依据、模型构成和最近会话。
- **各轮明细**：默认会话视角，可切换逐轮视角；支持搜索、排序、筛选、展开 / 折叠，以及打开会话或轮次详情。会话行在 Prompt 列显示该会话首轮 Prompt 摘要，会话与轮次两张表均有 Agent 列。
- **来源与覆盖**：从 `/api/capabilities` 读取来源能力、状态与降级原因。

三个页面可分别通过 `/#/overview`、`/#/sessions`、`/#/source` 直达，支持刷新和浏览器前进 / 后退。不带片段或片段无法识别时显示总览。链接只定位页面，不包含筛选条件或选中的会话 / 轮次。

## 模块边界

| 目录 / 模块 | 职责 |
| --- | --- |
| `frontend/src/App.tsx` | 页面入口、全局筛选、页面切换与选中会话状态 |
| `pages/Overview.tsx` | 总览卡片、趋势、模型与最近会话 |
| `pages/Sessions.tsx` | 会话 / 轮次视角、层级展开、搜索、排序与详情入口 |
| `pages/Source.tsx` | 来源能力和隐私说明 |
| `lib/sessionTree.ts`、`lib/turnTree.ts` | 按 `parent_id` 构建会话树、按 `parent_turn_id` 构建轮次树 |
| `lib/sessionRows.ts` | 会话与轮次行的纯函数展开逻辑（折叠、隐藏已按父轮次挂载的子代理会话、搜索保留祖先），供组件与单元测试共用 |
| `components/` | 筛选栏、指标卡、Token 构成饼图、趋势图、会话 / 轮次弹窗与正文时间线 |
| `hooks/useStats.ts` | 请求生命周期、刷新与筛选竞态处理 |
| `lib/api.ts`、`types.ts` | 后端 API 访问与共享 TypeScript 数据契约 |
| `lib/content.ts`、`lib/coverage.ts` | 正文接口与覆盖文案辅助逻辑 |
| `lib/overview.ts`、`lib/format.ts`、`lib/workspaceColor.ts`、`styles.css` | Token 拆分、分位数与集中度、数值 / 时间显示和统一视觉主题 |

API 汇总以 Python 数据层为准。`/api/overview` 的轮次只带 `tools_count` 与 `tool_output_bytes` 聚合，工具、事件定位与逐请求用量数组只在详情接口下发；页面需要的工具输出字节用该聚合计算。费用估算由后端按当前公开 API 列表价（OpenAI Standard 短上下文、DeepSeek 峰谷价）计算，前端展示美元估算、覆盖、分类构成、未知原因和费率依据，不视为实际账单。饼图只包含输入 / 输出均可拆分的样本，缓存与推理不重复相加；用量覆盖与分类覆盖分别显示。父子联合聚合被后端抑制时，前端不自行恢复合计。

## 总览布局

Overview 顶部为三张概况卡：Token 构成饼图、估算费用饼图、消耗集中度；其下是六张单轮中位数卡（Token、估算费用、缓存占输入、未缓存输入、缓存读取、输出）与堆叠趋势。

- 趋势支持 Token、费用、缓存读取及工具输出字节四种指标。缓存属于输入的一部分，不重复计入总量；已知写入从未缓存输入中扣除，写入字段未知时保留在未缓存输入内并说明。无法拆分但总量已知的部分单独用斜线表示。
- `lib/overview.ts` 提供 Token 拆分、Hyndman-Fan type 7 分位数和集中度。集中度按当前指标的有效轮次取前 10%（向上取整），可查看组成轮次并打开详情；零分母或无有效样本保持未知。
- 六张卡各用对应字段的有效样本，不伪造上期对比；分位数旁标注有效 / 总轮数。
- 缓存整体汇总、费率依据、模型分组和最近会话位于趋势之后，保持首屏简洁。父子未去重标记沿用后端字段。

## 会话与轮次层级

- 会话视角按 `session.parent_id` 建树：子代理会话缩进嵌套，父行显示子代理数量；父会话折叠时隐藏子行，父会话不在当前筛选范围时标注提示。
- 轮次视角只按 `parent_turn_id` 嵌套；dsh 日志没有父轮次身份，子代理轮次保留“所属父轮次未知”，不按时间猜测。
- 根会话按来源显示 `CX` / `PI` / `DSH` 标识，子代理会话显示“子代理”；Agent 列按来源运行时显示 `Codex` / `pi` / `dsh`，自定义来源显示声明值，未知来源显示“未知”。
- 会话行的 Prompt 列取该会话首轮（按 `sequence`，缺失时按开始时间；排序变化不改变首轮判定）的 Prompt 摘要；当前筛选范围内没有可见轮次时显示 `—`。
- 已通过 `parent_turn_id` 挂到父轮次的子会话不重复出现在会话行；搜索匹配 Prompt 时保留祖先上下文。
- 搜索在停止输入约 250ms 后应用（防抖）：输入框即时响应，避免逐键重建会话 / 轮次树并展开整表；停止输入后过滤一次，命中项连同祖先上下文展开。

## 正文时间线

会话或轮次详情弹窗可加载“查看执行正文”：按事件顺序展示用户请求、Agent 回复、最终回答、推理摘要、工具调用与工具结果。工具和摘要默认折叠，通过“加载更多”续读；来源证据显示事件 ID、源文件与行号。外置正文按需向 `/api/session-content/blob` 读取，失败时显示明确提示。正文按普通文本渲染，不执行 HTML 或命令。

## 开发

需要 Node.js 22.12+，在 `packages/agent-stats/` 下运行：

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
```

开发地址为 <http://127.0.0.1:5173/>，`/api` 代理至现有 Python 服务 `127.0.0.1:8765`；生产看板仍使用 8765。React 插件提供组件热更新，依赖版本由 `frontend/package-lock.json` 锁定。

## 构建与校验

```bash
npm --prefix frontend run check
npm --prefix frontend run format:check
npm --prefix frontend test
npm --prefix frontend run build
```

`check` 运行严格 TypeScript 检查，`test` 使用 `node --test` 与类型剥离运行 `frontend/tests/` 下的单元测试，`build` 先类型检查再输出到 `agent_stats/static/`。该目录是随仓库跟踪的生成结果，修改请在 `frontend/src/` 进行；Python 服务使用白名单托管入口页与 `/assets/` 下带内容哈希的 JS / CSS，生产运行不需要 npm、Vite 或额外 Node 进程。

开发工具配置依据：[React 构建工具说明](https://react.dev/learn/build-a-react-app-from-scratch)、[Vite 指南](https://vite.dev/guide/)。
