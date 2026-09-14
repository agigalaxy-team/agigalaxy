<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/a2/a2d9b59ff0a47022b4399148d157eb7a2a353ef016bb1eaa3c5ade255f82acd2.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 站内通知、邀请与请求者履历（本地实现）

对应C12-05、C12-07。通知按当前授权从既有协作/材料事件投影，保存偏好和已读状态，不另存消息正文或维护消息队列。当前没有邮件、短信、系统推送、后台轮询或跨服务投递；不会自动对外发送消息。

## 邀请与收件箱

请求者可在open招募阶段通过invite事件邀请一个已登记Galaxy ID，附最多300字符说明。被邀请者必须已经能读取请求的根说明：Public请求或在Private根Consent的viewers中；邀请不扩展根Consent，不开放Context，也不替被邀请者申请或成交。

开发默认限额：每个请求至多16位受邀人，每位只邀请一次；同一发送者跨请求每小时最多8次，按数据库时间计算。发送者偏好行锁保证并发请求共享限额。相同事件ID的原载荷重放保留原回执，不增加邀请或通知。

收件箱包含明确发给本人的邀请/协作事件、选定材料授权、对方接受材料、Capsule更新和运营事故事件；自己的协作事件不提醒自己。Public协作事件即使viewers为空，也会提醒请求者或当前选中的提供者，不向所有公开读者广播。每项使用来源类型与事件ID的稳定键，重复查询不产生重复通知。读取时重新核对来源Case、协作和Consent；材料提醒也核对当前材料可用性，不包含材料正文。邀请/协作通知可显示该收件人已获准查看的说明。

偏好可关闭全部站内通知、分别关闭邀请/协作/材料提醒，或静音至多64个协作ID；退出订阅仅影响站内展示，不撤销业务记录或Context Grant。已读写入幂等，只能标记自己当前可见的通知。默认开启的范围仅是主动打开的站内收件箱，不启动主动发送。

## API与客户端

通知API要求独立notifications scope；旧凭据不自动扩权。以下接口都是POST：

|路径|请求|用途|
|---|---|---|
|`/v1/notifications/query`|limit、unreadOnly、after（可省略）|查询当前收件箱|
|`/v1/notifications/preferences/read`|{}|读取本人偏好及revision，读取不初始化记录|
|`/v1/notifications/preferences/save`|expectedRevision、settings|保存偏好；过期版本返回冲突|
|`/v1/notifications/read`|id|幂等标记已读|
|`/v1/notifications/archive`|expectedRevision、before（Unix秒）|归档本人较早通知，清理较早已读标记|

settings包含enabled、invitations、collaboration、materials、capsules、incidents布尔值及mutedAssistanceIds。偏好响应另外包含archiveSupported和archivedBefore，不改变原settings结构。通知是已有授权内容的投影；本人偏好、归档和已读写入由notifications会话范围授权，不创建额外披露Consent。邀请仍使用操作者自己的assistance.publish Consent。

查询默认8项、上限20，使用来源ID排序与游标；每次至多扫描200个候选。授权失效可能造成空页但仍有nextAfter，客户端可继续翻页。没有全站计数、可靠推送/必达或时间排序承诺；时间字段为服务器登记时间。已经展示或被保存的通知不能通过撤销从接收者设备回收。

`@galaxy/client/notifications`提供query/preferences/save/markRead/archive。宿主控制器与原生协作首页已接入收件箱、分类偏好、静音和明确保存；点击通知可转到来源协作。只在具备对应scope时显示入口。

原生通知偏好可选择归档多少天前的通知，显示精确UTC界限与影响，用户确认后执行。来源事件created_at早于界限时不再进入本人收件箱；read_at早于界限的本人已读标记被清理。不会删除协作、材料、Capsule、事故来源或其他人的标记。界限只可前进，不能通过重新订阅恢复；原记录仍可从业务入口访问。偏好revision阻止覆盖并发修改，同一界限重复请求幂等；标记已读与归档按统一锁顺序串行化。没有启用任意天数的自动删除策略。

## 请求者履历

POST `/v1/requester-history/query`要求assistance scope，接受subjectId（省略为本人）、limit和after。从该请求者当前可见的请求与参与者事件生成描述来源、选择/确认、变更、交付、验收、取消、争议与解决记录，保留事件ID、操作者、发生时间和声明来源。

明确确认参与过协作的选中提供者，可在accepted/canceled/resolved后提交一次requester-feedback事件，记录描述清晰度clear/partly-clear/unclear、实际工作是否符合范围及说明。该评价标为provider-reported，默认仍使用Private Consent；其他申请者不能借公开根说明读取私有评价。Public请求允许提供者主动选择公开本次反馈，经完整预览后签署Public/public-profile Consent。旧记录不自动变公开，私有请求不能公开反馈，反馈不计入Honor贡献或能力分。客户端从当前端点publicRequesterFeedback功能声明判断是否支持公开反馈。

响应间隔仅按第一份可见申请与其后第一条可见请求者回应计算，同时返回两条事件ID；缺失来源时为null，不推断为未响应。请求/验收/取消/争议计数仅覆盖当前可见请求页，不是全历史成功率；事件计数在截取事实页前计算，同一个请求重新验收产生另一条验收事件，不增加请求数。描述本身与提供者评价分别保留，不把聊天条数或字段填写情况计为独立质量认证。

主列表每个请求最多预览8条事实，说明最多300字符，含summaryTruncated、visibleFactCount、nextFactsAfter和factsSupported。POST `/v1/requester-history/facts`接受assistanceId、limit（默认8、最多20）和after事件ID，按原事件顺序提供完整说明及nextAfter；每页重新检查当前来源授权。原生菜单可逐页查看完整事实、事件ID、作者、时间、反馈及响应来源。主列表与事实计数来自同一授权事务；分页间新增、撤销等变化按当前事实显示，不提供冻结的全历史快照。

原生菜单支持按Galaxy ID查看履历，以及提供者填写协作反馈；Assistance客户端提供requesterHistory/requesterHistoryFacts，宿主控制器提供queryRequesterHistory/queryRequesterHistoryFacts。旧服务的无分页响应仍可读取；新客户端主列表不会一次装入全部历史事件。

## 保存与后续

Schema14新增notification_preferences与notification_reads；原事件不复制到通知表。当前Schema37已将偏好变更和已读状态改变接入完整调用审计：notifications scope、调用binding及凭据范围、HTTP请求号和偏好revision/通知来源键均保留。它们不需要额外业务Consent；重复标记已读不重复记录改变，通知正文和偏好内容不进入审计。旧版legacy记录不回填。见[统一审计覆盖](audit-coverage-v1.md)。

Schema39增加归档界限、已读清理索引、邀请速率查询索引，并将归档接入notifications调用审计与本人数据导出，表数仍为43。API角色新增本字段UPDATE和notification_reads DELETE，业务来源表的删除权限不变。一次查询复用同一协作的已检查来源，包含失效来源，避免为同页每条通知重复读取完整协作。

已验证：真实HTTP客户端上的28条事实分6页、15条公开事实、双方提醒、撤销、归档幂等与原文保留；205条签名候选夹具之后的有效邀请可跨空页找到。20个请求各1000条事件和字段上限中文正文的列表投影为919,680字节，低于1 MiB。此容量夹具和本机时间不等于生产负载认证，正式配额仍按目标主机情况调整。

仍待：真实用户、实际OpenCode宿主与共同协作验收；外部邮件等渠道按实际需要配置。动态服务未部署，没有触发真实外部邀请或消息。

## AI Agent部署说明

沿用现有环境、数据库与API角色配置发现流程；本批不新增秘密或外部渠道配置。先用迁移身份升级Schema39，再应用api-role.sql并启动匹配版本的API。验证本人归档、其他人标记保留及历史分页；不要直接对业务来源表做通知清理。回退需保留归档界限和原始事实，旧Schema38运行时应保持拒绝新数据库，不能忽略新界限继续展示。原生菜单功能仍需实际宿主人工复核。
