# 任务评论与精确版本治理 v2

2026-09-13，schema61，M13 / M24 的计划内业务切片。当前源码有持久化服务、HTTP、MCP、网页组件与 M19 生命周期；本文件记录的自动验证使用合成身份和任务。是否已部署、真实运营者是否受理，分别查发行记录与实际配置，不由代码或测试通过推断。

## 用户价值、来源与当前边界

用户要求任务能够有评论，但需要账号验证、频率限制和反广告；后续未把公开评论选为默认协作路线，并未取消评论。评论用来澄清问题、讨论方案、报价或表达意愿，普通“谢谢”不会验收交付，“我可以试试”不会建立 Participation。主动 Task 无 Case、无失败尝试也能评论。人和 Agent 使用同一真实账号额度，不要求新专家先有成功履历。

原文与演变见 [CUR-11 / CUR-29](../../../../01-intake/CURRENT_USER_DECISIONS_2026-09-12.md)、[M13 阅读包](../../../../02-architecture/redesign-v1/packets/M13.md)、[M24 阅读包](../../../../02-architecture/redesign-v1/packets/M24.md)、[M13 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M13.md)、[M24 工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M24.md)。当前采用条件见 [卷09](../../../../02-architecture/redesign-v1/volumes/09-rooms-chat-comments-ai-and-notifications.md)、[卷12](../../../../02-architecture/redesign-v1/volumes/12-privacy-retention-governance.md) 及 [B-08-Q03 / C-Q-community_quota](../../../../02-architecture/redesign-v1/contributions/authorized-choice-decisions.json)。本轮开发授权为 CUR-35；旧工作包“业务暂停”是准备阶段的历史状态。

已有 M01 Account/OIDC、M02 Consent、M11 Task/Participation、M14 通知、M19 导出删除被直接复用。普通聊天仍是 M12，评论未替代任何四条帮助路径，也未把用户模型工作搬到银河云端。

## 评论操作和数据责任

`task_comments_v2` 保存作者、真实 Task、当前版本、原创建时间、90 天截止时间、回复的精确版本、规则版本与展示状态。`task_comment_events_v2` 保存每次真实作者签署的载荷、Consent、哈希和版本。编辑追加版本，不覆盖旧签署字节；回复存引用，不另存父评论正文。

目标载荷固定为 `schemaVersion:2`、稳定 `id`、`commentId`、`taskId`、`expectedRevision` 和以下一种 `kind`：

| 操作 | 行为与验收 |
|---|---|
| create | 新 commentId、expectedRevision=0；body、visibility=inherit-task、replyTo=null 或 `{id,revision}`；回复目标必须是本任务当前可读的精确版本。 |
| edit | 本人原创建后 24 小时内；使用当前 revision；追加事件，不续 90 天期限，不增加公开发布次数。 |
| correct | 本人在有效期内追加正文和更正理由，保留历史来源；24 小时以后仍可用。 |
| retract | 本人撤回，Private Consent 且无其他 viewers；停止展示，不退款、不撤回其他作者独立回复。达到普通修订上限仍可撤回。 |

创建/编辑/更正均须真实 Account 验证，不以 GUID、绑定成功或本机勾选替代邮箱/第三方验证。Public Task 的评论采用 Public Consent；Private Task 只向原 Task 许可内的选定人员披露，不能因存在 Task 就扩大授权。网页会列出实际已知对象供选择，服务再次检查原 Task 许可；资料不完整时不臆造更多可选身份。

每次写入使用本地签署的 `comment.publish`，服务器重新检查当前 Consent 和完整载荷。提交前先检查稳定业务操作是否已接受，同一事务内占额度、写事件及审计。重试使用同一 ID、哈希、Consent，不形成第二次发布。

原文可展示时间还受 Consent、Task 当前授权和删除状态限制；“最多保留 90 天”不是保证某一次 Consent 也有效 90 天。本人原始数据导出在保留期限内可用于取回自己的材料，不给他人重新开放正文。历史原文签名在正文清理后无法再用哈希单独重验。

## 公开额度与轻量反广告

额度采用已确认分级：新验证 Account 每 UTC 日 2 任务、20 公开评论、5 邀请；正常级 10、100、20。账号年龄和一次真实非广告互动的升级条件复用 CommunityAccountRegistry。多 GUID、桌面/网页/MCP、Agent 和设备共享 Account 额度；共享 IP 的独立 Account 不混算。

服务拒绝的写入回滚额度；被接受但进入待审的真实新评论占一次额度。正常编辑、更正、撤回不另占新评论额，删除不退款。Private Task 的评论仍须验证账号，但不占公开评论额；普通私聊不接此计数器。

以下为本轮技术细化 `comment-rules/1`，依据 CUR-33 技术代选范围，**并非用户逐字指定阈值**：24 小时内同 Account 的第三条规范化重复内容、相同链接涉及第四个 Task、超过 8 个 mention，进入 `pending-review`。规则忽略零宽字符、折叠空白、规范化大小写与 URL 片段，只保存指纹用于有界重复检查；不抓取外部 URL、不调用云模型。正常仓库链接、工具链接、报价和招募语义本身不是广告证据。自动规则只能暂存待审，不给“违规”“骗子”或能力差的结论。

普通正文上限 6,000 字符，更正理由 600，原评论最多 100 个常规版本。治理说明 1,600 字符，同举报者每评论最多 3 个独立请求，每案最多 3 次申诉和 100 个常规事件；撤回或解除已有临时限制不会被版本上限困住。以上也属当前实现参数。修改参数须保留版本和规则影响，不静默改旧事件依据。服务构造器有 rulePolicy 注入，目前正式装配使用上述默认值。

## 举报、处理、申诉与恢复

`comment_reports_v2` 关联具体 commentId/revision，保存请求人、状态、临时限制和结案时间。`comment_governance_events_v2` 保存报告、补充、申诉和处置者各自独立签署的说明。任何报告数量都不会直接产生账号限制、Task 取消、能力否定或付费资格变化。

首次报告为 `moderation.publish` 的 Private 载荷：稳定 id、精确 target、category 和必要 summary。不复制被举报评论到报告或审计中。作者可以以 `review-request` 请求复核自己待审的原文。

处置事件包含稳定 id/reportId/expectedVersion/kind/summary。`pause` 另外要求明确截止和规则；`resolve` 另外说明本项报告是否成立，以及当前版本的发布复核是否保持、通过或不通过。`appeal`、`resume`、`withdraw-report` 各自独立，不由一个按钮连带产生。

| 情况 | 实际行为 |
|---|---|
| 无 moderatorIds 配置 | 接收本人 Private 请求，标明 awaiting-authorized-handler；不自动处罚、不承诺受理时间。 |
| 新增处理人配置 | 不自动读取旧 Private 请求。原当事人明确补充并选定当前处理者后，其许可才生效。 |
| 有 moderation scope | 只有调用接口的基础权限，不是裁定权。 |
| 处理人与本案有关 | 举报者、作者、Task 请求者、真实确认过的参与者以及已知同 Account 控制方不能自裁；退出不会抹掉既有相关关系。未知现实控制关系仍是未知。 |
| 临时停止展示 | 当前独立处理者须能读取被处理原版本，签署有理由、最长 7 天的期限；只对该案的评论版本生效。7 天为当前技术限制。 |
| 处理决定 | 保存独立决定；不会自动解除另一个仍存在的临时限制。通过发布复核仍受原许可、当前版本、作者撤回和到期约束。 |
| 申诉 / 恢复 | 可见当事人按条件申诉；恢复只解除本项临时限制，其他案件、作者撤回和来源失效继续生效。 |

Private Task 未向处理者开放原 Task/评论时，报告共享不会自动扩大到这些源对象。处理者能记录原文不可访问或保持发布状态的结案说明，不能在无法读取来源时宣称已复核原文并批准展示。此情况需要当事人另行明确处理源材料共享，当前切片没有代签或强取私有 Task 的通道。

## 页面与返回原任务

`TaskCommentsWorkspace` 在 Task 详情的协作进程组件外侧，匿名可读取公开评论；未连接时说明发言需要绑定与验证。入口同时保留任务发布、参与、普通聊天和事实交付，不强迫用户只选一种目的。

评论查询、空结果、来源不可读、待审、撤回、额度不可读均有状态。用户选定评论版本后回复或举报，预览正文/目的/受众，再确认签署。取消编辑不发送；从处理记录可补充、申诉，只有实际 `canModerate` 和 `canReviewSource` 条件满足时出现相应裁定入口。界面操作完成后仍留在原 Task，未自动建立房间或参与。

本地操作日志按 endpoint+subjectId+taskId 分隔。精确签署字节先持久化，再发 Consent，再发业务；响应未知后只查询原 ID/hash。重连复用已接受且仍可用的原 Consent。用户可停止本机重试，清除本机待重试正文/签名，保留最小对账信息；这不证明服务端取消，稍晚到达的原请求仍可完成。已经接受的评论真正撤回仍走签署 retract。失效授权无法复用时不静默换签或改业务 ID。

本地 KV 在自动测试中为明确内存替身；真实 IndexedDB 持久恢复、浏览器布局和最终用户体验由真实宿主验收记录承担。

## 正式接口与 MCP

| 接口 | 权限与输出 |
|---|---|
| POST /v2/comments | assistance；`{consentId,payloadJson}`；新写入版本、状态、真实额度/规则提示。 |
| POST /v2/comments/query | 可匿名，登录需 assistance；Task、可选关键词/after/limit；逐次重查源许可。 |
| GET /v2/comments/:commentId | 可匿名；Private 来源按当前授权；无权不返回原文。 |
| POST /v2/comments/receipt | assistance；原 operationId/payloadHash，本人准确 accepted/absent/conflict。 |
| GET /v2/comment-governance/config | moderation；实际配置处理者、是否配置与基础角色提示。 |
| POST /v2/comment-governance/reports | moderation；独立签署 Private 请求，不自动限制。 |
| GET /v2/comment-governance/:reportId | moderation；当前有权说明、精确来源与本人的可用操作。 |
| POST /v2/comment-governance/:reportId/events | moderation；精确签署的报告后续事件，裁定另查真实角色。 |
| POST /v2/comment-governance/query | moderation；当前可见记录，可限定 commentId；游标只来自实际可见结果。单次候选扫描达到上限时明确 scanTruncated，不把不可见 ID 放进游标。 |
| POST /v2/comment-governance/receipt | moderation；本人原操作 ID/hash 对账，不代表决定当前有效。 |

`personal-mcp-comments-v2.mjs` 提供 9 个工具：评论 query/get/submit/receipt，治理 config/query/report/event/receipt。OAuth/Token 只提供调用范围，不制造本机签名或他人确认；写工具仍要求现有真实 Consent。模型负责理解任务、解释查询结果和提出下一步，数据服务没有自动 LLM 审核或全平台模型心跳。

通知新增 task-comment 与 comment-governance 两种来源，读取时即时重查评论、处理记录和许可；只返回导航与状态，不缓存原评论/举报正文。评论隐藏、撤回、编辑到新版本或源许可失效时，旧通知和回复片段不继续展示。治理服务回执按现行通知策略可保持安静可查询，不强迫弹出通知。评论关键词查询直接走当前 Task 评论视图，未新增带过期正文的全文副本。

## 导出、删除、保留和兼容

| 对象 | 实际生命周期 |
|---|---|
| 评论根元数据 | 原 Task/作者/版本/原截止；作者删除后 retract、清 Account 外键；其他作者回复仍可保留最小 parent ID。 |
| 评论版本正文及重复指纹 | 本人可导出保留期内原稿；90 天读取即不可用，Worker 清 payload_text、text_fingerprint、link_fingerprints，记录 original hash 和擦除原因；不声称哈希能代替原签名载荷。 |
| 举报与治理正文 | 每位作者只导出自己的陈述；当事人读他人说明仍逐条检查 Consent。全服务删除清本人正文，不删除他方独立处置。 |
| 已结案治理数据 | 从实际 closed_at 起 180 天；申诉重开取消该结案截止，之后重新结案重新起算。Worker 清相互引用后删除已过期案件/事件。 |
| 未结案治理关系 | 只保存处理所需资料与来源状态，不因评论到期假装已经结案，也不借未结案无限保存过期评论正文。 |
| 通知已读/展示 | 沿用 M14/M19 本人 90 天元数据清理，不拥有评论正文副本。 |

M19 增加 `task-comments-v2`、`task-comment-events-v2`、`comment-report-receipts-v2`、`comment-governance-events-v2`。公共 SQL Role 不具备原签署正文覆盖权限；Worker 仅允许指定到期字段清理及结案数据清除。全服务删除仍由已有专用执行器统筹，不提供公开全表 DELETE。用户提出删除到执行前使用现有 pending-deletion 可见性门，取消恢复原未撤销许可，不把取消变成永久撤权。

schema61 只追加四表及引用关系。旧 Task/Case/Assistance API 与旧迁移未重写；旧评论不可由助手从聊天日志补造。M13 当前只对真实 v2 Task 开放此新评论流。v1 Assistance 的旧举报/争议通道保留原语义，不与此新 comment report 强行合并。

## 给部署 Agent 的配置与验收说明

使用现有 Oracle 官方服务装配，不创建其他托管项目。先核对发行中的 migrations、角色脚本、services/routes、MCP 工厂、网页静态版本一致，再按正常追加迁移流程执行61。正常生产没有 syntheticCommunityQuota 绕过；必须保留真实 Account 注册器和 PublicWriteService。

`moderatorIds` 来自已有正式配置和实际可验证 GUID；生产未配置时保留空列表，不拿示例 GUID、普通 token 或测试账号替代。账号验证提供者独立配置，OIDC 登录成功但邮箱/第三方验证不满足仍不能评论。服务账号写入存储配额覆盖新增四表，不将评论存储排除在成本计量外。

常见失败：account_verification_required 需要真实账号验证；community_quota_exceeded 以实际重置时间为准；版本冲突先刷新；comment_edit_window_closed 改走追加更正；scope/原 Task 当前授权不足时不复制正文绕开；comment_independent_handler_required 要查真实角色与利益关系，不能放开整个 moderation scope；失联先查原 receipt。

本切片没有完成全 M24 的 Task/Room 全类型裁定、运营受理人员安排、申诉时效承诺、真实误伤率或外部平台副本撤回。当前 Task 评论治理能力与这些后续事项分别报告，不能据本测试声称公开治理系统已经完整运营。

## 本轮实际验证

- `test/task-comment-client-v2.test.mjs`：1/1。真正 createBrowserClient、真实 HTTP、本机签名与实际合成 OIDC，验证共享账号额度、未验证拒绝、稳定操作、规范重复/跨 Task 链接待审、24 小时更正边界、精确源撤销后不能批准重现、私有请求共享、独立裁定和通知。另验证 Consent ACK 丢失后重连、业务 ACK 丢失、停止本机重试后原请求晚到和精确对账；MCP 工厂的实际读取服务路径已执行。KV 明确为内存替身。
- `test/postgres/task-comments-v2.test.mjs`：1/1，实际 PostgreSQL 受限 API/Worker 角色，跑上述跨模块业务及 M19 90 天清理、本人导出、独立回复保留、结案180天清理；最终测试 4.66 秒，隔离临时 cluster 清理回执已取得。禁止原文 UPDATE/错误 Worker 裁定字段的断言通过。
- `TaskCommentsWorkspace` 及直接依赖的窄 TypeScript 检查通过。没有为本次切片重跑无关旧模块或重复备份检查。整站构建、实际浏览器布局和发行由主代理统一处理，其结果另记。
