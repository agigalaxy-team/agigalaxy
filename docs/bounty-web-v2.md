# 开放／赏金任务网页流程（M11）

本切片属于 `NEW-M11-FLOW-PARTICIPATION`。来源及修改前说明见项目 `07-logs/development/bounty-web-v2.md`；采用 M11 工作包 B-08-Q01/Q04/Q05 与卷08，而不把旧页面的开放协助固定值当成产品范围。

## 当前行为

- 发布网页选择开放协助或 `basic-bounty`，填目标、当前情况、帮助请求、可选预期交付、可见范围、明确的征集截止。不要求失败史、Case 或预填 Attempt。
- 赏金金额为原协议的固定、区间或询价；非负十进制字符串保留到八位小数，不用浮点数处理金额。单位由用户明确填写。申请报价独立于任务整体预算，不自动分摊给多人。
- 赏金规则来自当前服务 `/v1/qualification/policies`，新网页选择 `facts-v2` 档案；真实规则为空或到期时保留草稿并说明，不能编造规则 ID。开放协助可不设履历门槛。
- 申请为请求者与申请人可读的 Private 操作。帮助、范围、报价与选定资格引用在预览确认后提交，不扩展旧项目和第三方原文权限。当前材料不足仍可表达意愿，后端在实际选择及参与者确认时严格重新计算条件。
- 请求者可核对每份申请的报价与当前依据，提出明确范围；参与者独立确认或婉拒。多人安排各自关联原申请，不将总体预算转成自动付款。交付、验收、整体结果、复核、争议和双边处理继续沿现有独立流程。
- 邀请期限使用七天与征集截止的较早值；已撤回申请按 `state=withdrawn` 显示。请求者可显式延长征集截止，该操作不改变原参与范围及交付时间。

## 新增只读接口

`POST /v2/qualification/candidates`，`assistance` scope，必须当前登录；MCP 为 `galaxy_qualification_v2_candidates`。

输入 `{taskId, kind, after?, limit?}`；`kind` 为 `participation | external-review | calculation | capsule-use | proof | legacy-assistance`，默认每页12、最多30。

仅从当前登录身份本人所属的材料查找，继续调用当前来源 reader；没有代查其他身份的参数。外部审核由来源经历本人选择，输出当前精确审核版本；仅回执或已撤回材料不能作为正文。游标只取已授权返回项，不使用过滤掉的他人私有审核标识。

输出包含 `items[]`、`nextAfter`、`checkedAt`。每项只有类型、标签、精确引用及状态；`evidence` 可直接用于现有 `qualificationEvidenceV2Schema`。返回材料不等于满足条件，`qualificationGranted=false`。

已有范围计算许可必须匹配当前 Task、候选本人及请求者，且重查原作者许可。它包含固定来源集合，网页要求单独选择，不能混入其他材料。目录不自动创建新许可，不公开旧项目，不把 contribution publication 当计算授权。后续迁移66已补逐作者许可收集器；网页与 MCP 均先请求各原作者，再由本人分别授权，最后形成固定证据集合的计算授权。见 [完整许可流程](qualification-permission-requests-v2.md)。

## 网页与本机草稿

- `TaskPublishWorkspace({runtime,subjectId,connected,navigate,onNeedIdentity?})` 替换旧 main 发布表。组件是 `task-draft` 的唯一编辑者，保留旧六字段及未知本机字段；新增明确预算、规则和本机时区截止。匿名草稿仍走已有身份采用流程。
- `TaskApplication({task,runtime,subjectId,connected,navigate,refresh,onNeedIdentity?})` 替换旧申请表。使用按 endpoint/subject 隔离的 `task-application-draft:<Task ID>` 本机键。选中的目录只是本机选择快照，提交、选择、确认均继续当前服务器重核。
- `task-budget-fields.tsx`、`task-bounty-client.mjs` 为共用字段及真实协议映射；TaskCollaboration 显示报价/材料、支持显式征集延长和现有多方过程。
- 原待发送日志继续使用 `task-publication` 和 `task-event:<Task ID>`。未知结果先查精确回执；原金额、期限、ID、载荷和已接受签名不能被当前草稿重写。重连需要替换失效且未被接收的授权时，只能通过已有明确预览和确认流程继续同一业务 ID。组件取消预览仅取消本地编辑，不宣称取消已在途请求。

## AI Agent 集成与部署

首次发布/申请组件不新增表；后续逐作者许可协调使用迁移66的两张表及通知已读约束扩展。无需服务器模型、钱包或新的资格规则配置格式。服务新增 `qualification.v2.candidates()`，HTTP 复用现有 qualification 路由映射，MCP 增加子工厂中的只读工具；原资格与 Consent API 保持兼容。主代理统一接 main 和部署，避免旧表单与新组件同时写同一草稿。

运行前从当前配置读取真实注册的资格策略；不得因为网页存在赏金按钮就宣称该部署已经启用有效规则、真实审核者或赏金业务。已有规则和已接受参与来源可按现行条件复用，审核者没有配置时不得伪造审核权限。网页与服务发布需包含新的候选目录路由，否则目录明确失败、原草稿保留。

## 验证与界限

`test/bounty-web-v2.test.mjs` 的实际 HTTP/浏览器签名/独立本地 OIDC 主流程通过 1/1。使用真实账号关联与共享额度服务，没有 quota 替身。

扩展至实际原生参与链后，`GALAXY_TEST_PG_CASE=bounty-web-v2` 在隔离 PostgreSQL、`galaxy_api` 受限角色中通过 1/1（3400.2414 ms），自动清理 `removed:true`。覆盖：开放／赏金、精确金额与截止、无 Case、短征集邀请、私有报价、缺资格拒绝选择、当前精确审核版本→真实另一方确认、来源撤回重核、原生参与→Case→介入→Result→已接受交付的本人材料目录、合成资料排除、旧本地草稿保留和丢 ACK 后精确恢复。窄 TS 检查通过。

全部身份、OIDC、金额单位和来源均为隔离测试。部分载荷显式设置 `synthetic:false` 以检查非合成分支；这不是生产经历、真实外部审核者、实际报酬或端到端浏览器视觉验收。运行时本地存储为明确内存替身，不据此宣称 IndexedDB 已实测。浏览器实测与该版本部署状态由主代理单独记录。

迁移66已补图形化多作者请求/独立许可/固定范围计算、本人许可目录与撤销，以及合法旧 profile 的原版材料选择器；旧 API、旧签名和合法资料保留。精确范围、保留及新增验证见 [逐作者资格许可](qualification-permission-requests-v2.md)。托管、自动支付、强制退款与官方仲裁不属于已采用的本切片范围，不用普通选择或双边争议处理冒充。
