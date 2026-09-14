# 个人摘要与通知 v2：当前实现边界

对应 NEW-M14-FLOW 的 PRE-M14-01/02。依据 CUR-30/31/32、CUR-33 授权代选以及M14完整工作包；当前源为项目 `02-architecture/redesign-v1/predevelopment/work-packages/M14.md`。本页是实现说明，不替代原话和采用决定。

## 用户获得什么

普通房间仍有完整授权历史；用户自己的模型或用户手工形成个人摘要与关键消息。个人摘要默认留在客户端，可选同步至明确的官方服务和本人身份；云只存获准结果，任何方法都不调用模型。未生成时不冒充有摘要，生成或私有同步都不向房间发消息。

独立站内收件箱复用旧业务来源，新增普通消息、房间邀请和Task v2事件。按当前权限读取，没有永久通知正文副本。同一收件人的同一事件以kind:eventId去重；实际客户端可申请30秒提示租约并报告已展示，查询或展示不改变人类已读。该租约是交互恢复参数，不是模型遇阻判断规则。

## 追加迁移和服务

52迁移导出 `personalNotificationsMigrationSql`，新建 notification_options_v2、notification_presentations、personal_summary_preferences、personal_summary_heads、personal_summary_versions。仅扩展旧notification_reads允许的新事件kind，原通知ID、偏好和归档语义保留；v1未知的新设置不写回旧settings。

`PersonalSummaryService({db,access,endpoint,sourceReader:createSummarySourceReader(chat)})`沿用当前binding认证。owner从真实actor取得，不接受请求指定owner；私有摘要不新造身份或广泛Consent。消息来源按当前成员、父房间、精确版本、到期、待删除作者与未决编辑检查；数据服务不为了检查源又读取整段历史或调用模型。私人笔记与派生片段明确区分。

`NotificationInboxService({access,notifications,chat,tasks})`沿用notifications scope。新投影回到实际room/task/assistance/incident对象，房间消息不复制正文。旧摘要说明只在旧v1按原授权投影；v2提示保持内容最少。屏蔽支持房间内主体及本人全局主体，房间静音与Task静音互不替代。必要事故和任务争议回执进入安静收件箱；关闭或静音不借其他通道打扰。全局双向屏蔽查询 `isBlockedWithin(db,viewerId,candidateId)`给发现模块复用，不撤销Public Consent。

## 当前HTTP和客户端接口

所有接口为POST，调用现有认证传输；不接受URL中的凭据。主代理负责统一路由接线。

| 路径前缀与操作 | 输入 |
|---|---|
| `/v2/personal-summaries/preferences/read` | `{}` |
| `/v2/personal-summaries/preferences/save` | expectedRevision、endpoint、enabled、roomIds(null表示不限制已选类别的房间)、includeExisting |
| `/v2/personal-summaries/put` | versionId、summaryId、roomId、baseRevision、preferenceRevision、content、resolveVersionIds |
| `/v2/personal-summaries/get` | summaryId |
| `/v2/personal-summaries/list` | after、limit(默认10，最大20) |
| `/v2/personal-summaries/delete` | summaryId、expectedRevision；不删本地 |
| `/v2/personal-summaries/sources` | roomId、refs精确messageId/revision；最大100 |
| `/v2/notifications/query` | after、limit(默认10，最大20)、unreadOnly |
| `/v2/notifications/options/read` | `{}` |
| `/v2/notifications/options/save` | expectedRevision、settings |
| `/v2/notifications/presentation/claim` 与 `presentation/ack` | id、deliveryClientId、claimId |
| `/v2/notifications/read` | id、reader:'human'，明确阅读动作 |

content包括generator(kind为user-model或manual)、coverage(fromSequence/throughSequence/complete)、fragments及keyMessageRefs。每个derived片段必须引用至少一个精确消息版本；每个片段最多8000字符，整体编码不超过64KiB。personal-note明确不携带来源时按本人笔记处理，不能因此将模型文本当成已验证事实。用户模型负责正确标出来源，服务只能校验登记的引用与当前权限，不能机械证明概括语义准确。

同步写入先核对当前偏好修订及房间范围，再保存版本。旧baseRevision产生独立conflict版本，当前版不覆盖；本人可以合并或选择，再明确列resolveVersionIds消解冲突。重复versionId同内容返回原回执，不延長期限。有效更新起30天云到期；版本替代保留无正文回执，删除不让旧原操作重试复活正文。关闭同步停止新上传，已同步数据继续到期或由本人单独删除。

## 本地存储与执行

`openPersonalSummaryStore({indexedDB,name})`使用独立IndexedDB，仅保存个人摘要、偏好、队列及回执，不保存身份私钥或访问凭据。每身份一个原子更新记录，使用expectedLocalRevision防止多标签覆盖。`createPersonalSummaryLocal`接受subjectId、store、getConnection和sourceCheck。getConnection提供稳定client引用及当前endpoint/subjectId/bindingId/generation；client由 `createPersonalSummaryClient({call})`复用现有认证传输。

方法为choose/save/get/status/onBinding/synchronize/pull/resolve/deleteCloud。启用或停用由choose(...,{confirmed:true})承接界面已有明确选择；拒绝后不周期弹窗。未绑定先保存pending选择；onBinding仅在实际身份和原授权目标一致时衔接，既有云偏好可传达同一身份已作出的选择。绑定本身不构成新同步授权。

已选已有摘要和未来变化可排队，也可缩为选房或新内容。每个本地摘要与来源endpoint关联，旧目标队列不会改发到另一个服务。10秒防抖及5/30/120/900秒退避保存在队列中。同步未知结果保留原versionId；两设备正文冲突保留双版，用户模型解释供本人处理。客户端在执行前重验跨端偏好，另一端关闭后不继续新上传。

本helper不安装常驻进程或自动建立心跳。实际网页、插件或宿主应按真实前台生命周期/已授权后台能力调用synchronize；后台能力尚未接入时，不把排队显示为持续在线。持续模型关注属于M17的独立授权和运行责任。

离线时无法重验受管来源，展示先隐藏相关片段并标记unverified-offline，保留可恢复本地数据及不依赖来源的本人笔记；重新连接确认失效时移除片段与相应旧队列。用户已复制到银河管理范围外的内容不能声称追回。

## 删除、导出和维护责任

摘要读取当场重查已登记来源，失效片段不再展示并从受控云content剔除，不等待30天云TTL。后台可用 `purgeInvalidSources({after,limit})`分页去除未被主动读取的失效派生片段；源网络或身份检查出错不能当来源有效。`purgeExpired()`清除云到期内容。

来源作者待执行删除、消息待定编辑属于暂时不可用：显示先隐藏，保留受控版本以便取消限制后恢复。来源确已撤回、到期或版本已替换才永久清理相应片段。客户端当前版本、remoteCurrent和冲突版本一致过滤；身份在远程读取期间变化时不继续删除或写入另一身份的结果。源维护按head→version锁序重查，不能将并发已清空的旧版本重新写回。

`exportOwnedWithin(db,actor,{after,limit})`只导出本人当前允许显示的个人摘要，供M19已有认证导出事务调用。`eraseSubjectWithin(db,subjectId)`停止此身份同步、清除活动版本正文并保留最小状态；`eraseSubject`是自行管理事务的worker版本。无正文heads/version回执是剩余元数据，不伪称已物理删除整张表或本机副本。通知的 `eraseSubjectWithin` 删除本人presentation与v2偏好；`purgeExpired`只删除到期presentation，不删除源事件。旧reads保留既有M19负责范围。

用户查询/已读会沿用旧归档锁，历史归档不会被并发已读重建。通知仅显示90天内仍有权限的事件；源消息更早到期时该提醒随源停止显示。源权限变化、通知显示、服务收件与外部推送分开。

## AI Agent部署说明及验收

按原入口应用追加52及实际API角色：新5表SELECT/INSERT/UPDATE，无需向API授予DELETE；通知物理清理仅后台作业身份使用。资源预算计实际摘要JSON字节与有界元数据，额度失败回滚全部新版本，不产生半份云正文。源失效与到期作业由M19集成调度，不恢复备份。

当前取得证据：本地服务、客户端协调和真实HTTP三项测试3/3；随后实际PostgreSQL18.6 `galaxy_api`角色1/1包含并发双版、单提示租约、超额拒绝、源清理及到期过滤，隔离集群removed:true。通信与Account夹具明确隔离，不能计真实Prosody/OIDC或系统推送。

主代理在真实Codex IAB独立测试页执行IndexedDB验收：页面重载、双连接原子版本冲突、拒绝选择持久均通过，测试数据库删除回执为true；UA为Windows10 Win64、Chrome152.0.0.0。该范围不包含设备CryptoKey存储或完整宿主后台。测试tab已关闭，本子代理随后停止独立5184测试服务。

尚未计为交付：完整网页用户验收、浏览器Web Push/外部邮件、真实宿主提示与常驻运行、共享摘要消息的受控来源依赖。私有摘要不等于公共或房间共享版本；后者按M12新切片明确选择再发布，不通过复制私有同步记录假装完成。
