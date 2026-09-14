<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/40/407cda885e10f25fa917ee47952ca23c8a30317eda6eab534506d6999c8a4f55.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 选定材料 Context Grant（本地实现）

对应C12-04、C06-01、C06-05。请求者选择提供者且双方确认协作范围后，材料仍不可自动读取；需要单独创建材料授权，并由指定提供者确认该份授权。当前支持主动粘贴的选定纯文本片段，以及可信本机宿主中明确指定文件与行号的[文件/日志片段选择](context-file-selection-v1.md)。文件选择经预览后仅保存名称和选定文本，不自动读取目录、URL或完整会话，不授予Shell、仓库写入、网络或生产权限。

## 流程与可见内容

1. 请求者在active协作中选择材料，预览接收方、已确认范围、有效期和准确文本，并确认自己的context.grant Consent。
2. 指定提供者看到材料名称、媒体类型、内容哈希、范围与有效期；此时没有正文。其他申请者和匿名访问均不可见。
3. 提供者单独确认接受该grant、scopeEventId和materialsHash，生成自己的context.grant Consent；随后才能读取正文。所有者可读取自己已上传的正文。
4. 每次读取重新核对来源Case、协作、双方Consent、binding、材料到期和撤销。只有active状态和同一范围确认事件继续有效；取消、交付结束、争议或范围变更均阻断材料读取。即使后来确认相同的范围文字，也须新建材料授权。
5. 请求者可单独撤销grant；即使来源已失效或协作已取消，仍能撤销自己名下的grant。撤销是不可逆状态，不能重新确认来复活。

撤销阻断服务的后续读取，不能删除接收者先前保存的副本。原Assistance投影的contextAccessGranted=false仍表示协作不自动授予材料权限；具体Context接口才返回该份材料是否可读。

## 接口和数据

所有接口要求独立context scope，旧凭据不自动获得。

|方法/路径|用途|
|---|---|
|POST `/v1/context-grants`|提交请求者的材料及精确Consent|
|POST `/v1/context-grants/{id}/accept`|提供者确认该材料哈希及范围事件，携带自己的Consent|
|GET `/v1/context-grants/{id}`|获准元数据或正文，读取时重新检查有效性|
|POST `/v1/context-grants/query`|按assistanceId查询本人相关、当前有效的材料元数据；不返回正文|
|POST `/v1/context-grants/receipt`|作者按kind、grantId、eventId和payloadHash核对历史接收结果；不返回正文或当前访问权|
|POST `/v1/context-grants/{id}/revoke`|请求者明确撤销，body为{}|

创建/接受接口均使用`{consentId,payloadJson}`。具体结构在shared/context-schema.mjs：创建绑定id、assistanceId、caseId、participantId、scope、scopeEventId、expiresAt和materials；接受绑定独立事件id、grantId、assistanceId、scopeEventId和materialsHash。Private Consent只能指定对应的另一方。scopeEventId指向最新选择/范围确认事件，防止文字相同但已重新协商的范围复用旧权限。

每份grant为1至8个text/plain片段，每段正文最多4000字符、标签160字符、总载荷16000字节；同一协作最多64份历史grant。已知私钥、Bearer/PAT/API key等格式会被拒绝，不静默改写内容；这是基础格式检测，不宣称完整内容扫描。原生材料草稿支持添加、编辑、查看、移除多个片段，保存已确认字段并离线续填。8段同时达到4000字符可能超过总字节限制，提交前会明确拒绝，保留原草稿。

客户端`@galaxy/client/context`支持prepare/execute/cancel/get/query/receipt。写入预览明确操作与载荷，未知结果不自动重发；可信宿主保存精确载荷并提供重启对账、原内容重试。客户端读取正文时校对materialsHash，返回source=endpoint-reported，不作为独立能力认证。详见[材料草稿与恢复](context-recovery-v1.md)。

可信宿主提供prepareContext/executeContext/getContext/queryContext；引导操作kind为grant、accept或revoke。创建材料时复用当前协作中的接收者与范围；原生菜单支持授权、接受、逐片段读取及撤销。请求者配置材料有效期，实际预览上限受当前binding和本地接入意图约束。创建/接受另需consent scope，创建引导还会通过assistance scope读取当前协作。只有确认执行中的精确意图会进入本地签名函数。

## 保存与实现边界

Schema13新增context_grants和context_acceptances。原始载荷保存在受限数据库表，事件/撤销与业务审计同事务；审计仅记录ID、参与者和权限元数据，不记录材料正文。提供者接受记录不可改删；API只能追加并撤销grant，Worker不新增材料表权限。12版程序不能直接用于13版数据库，需前向修复或已验证的相容恢复。

当前Schema39；材料相关的36版增加材料列表读取审计约束，37版补通知审计；本次文件片段选择不改变数据库。正文、元数据、列表以及授权视图导出的成功读取均在当前授权事务内追加独立审计；即使重复请求也有各自记录，列表为空仍记录查询。读取审计仅保留对象ID、调用者、binding、scope、Consent（列表查询为null）和请求关联，不保存文本或标签。正文仍逐次重新验证。本人原始数据副本导出沿用既有data.export.page审计及所有者导出权限；它用于取回自己提交的历史数据，不声称共享材料仍有效。

当前没有对象存储、加密对象下载、原始文件上传或端到端加密；本地选择的文件片段转换为已有text/plain材料。不能对外宣传上述未实现能力。本地草稿及精确提交记录已支持保存和重启对账；本地删除不撤销远端授权。生产数据保留期限、备份删除及存储部署决定仍按C00/C18处理。协作任一事件Consent失效仍会使整串不可用，部分失效恢复待后续处理。

自动化覆盖本地真实身份签名、HTTP/客户端/宿主、参与者确认、正文隐藏/读取、范围变化、Consent撤销、到期、取消、原生菜单，以及真实PostgreSQL API角色。真实OpenCode和真人协作验收待完成；动态服务未部署。
