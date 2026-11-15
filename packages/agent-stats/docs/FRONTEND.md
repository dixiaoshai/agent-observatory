# React + TypeScript 前端

界面使用 React 19、TypeScript 和 Vite，以历史总览、轮次表格与轮次详情截图作为视觉参考（历史截图未包含在本副本）。当前合成预览见[总览](dashboard-preview.jpg)和[轮次详情](react-turn-detail.jpg)。业务视图写在 TSX 组件中；`frontend/index.html` 仅提供浏览器挂载入口。优化比对不在本版范围。

## 模块边界

| 目录 / 模块 | 职责 |
| --- | --- |
| `frontend/src/App.tsx` | 页面入口、全局筛选与选中会话状态 |
| `pages/Overview.tsx` | 总览卡片、模型与最近会话 |
| `pages/Sessions.tsx` | 默认会话视角、逐会话展开轮次、全部展开/折叠、名称搜索与排序；子代理会话按 `parent_id` 嵌套在父会话下（父行显示子代理数量），轮次视角仍只按 `parent_turn_id` 嵌套 |
| `lib/sessionRows.ts` | 会话层级与轮次树的纯函数展开逻辑（折叠、隐藏已按父轮次挂载的子代理会话、搜索保留祖先），供组件与单元测试共用 |
| `pages/Source.tsx` | 来源能力和隐私说明 |
| `components/` | 筛选栏、指标卡、Token 饼图、趋势图、原生详情弹窗 |
| `hooks/useStats.ts` | 请求生命周期、刷新与筛选竞态处理 |
| `lib/api.ts`、`types.ts` | 后端 API 访问与共享 TypeScript 数据契约 |
| `lib/format.ts`、`styles.css` | 数值/时间显示和统一视觉主题 |

API 汇总仍以 Python 数据层为准。费用估算由后端按当前 API 标准短上下文价格计算，前端展示美元估算、覆盖、分类构成、未知原因和官方费率依据，不视为实际账单。饼图只包含输入/输出均可拆分的样本，缓存和推理不重复相加。用量覆盖与分类覆盖分别显示。父子联合聚合被后端抑制时，前端不自行恢复合计。

## Overview 布局

Overview 按参考图组织为顶部三张概况卡（Token 四分类饼图、估算费用饼图、消耗集中度）、六张单轮中位数卡和堆叠趋势。趋势支持 Token、费用、缓存读取及工具输出字节四种指标，缓存属于输入的一部分，不重复计入总量。已知写入从未缓存输入中扣除；写入字段未知时保留在未缓存输入内并说明。无法拆分但总量已知的部分单独显示斜线。

`lib/overview.ts` 提供 Token 拆分、Type 7 分位数和集中度。集中度按当前指标的有效轮次取前 10%（向上取整），可查看组成轮次并打开详情；零分母和无有效样本保持未知。六张卡使用各自字段的有效样本，不伪造上期对比。缓存整体汇总、价格依据、模型分组和最近会话移到趋势之后，保持首屏简洁。父子未去重标记沿用后端字段。

## 开发

需要 Node.js 22.12+（本机为 24），在项目根目录运行：

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
```

开发地址为 <http://127.0.0.1:5173/>，`/api` 代理至现有 Python 服务 `127.0.0.1:8765`；生产看板依然使用 8765。React 插件提供组件热更新。依赖版本由 `frontend/package-lock.json` 锁定。

## 构建与校验

```bash
npm --prefix frontend run check
npm --prefix frontend run format:check
npm --prefix frontend run build
python3 -m unittest discover -s tests -v
```

构建包含严格 TypeScript 检查，产物写入 `agent_stats/static/`。该目录是生成结果，修改请在 `frontend/src/` 进行。Python 服务使用白名单托管入口与 `/assets/` 下带内容哈希的 JS/CSS；打包配置包含嵌套资源。生产运行不需要 npm、Vite 或额外 Node 进程，macOS 登录启动仍只启动 Python 服务。

开发工具配置依据：[React 构建工具说明](https://react.dev/learn/build-a-react-app-from-scratch)、[Vite 指南](https://vite.dev/guide/)。
