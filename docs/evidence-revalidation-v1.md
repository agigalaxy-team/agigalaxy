<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/c8/c8271282cbaa534cc15efdf4b0d79840c2e8abdc06e96722ffbcab67bc33c083.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Evidence争议、重验与处理沿革

2026-09-10 当前补充：[验证者参与案件](verifier-participation-v1.md)新增本人签署的复核意见，与这里的实际 Evidence 重采集分开；参与者不能裁定或重验自己的案件。当前 Schema37/42表；下方保留最初 Schema31 交付记录。

2026-09-10，本地实现。Schema31/39表，未新增表或改写源事件；动态Official服务未部署。C10-06实现转待复核，实际来源、真实用户和OpenCode体验验收保留。

## 报告和重验

一般Case报告可附 `evidenceId`，必须准确关联该Case的 `targetEventId` 结果。报告人要有当前Case和Evidence读取权。报告是指控，不改变原结果或自动触发验证。

配置的独立处理人明确签署 `moderation.publish` 下的 `revalidate` 事件，正文包括reportId、expectedVersion、evidenceId、summary及事件ID。处理人不能是报告人或Case所有者，还必须有当前来源读取权。原生入口沿用“Case独立争议处理”：选择结果的Evidence争议，填写已有且有权读取的Evidence ID；处理记录中可查看验证轮次、明确启动重验。

同一事务追加处理事件并写既有jobs队列，幂等键为重验事件ID。新轮次记录递增generation，每份Evidence最多20次重验；同一来源已有pending/running任务时不再排队。不清空旧任务、观察或Proof。重验使用原Evidence的准确source引用；更换CI run/commit需要另提交Evidence，不能借重验替换旧来源。

Worker沿用既有采集、租约、重试和审计，采集前及提交观察前检查原Evidence授权和此次重验的签名Consent。重验Consent撤销后不采集，追加revoked观察；原观察保留。不可用来源沿用最多5次任务尝试。处理结论、请求重验、采集完成是不同事实，不能互相替代。

## Proof、资格、Honor

- Evidence读取在当前重验排队/运行时返回revalidating及verificationGeneration。最新轮次失败且没有观察时返回unavailable。
- Proof只认可当前验证轮次的有效观察。新轮次排队后旧Proof不再作为当前有效来源；即使重验再次成功，旧Proof仍绑定旧observationId，不会悄悄换签名或观察。
- 新观察需要明确预览、授权并发布新Proof。失败CI观察仍是受限CI事实，不能提升为任务成功或个人能力认证。
- Case级暂停影响Proof参与资格；协作暂停和当前Proof读取同时影响依赖这些证据的Honor。普通参与贡献与要求CI成功的规则保持各自含义，不因弱Evidence升级身份。
- 签名原文及数据库旧记录保留。读API的不可用结果不解释为物理删除；对未授权调用方不披露不可用原因。

## 履历与处理沿革

History和可读Proof增加按查看者授权得到的moderationContext，区分Case所有者自述与独立处理过程。当前投影最多20份可见报告，各显示最后10个可见事件；完整处理记录仍从原报告入口读取。举报正文、双方补充、处理决定、重验轮次遵守各自当前授权，不因Case公开而公开举报。

匿名视图不返回私有处理记录。空context只表示此视图没有可显示记录，不证明不存在争议。Proof访问本身不授予整个Case或处理材料的读取权。

履历重建规则升级case-history@4，新增moderationContext进入可见内容摘要；v1/v2/v3兼容保留。版本不同的摘要不作同规则比较。私有举报不会改变匿名履历摘要；当前公开Proof因重验不可用时，公共视图只反映Proof当前不可用，不说明私有指控内容。原生详情展示处理状态、决定变化与验证轮次。

## AI Agent部署

使用Schema31及本批API、Worker、客户端。重新执行现有worker-role.sql的显式角色配置，增加对moderation_events的SELECT，用于核对重验命令；未增加其改写Case、Consent、Proof或处理记录的权限。此次没有数据库migration、全局OpenCode安装或远程部署。

部署检查用独立测试数据执行报告→独立签署重验→队列→新观察→新Proof，并检查旧Proof、History、资格和Honor变化。验证命令撤销后不采集；验证没有来源读取权的处理人不能发起重验。观察与签名记录必须保留，不能通过删旧任务或改旧Proof来“修复”状态。

自动化证据包含17项不同相关用例；另有真实PostgreSQL受限API/Worker角色覆盖既有History流程和重验（Honor补充断言在随后本地复跑覆盖）。这不代替真实来源或人工宿主验收。下一批推进C11的可解释检索。
