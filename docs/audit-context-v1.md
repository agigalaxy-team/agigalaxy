<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/f2/f215bc616fe282aefe5578469207be833388468db00971f3dfd3eae0c4fda97c.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 审计上下文：当前实现

当前更新（2026-09-10）：Schema37；失败请求认证时快照、Profile发布、通知偏好与已读状态已补齐，材料逐次读取、治理审核和证据纠正关联均已接通。当前覆盖和部署边界以[统一审计覆盖](audit-coverage-v1.md)为准。以下各段保留早期实施记录，其中“当前/最新/待完成”仅指各段写入时点。

2026-09-10后续更新：当前Schema20，已实现本人查询、独立签署的限时跨主体审批、分页/JSON导出及查询本身的事务留痕。API角色不可改写授权载荷或删除读取记录。[权限和接口](audit-access-v1.md)。以下保留Schema19及更早的实施记录；异地归档和运营管理员流程仍需继续。

2026-09-10最新：数据库Schema19，失败审计已接入SQLite持久队列、恢复补写和请求/action去重；额外覆盖readiness失败、Node解析器拒绝和连接中断。[交付与恢复规则](failure-audit-delivery-v1.md)。原有成功事实事务审计不变；授权审计查询、管理员追溯和异地归档仍待完成。下文保留按实施阶段积累的记录，其中Schema11/8/7及best-effort描述属于当时状态。

数据库迁移为1至11。第9版新增 binding_scopes，第10版新增 credential_scopes，第11版增加调用方字段；前十版迁移保留，旧行不回填。两个字段分别描述绑定授予范围与本次凭据范围，不能据此替代 live Consent 检查。

|事件|binding_scopes|credential_scopes|
|---|---|---|
|binding.create|事件事务内绑定行|NULL，创建尚无会话|
|binding.revoke|被撤销绑定范围|HTTP入口在写事务重新核验的凭据范围；可信内部兼容入口未提供actor时为NULL|
|session.create|事件事务内绑定行|同事务中通过session挑战关联到新建凭据，仅选择scopes|
|Case事件、Consent创建/撤销、Proof发布/撤销、Evidence提交|对象Consent关联绑定|runAuthorized锁定并重新核验凭据后的scopes，独立传递给审计用例|
|Worker观察、租约耗尽恢复和不可用状态修复|Evidence/Consent关联绑定|NULL，后台任务没有用户会话|
|迁移前记录或未覆盖事件|允许NULL，表示未采集|允许NULL，表示未采集或不适用，按事件类型解释|

第11版调用方规则：业务操作通过runAuthorized返回的、数据库实际锁定的binding ID关联调用绑定与安装客户端，忽略额外actor.callerBindingId和actor.installationId。绑定/session创建使用本次持钥证明关联的绑定；HTTP撤销使用事务重新核验的actor绑定；可信内部兼容撤销未提供actor时四个调用方字段均NULL。Worker是后台组件，没有主体会话，四字段均NULL。客户端安装标识并不等于独立认证的设备或物理实例。

四个caller字段必须全部为空，或全部存在且caller_binding_scopes为数组；旧行未知值保留，不反向补造历史。字段记录快照，不新增外键来使历史受当前绑定删除影响。API/Worker数据库权限没有扩大。完整性检查不代表未覆盖事件已经完成审计。

runAuthorized提供冻结的公开权限数组，不传令牌或凭据摘要到审计。调用者actor.scopes不作为快照来源。Case和对象审计缺少该数组时抛错，使同事务事实回滚；只读回调仍可只接收db。后台Worker的依赖和数据库权限未扩展。

测试先收窄数据库凭据，再以包含过时及伪造权限的actor撤销Consent，审计只记录['consent']；修改凭据和绑定后，既有快照不变。session审计保留创建时完整凭据范围，重试不重写历史。数据库分别拒绝非数组值，但此类型约束不等于所有事件均已强制完整采集。

当前验证：112项全仓快测与lint通过；真实PostgreSQL3项通过，包括前缀升级、并发迁移、恢复及API/Worker停止重启；临时集群清理完成。旧版程序严格校验迁移序列，不能把10版及更旧程序直接回退到11版库。

剩余：内部调用及HTTP处理器外失败、失败记录可靠交付、导出/管理事件、审计查询授权与管理员追溯；未来来源刷新和失效传播按业务阶段实现。C16仍在进行中；动态部署和人工宿主验收未执行。

本轮补充：HTTP绑定撤销显式传入已认证actor；事务以固定ID顺序锁定目标与调用方绑定，再核验调用绑定归属/端点/有效期/撤销状态及凭据有效期、撤销状态和binding范围。过时actor.scopes不能绕过核验。自撤销后原凭据重试返回拒绝；同主体另一有效绑定重复撤销目标仍可幂等返回。

BindingService.revoke保留可信进程内部的subjectId兼容调用，不应暴露给请求JSON或其他未认证入口。HTTP路由测试明确验证第五个actor参数传入。跨绑定操作中binding_id、binding_scopes和client_id沿用目标绑定语义，credential_scopes描述实际执行凭据；caller_binding_id、caller_client_id、caller_audience、caller_binding_scopes单独记录实际执行方。旧字段语义不变，不将目标客户端冒称执行客户端。

Evidence提交沿用固定对象审计：根据提交对象关联Consent，记录evidence范围、完整绑定及凭据范围、首次HTTP请求ID、Evidence ID幂等键。记录、任务和审计同时提交；审计失败使前两者回滚。相同Evidence的提交审计与Worker每次观察审计分别记录。复用的审计辅助函数不赋予Worker读取认证表的权限。

## HTTP拒绝与失败

server.mjs显式安装createHttpFailureAudit；仅创建测试/嵌入createApi实例而不传failureAudit时，不自动连接数据库。HTTP处理器捕获的4xx记录http.rejected，5xx记录http.failed；原拒绝响应不因审计失败变为成功。记录发生在业务事务回滚后，独立于成功事实事务。

失败行context_version=0明确表示部分上下文：object_id为固定路由模板（路径UUID替换为:id），未知路径为http.request；request_id/http_request_id/idempotency_key为服务端请求UUID；outcome为处理器错误状态码。未记录原始URL、查询参数、IP、headers、body、异常详情、签名、令牌或凭据摘要。诊断日志保留原有规范错误code；数据库失败审计不采集异常code/message。

请求经过authenticate成功后，WeakMap只保留subjectId和bindingId供失败追溯，原始请求和认证秘密不传入写入函数。调用绑定元数据取审计写入时数据库快照，不能解释为失败时仍具备权限；没有认证成功的请求不相信body里的身份，actor为http-request组件，调用方字段为空。scope/Consent/目标binding/credential_scopes不虚构已授权值。

失败写入最多8个在途请求，单次等待上限2秒。超时返回unconfirmed且原写入继续占用槽位至实际结束；不自动重试。容量不足返回capacity，存储异常返回failed，确认写入返回recorded，结果进入服务日志auditStatus。此机制有界但不是无损审计：存储不可用或容量耗尽时可能没有持久记录，超时也可能稍后完成；独立告警/持久回补仍待设计验收。

范围：覆盖处理器catch路径的认证拒绝、业务错误和异常。直接内部服务调用、Node HTTP解析器提前拒绝、断开连接，以及以正常响应返回的健康探测异常，不在此入口冒充全部覆盖。导出/管理审计与失败记录可靠交付门槛仍未完成。

## 当前Evidence持久状态与审计覆盖

|变化|审计|边界|
|提交并入队|evidence.submit|与记录和job同事务，重试保留首次记录|
|Worker提交observed/unavailable/revoked|evidence.observe|与观察、Evidence及job状态同事务；租约丢失不写观察或成功审计|
|第5次执行崩溃后租约到期，running→failed|verification.exhausted|记录任务失败，幂等键jobID:verification.exhausted，不生成假观察|
|failed任务对应pending Evidence→unavailable|evidence.unavailable|记录实际修复变化，幂等键jobID:evidence.unavailable；历史已失败任务只记录本次修复，不补造耗尽时间|

恢复扫描每种状态每轮最多100条、固定ID顺序并跳过其他事务已锁记录。只有本事务实际更新的行触发审计；状态和审计任一失败全部回滚。未修复完的后续轮继续处理。恢复后的processNext仍可能返回processed:false，表示未执行新的来源任务，不表示本轮没有状态维护。

测试覆盖第二条恢复审计失败使job/Evidence及第一条审计一并回滚、重复扫描不重复记录、真实PostgreSQL中两个Worker实例并发恢复、旧失败记录不补造观察。过期来源读时拒绝与未来定期刷新不在此处冒充已实现的状态传播；数据库权限和Schema11均保持不变。

以下为此前实施记录，日期顺序中的“当前”不覆盖上述状态。

最新覆盖：Case、Consent、Proof、binding/session及Worker观察均已接入指定v1上下文；失败/导出/管理事件和完整scope集合仍待补齐。Schema仍8。

最新：数据库当前1至8；binding创建/撤销、session创建已接入v1。认证事件Consent明确不适用；Worker观察及其他审计覆盖仍待完成。

当前覆盖更新：Case、Consent创建/撤销、Proof发布/撤销已接入v1；binding/session/Worker仍待处理。以下保留首次Case实现的说明，后续补充在文末。

# 审计上下文 v1实施记录

C16-01进行中。数据库迁移7仅追加审计字段，前六版SQL内容不变。旧记录以及尚未接入的其他事件类型继续context_version=0；不能把该值解读为都已完整审计，也不从当前关联数据反向补造历史状态。

新版字段：client_id、audience、scope、consent_id、binding_id、http_request_id、idempotency_key，保留actor/action/object_id/request_id/outcome/created_at。context_version=1要求除可选HTTP请求ID外的上述关联字段非空；0允许未知上下文。并非通用任意JSON日志，禁止载荷、令牌、凭据摘要、私钥或Raw Context。

当前Case事件已接入：在同一已授权事务内，通过event→Consent→binding→challenge读取安装客户端ID及端点，scope固定为实际执行所需case-teaser；关联缺失则失败并回滚事实。仅取challenge中的installationId，不取clientSessionHash或签名材料。HTTP路由将本次服务端生成的请求ID带入审计；直接服务调用该字段可为空，不伪造HTTP请求。idempotency_key保持事件ID，旧request_id字段暂保留原事件ID语义以兼容查询。请求追踪与幂等去重不混用。

相同事件重试在授权检查后复用原结果，不追加第二条审计，也不改写首次HTTP请求ID。失败写入与审计同事务回滚。旧API角色已有表级INSERT/SELECT权限适用于新增列；这不等于防御数据库所有者或超级管理员，C16-02/06仍需复核不可编辑与管理责任。

剩余：binding、session、Consent、Proof、Worker观察等事件尚未填入新版上下文；失败/拒绝及导出/管理员行为的统一记录、查询可见性和保留规则未完成。新版字段不能用来宣称C16整体通过。

兼容：当前运行要求迁移1至7；旧版本严格检查仅1至6，因此升级后不能直接回退旧进程并假定能启动。采用前向修复或事先验证的隔离恢复方案，不删除第7版字段/记录来强行降级。原0.1.0 HTTP/Manifest版本不因数据库追加字段自动改变；version-contract.json已列迁移7。

验证：Case测试核对全部新增字段、请求ID、幂等记录唯一及不含会话凭据；旧前缀升级保留旧审计上下文0；不完整v1记录被CHECK拒绝。真实PG验证升级/冲突回滚/恢复及实际服务启停。测试数据均合成，未迁移真实服务器。


Consent/Proof后续接入：共享object-audit.mjs只允许四个固定动作，使用调用方已授权并锁定的事务连接，记录目标Consent/binding/challenge中的指定公开关联字段，不复制整个载荷。动作与对象/actor联合判断既有审计，重复请求不重复记录；目标关联缺失且不存在原审计则失败，业务事务一并回滚。没有新增迁移或扩展数据库权限。

Consent create/revoke的scope为consent，Proof publish/revoke的scope为proof；Proof引用用于发布的原Consent。撤销记录保留原始绑定/客户端关联，不表示该Consent现在仍有效。HTTP请求编号只在实际写入口注入；匿名Proof读取、Consent列表保持原行为。直接服务调用不填假HTTP ID。

已验证重复创建、重复撤销、完整字段、首次请求ID保留和不含会话凭据；Worker读取图仍不引入身份/签名服务。其余事件类型、失败/导出及管理员追溯仍未完成，C16-01继续进行中。


认证事件后续：第8版迁移只替换context完整性约束，不修改前七版SQL。binding.create/binding.revoke/session.create的v1行强制consent_id为空；其他v1行继续要求非空。这些事件建立或撤销认证关系，不虚构业务Consent。

auth-audit.mjs在原绑定/挑战事务内从真实绑定链取安装ID和audience，scope记录基础binding协议范围，不代表全部会话权限。当前未另存完整授予scope集合，不能据该字段推断其他业务授权。绑定创建幂等键为原挑战ID，session创建为session挑战ID，绑定撤销为bindingID；旧request_id保留原调用语义。HTTP请求ID由写路由单独传入，与签名请求体分开，不改变严格请求schema或客户端签名字节。

测试覆盖HTTP session激活后直接重试仍只有一条审计；三个认证动作字段、Consent空值、幂等ID、HTTP追踪和不含会话/绑定临时凭据。数据库拒绝将伪造对象Consent填入认证事件。业务授权与撤销仍由原事务检查，不以审计数据作为授权依据。新版旧运行器schema边界仍严格，7版及更旧进程不能直接回退用于8版库。


Worker观察后续：使用已有Evidence→Consent→binding表读取权限填充关联，无需读取binding_challenges或access_credentials。client_id固定galaxy-evidence-worker表示执行组件，actor保留可信配置来源verifier名称；这些是逻辑组件标识，不冒充主体客户端安装ID、实例持钥身份或独立能力认证。idempotency_key为jobId:attempt，区分同一任务重试，request_id保留jobId；后台操作http_request_id为空。

审计插入发生在观察、Evidence状态及job状态更新的同一事务；要求同job/attempt的观察已存在，关联不完整即回滚。SQL使用RETURNING常量确认插入，不要求Worker读取audit_events。撤销/失败观察也记录原Consent关联，不能据该关联推断授权仍有效。

权限不变：API和Worker不具备审计UPDATE/DELETE；Worker也不具备audit_events SELECT或认证挑战/凭据读取权限。数据库所有者/超级管理员仍能绕过角色边界，不能宣称审计防篡改或管理员已被完全约束；管理员流程、独立存档和审计读取授权继续由C16-02/06处理。

Schema28新增37表中的runtime_config_events：API/Worker配置加载、角色变更和分页归档留痕见[运行配置审计](runtime-configuration-audit-v1.md)。配置独立复核已接通；生产异地归档与真实运营验收仍待完成。

独立治理配置审核与API加载见[治理配置审核](governance-review-v1.md)；与审计数据读取权限分开。
