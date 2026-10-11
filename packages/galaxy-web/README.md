# 银河产品网页实现

实际产品入口为 src/main.tsx。根仓 app 中的旧演示不代表当前工作区。

依据[当前本地开发目标](../../../../../01-intake/CURRENT_LOCAL_DEVELOPMENT_GOAL_2026-10-09.md)，本轮已开始修改实际网页、必要的业务接续和数据客户端。导航按发现、社区、消息、我的组织；发布、求助、个人资料、经历、笔记、资料包与数据操作正在按完整使用流程整合。各部分状态见[当前状态](../../../../../02-architecture/current/chapters/11-current-state.md)，不能将本段列出的入口全部视为验收完成。

设计与实现依[全产品体验规则](../../../../../02-architecture/current/EXPERIENCE_RULES.md)和[用户流程](../../../../../02-architecture/current/chapters/03-user-flows.md)。内容、人、对话和结果是页面主体；系统处理更新、来源检查、去重和同一已授权操作的恢复。真实数据范围及新的对外动作仍由用户选择。暂停、撤销、到期或身份变化不会被后台接续绕过。

从本仓库根目录执行现有网页构建和类型检查：

```powershell
node node_modules/vite/bin/vite.js build --config packages/galaxy-web/vite.config.mjs
node node_modules/typescript/bin/tsc --noEmit
```

本地可操作预览需要隔离的 API、当前身份接续及合成数据。空态、静态原型和构建成功各有不同范围；不能代替多人操作、真实 AI 宿主或用户体验验证。相关工程检查和浏览证据保留在项目 07-logs/development/ui-reconstruction-20261009 下。

当前工作保留有效功能和数据语义，调整页面与流程；不沿旧路由逐页复刻，也不按历史模块数量计算完成率。本地开发已恢复，2026年10月12日已追加部署与公开发布授权。
