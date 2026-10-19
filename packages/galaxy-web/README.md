# 银河产品网页实现

实际产品入口为 src/main.tsx。根仓 app 中的旧演示不代表当前工作区。

依据[当前完整重构目标](../../../../../01-intake/CURRENT_RECONSTRUCTION_GOAL_2026-10-12.md)，当前网页已经按阅读、交流、找帮助、一起工作、理解人物与方法、管理资料及自己的 AI 接续组织。Web 0.1.20 继续落实整个研究范围的后续改动，普通查找、私人稿与发表版本、接收者背景、作品与联系、有限结果和准确方法来源均进入实际使用流程。各项操作与未验证范围见[当前状态](../../../../../02-architecture/current/chapters/11-current-state.md)，不由入口或测试数量推定整体用户效果。

设计与实现依[全产品体验规则](../../../../../02-architecture/current/EXPERIENCE_RULES.md)和[用户流程](../../../../../02-architecture/current/chapters/03-user-flows.md)。内容、人、对话和结果是页面主体；系统处理更新、来源检查、去重和同一已授权操作的恢复。真实数据范围及新的对外动作仍由用户选择。暂停、撤销、到期或身份变化不会被后台接续绕过。

从本仓库根目录执行现有网页构建和类型检查：

```powershell
node node_modules/vite/bin/vite.js build --config packages/galaxy-web/vite.config.mjs
node node_modules/typescript/bin/tsc --noEmit
```

本地预览可使用隔离 API、当前身份接续及合成数据，实际操作本次改动的流程。已有开发记录在项目 07-logs/development/ui-reconstruction-20261009 下。

保留有效功能和数据语义，按用户目的调整页面与流程。后续工作见[当前安排](../../../../../99-index/ACTIVE_DEVELOPMENT_GOAL.md)。
