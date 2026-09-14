<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/4e/4eca0078ed0f53985304e8685f445c18055d949111fa639cab1dacca3db836a8.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Open Assistance / Basic Bounty 首版规则

当前扩展：[纠正后的交付与贡献恢复](honor-correction-recovery-v1.md)允许双方明确同意继续工作、按可见纠正/复核版本重新交付和验收。旧解决方案默认结束语义保留，付款和材料授权不由此创建；原生草稿与功能声明已接通，无数据库迁移。

依据开发清单 C12-01、02、03、04、05、06、07。共享结构、状态机、事务服务、HTTP、轻量客户端、原生菜单/表单、Consent引导与宿主签名已接通。当前为本地开发实现，动态服务尚未部署。

请求包含问题、已有尝试、请求范围、可见性、关联Case和招募到期时间；结构拒绝完整Context等额外字段。支持开放协助及基础赏金，赏金只描述固定金额、预算区间或请求报价，金额以十进制字符串保存/比较，结算单位为可扩展文本，无钱包或付款操作。

|动作|操作者和效果|
|---|---|
|invite|请求者邀请根说明已有权限的已登记参与者；限额与偏好另见通知说明|
|requester-feedback|已确认参与的提供者在结束后记录一次描述清晰度与范围评价；非独立认证|
|offer / withdraw-offer|非请求者提交申请报价，可在招募阶段撤回自己的申请|
|shortlist / select|请求者维护候选列表、选择有效申请；选择不自动成交|
|confirm|被选提供者确认，进入active并固定申请中的范围|
|change-scope / confirm-scope|请求者提出范围修改、提供者确认后生效|
|deliver / accept|提供者关联Attempt/Evidence提交交付，请求者确认指定交付|
|cancel / expire|双方可在指定未终结阶段取消；招募到期禁止新申请/成交，由请求者记录到期|
|dispute|双方对协作/交付/验收或已解决记录提出争议，原事件保留|
|propose-resolution / confirm-resolution|一方提出解决说明，另一方确认；不是独立仲裁|

招募到期时间只约束招募与待确认阶段，不伪装为交付截止时间。事件包含明确版本和时间，重复的相同事件幂等，冲突ID/过期版本拒绝；原事件序列可重建相同状态。申请者不能自选、请求者不能代替提供者确认，解决方案提出者不能自我确认。

Context授权、付款和能力验证不随状态流转自动打开；这些能力始终标注false。服务核实请求者拥有Case，交付必须引用同Case的Attempt，Evidence必须关联该Attempt的Result。引用存在不表示证据验证通过，也不自动授予完整Case读取权限。

## API与客户端

|方法/路径|用途|
|---|---|
|POST `/v1/assistance`|创建协作请求|
|POST `/v1/assistance/query`|按可申请、本人发布、本人参与查询请求|
|POST `/v1/assistance/events/receipt`|作者核对指定事件和摘要的历史接收回执，不返回正文或当前访问权限|
|POST `/v1/assistance/{id}/events`|追加申请、选择、确认、交付等事件|
|GET `/v1/assistance/{id}`|读取当前参与者视图及事件版本|

所有接口要求当前会话的独立`assistance` scope。写入使用`{consentId,payloadJson}`；请求载荷遵循`shared/assistance-schema.mjs`，事件载荷为`{assistanceId,event}`。每位操作者使用自己的`assistance.publish` Consent，精确绑定目标和原始载荷。创建返回`{assistanceId,eventId,version:1}`；事件返回新版本。相同ID及原载荷重发返回原回执，版本冲突需先读取再由调用方决定新操作。已创建请求的同载荷重放不再按新的招募请求处理，Consent仍须有效。

根请求的Private/Public必须与Consent一致。后续事件默认Private，接收方包含请求者及动作涉及的选中提供者；Shortlist可仅请求者查看。公开请求中的贡献事件可逐条明确选择Public，见[公开贡献分享](public-contribution-sharing-v1.md)。申请、选人、名单和邀请维持Private；提供者的结束后反馈默认Private，也可在公开请求中单独预览并签署公开反馈，见[通知与请求者履历](notifications-requester-history-v1.md)。请求者看到全部申请，普通申请者只看到自己的申请及当前状态/版本，被选提供者看到自己的申请和获准协作事件。Public根请求不开放匿名协作详情接口，也不公开其他申请者的报价或提案；Honor通过自身投影返回当前公开可见贡献。请求查询只返回当前可见的请求说明，不返回竞争申请内容；撤销/到期授权和已撤回来源Case不进入列表。

`@galaxy/client/assistance`导出`createAssistanceClient`，接口为`prepare({consentId,payloadJson})`、`execute(preview,preview.confirmation)`、`cancel(preview)`、`get(id)`和`query(options)`。prepare只生成本地预览，调用方需先取得对应Consent。实际网络写入使用原载荷，读取标注endpoint-reported。宿主控制器提供`prepareAssistance`、`executeAssistance`、`getAssistance`，共享现有取消和单操作状态；`createLocalHostRuntime`已组合该客户端，可注入测试transport。原生接入页的第7项“协作请求”已接入列表、发布、申请、选择确认、交付和争议操作；主控制台仍为原6项，未全局安装。

## 查询与引导操作

查询参数为`{view,query,limit,after}`：view为open（仍可招募）、requested（本人发布）、participating（有本人事件）；query为标题/问题的连续子串，不搜索申请人的私有提案。limit默认8、最大20，after为上一页nextAfter。返回`{items,nextAfter}`，每条含请求说明、请求者、当前状态和版本，不返回全站总数。授权变化可能改变翻页结果，不承诺快照分页。

`prepareCollaboration({request,viewers})`准备创建；request可省略id，由本机生成。`prepareCollaboration({assistanceId,event})`先读取当前版本，再生成事件ID和对应Consent，接收方从当前请求者、选中提供者/所选申请推导。`executeCollaboration(preview,confirmation)`以一次明确确认提交Consent和事件；准备阶段不签名或写入远端。Consent与事件是两次请求，失败不承诺原子回滚。原低层prepareAssistance接口仍可用于已有Consent和冻结ID的显式重发。

引导Consent有效期以当前binding到期和最长30天为上限，同时受本地接入意图约束；来源Case授权过期仍会使协作不可读。预览展示准确范围、接收者、有效期与载荷。运行时仅为正在确认执行的协作意图使用当前本地身份签名，没有公开任意签名接口。

原生表单支持开放协助、固定金额、预算区间、请求报价，以及指定参与者的Private请求和Public请求说明。当前按已发布Case ID关联；事件菜单按参与者视图/状态提供申请、候选列表、双方确认、范围变更、交付验收、取消/到期、争议与双方解决方案。真实OpenCode的布局和键盘体验仍待人工验收。

引导操作目前为进程内预览，尚无协作草稿持久化/重启恢复；提交结果未知时显示请求和事件ID，先读取核对，不能重新创建相同业务来代替恢复。Context材料授权已单独实现，见[选定材料授权](context-grants-v1.md)。

## 保存、撤销与后续边界

Schema12新增`assistance_requests`快照与不可变`assistance_events`。每个协作串按行锁串行追加，快照、事件、审计同一事务写入。API角色可追加事件及更新快照，Worker没有新增协作权限。数据库迁移从11升12；旧11版程序不能直接用于12版库，回退须使用相容版本或已验证的数据恢复。

当前采用整串有效性检查：来源Case撤回，或Case/任一协作事件Consent失效时，协作读取和追加被拒绝。因此竞争申请人的授权撤销也会使整串暂时不可用。后续需实现失效事件隔离与重建策略；不能在接口不可读时认定请求不存在或自动重建。取消仅改变协作状态，已授权事件仍可作为历史读取；材料读取通过独立Context Grant开放，见[选定材料授权](context-grants-v1.md)。

2026-09-10 已接通求助/赏金及[后续协作事件草稿](assistance-event-drafts-v1.md)持久化、离线续填、明确版本刷新、提交日志与准确回执恢复，见[协作恢复说明](assistance-recovery-v1.md)。资格判断、通知和举报/暂停/申诉沿用各专项实现；不能将此段历史待办当作这些模块尚无代码。仍需完成独立 Context 材料草稿恢复、逐次材料读取审计和真实用户协作验收；原任务表的其他条件保留。基础赏金仅为说明，无自动付款或官方交易保障。

本批关键自动化覆盖客户端→宿主控制器→HTTP→数据库的多方流程；具体测试结果与真实PostgreSQL结果见项目本批实施记录。没有全局安装宿主或部署动态服务。

Schema13当前追加独立材料授权及提供者接受表；本页Schema12指协作表引入时点。材料不进入Assistance事件或公开查询正文。

当前站内邀请、收件箱/偏好与请求者履历见[模块说明](notifications-requester-history-v1.md)。Schema14追加偏好和已读记录；之前迁移编号为引入时点。
