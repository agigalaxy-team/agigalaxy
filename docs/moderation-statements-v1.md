<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d3/d32c2853781875feed7d3e5d471364a8b957cf9ffe6a2fa090ffeb24b8239c5c.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 争议补充与纠正 v1

当前增量见[验证者参与案件与双向处理 v1](verifier-participation-v1.md)：验证者邀请、本人接受/拒绝、意见、退出、补充和申诉已接通 Case 与 Assistance；现有 Evidence 重验和纠正传播复用。当前 Schema37/42表，下方保留当批历史记录，不再把这些增量列为未实现。

2026-09-10，本地开发实现；Schema28 / 37表，无新增迁移，动态服务未部署。

对应原任务 C16-04、C16-05。举报新增 malicious-artifact（恶意工件）、data-extraction（信息套取）、work-fraud（劳动欺诈）、false-verification（虚假验证）；分类是报告者的指控，不是自动认定的事实。现有实现围绕 Assistance 案件；通用 Verifier 独立案件尚未完成。

## 事件与显示

- `supplement` 追加说明与最多8条引用：Case、Evidence、Proof、Event UUID，或工件 SHA256。仅记录引用，不下载工件、不核实来源、不授予所引用对象的读取权。
- `correct` 指向本人创建的报告或同一案件中本人创建的事件，填写新的说明及更改理由。原记录和原文保留；服务端独立检查作者归属。
- 两种事件都递增版本，不改变暂停状态或裁决，不自动重开已解决的案件。要申诉仍使用 `appeal`。
- 当事人的补充、纠正和申诉默认仅向配置的处理者披露；独立处理者的说明向处理者、举报者和报告记录的协作双方披露。处理者不能裁定自身参与的案件。
- 原生菜单通过编号选择引用类型和纠正目标，再确认准确载荷；显示事件ID、引用、更改理由和原始记录。引用标为未自动核验。
- 正文查询与授权视图导出使用当前 Consent；撤销后不再显示该正文，但操作性暂停不会因此解除。标识和状态不等于正文权限。

## 验证与运行

真实本地 HTTP 客户端工作流覆盖私有材料、原文保留、越权纠正拒绝、处理者说明、结案后补充和撤销后的导出。原生菜单测试确认补充与纠正都在准确预览确认后提交。隔离 PostgreSQL 的受限 API 角色跑同一工作流，并验证不能修改事件正文或删除报告。

使用 Node24 执行 `node --test packages/galaxy-official/test/governance.test.mjs packages/galaxy-official/test/assistance-menu.test.mjs`；PostgreSQL runner 的 `governance` 子集使用一次性 SCRAM 数据库，不指向外部数据库。便携客户端已重建并完成离线安装检查：`outputs/client-complete-1789013721082/verification.json`，19个导出，publicationReady=false。

AI Agent 部署时沿用现有 moderation scope、治理配置和精确 API 路由；不需要增加权限或迁移。服务与客户端应一同升级；旧客户端仍可使用旧事件种类，回退客户端前保留服务器对新事件的读取支持。不要删改原始事件进行回退。

原任务共同验收、真实运营案件及完整 Evidence→Proof/Profile/Honor/Search 纠正联动仍待完成；本说明不将说明文字纠正当作底层证据状态纠正。
