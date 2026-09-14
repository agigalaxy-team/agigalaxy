<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/e4/e463bcab5da2192f20b5a5ca1f374248f855e85337ce6f08a4c239069ebfe572.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Case 纠正与争议状态首版

对应 C10-06 的部分实现。沿用 `POST /v1/cases` 的 revision 事件及精确 payload Consent，不引入数据库迁移。旧 revision 保持原语义；新事件可增加可选 `review`：

```json
{
  "threadId": "开篇 revision 的 UUID",
  "type": "dispute",
  "state": "opened"
}
```

`type` 为 correction 或 dispute。新话题的 threadId 必须等于事件自身 id，初始状态只能为 opened。后续事件保持同一 threadId、type 和 correctsEventId，使用新的事件 id 及当前 expectedVersion。

允许 opened/reopened → in-review/resolved/rejected，in-review → resolved/rejected，resolved/rejected → reopened。现有 Case 写锁、版本检查、幂等、Consent 与同事务审计均继续适用。每次变化要求 reason 和 summary，所有原事件保留。resolved 只表示所有者报告处理结束，不自动改写目标结果；实际事实修正继续追加普通 revision。

Case 读取及 History 投影返回 reviews，每个话题包含当前状态和完整 changes。宿主详情展示处理状态和后续说明。每条变化仍受原授权链约束，任一事件授权撤销后聚合视图隐藏，避免返回已经撤销的说明。

处理权限目前限 Case 所有者；结果标注 `authority: case-owner-reported`、`independentDecision: false`。这是所有者记录的处理过程。跨参与者提出申诉、独立裁定权限、Proof 争议状态传播、宿主提交表单尚待实现，C10-06 保持进行中，不能作为完整争议系统验收。旧客户端需要支持新增可选字段才能提交新状态事件；旧格式仍可使用。

## 提交客户端

独立包 `@galaxy/client/case` 提供 `createCaseClient({endpoint, sessions})`。不含数据库、服务器签名器或本机密钥读取。已有会话需含 case-teaser scope，每次请求前后检查该会话仍有效。

```js
import { createCaseClient } from '@galaxy/client/case';
const cases = createCaseClient({ endpoint, sessions });
const preview = cases.prepare({ consentId, payloadJson });
// 宿主展示 endpoint、consentId、完整 payloadJson 和 confirmation，取得用户确认。
const result = await cases.execute(preview, confirmationFromUser);
const record = await cases.get(result.caseId);
```

Consent 必须已通过既有授权流程创建，绑定同一个事件 ID、接收方、字段及原始 payloadJson 哈希。客户端不自动创建或扩大 Consent；保留原 JSON 字节，不重新序列化事件。Case 使用 /v1/cases，其他事件使用 /v1/case-events。

取消调用 `cases.cancel(preview)`。预览只执行一次；超时/错误不自动重试，也不能断言服务器未收到。可先显式读取 Case，或以完全相同 consentId/payloadJson 重新 prepare 并确认，利用服务端事件幂等；不能为重试生成新事件 ID。返回的记录是 endpoint-reported，未升级验证强度。

## 宿主接线

`createLocalHostRuntime` 已组合 CaseClient。controller 提供 `prepareCase(request)`、`executeCase(preview, confirmation)`、`getCase(caseId)`；Case 预览/提交与连接、绑定检查、履历查询共用操作互斥和取消生命周期。取消 Case 提交不声称服务器回滚，也不自动销毁仍有效的会话。

开发版 Adapter 可通过 `createGalaxyAdapter(controller, { readCaseSubmission })` 注入已选中、已有 Consent 的草稿提供函数，返回 `{consentId,payloadJson}` 或 null。有此提供函数且会话含 case-teaser 时，“接入银河”显示“提交已授权草稿”。预览完整载荷，确认后发送。无提供函数的默认 Adapter 不显示该入口。

这已实现宿主提交预览/确认表单，但尚未实现从本地 Case 自动映射到远程事件、草稿选择器及创建 Consent 的统一引导。不能把可注入入口描述为已完成普通用户端到端发布流程。全局 OpenCode 未安装本批改动，真实宿主验收待完成。

## Proof / 履历联动（2026-09-10）

Proof GET 和 status GET 在原有来源、有效期、授权和签名检查后，读取关联Case的revision事件，返回可选 `caseContext`。其状态为 active-dispute（尚有提出/处理中/重新打开的争议）、has-corrections（存在普通纠正）或 review-recorded（有处理记录）。同时保留各话题和状态变化、Case版本及检查时间。

只有查看者获准读取整条Case事件链，且各事件Consent仍有效时，才返回该上下文。缺失 caseContext 不表示“无争议”，可能是未授权、撤销、没有相关记录等，调用方不能作否定推断。私有Case的争议不会通过公开Proof泄露。读取数据库失败继续作为失败处理。

这是 `visible-case-context-only`、`case-owner-reported` 的实时伴随信息，不属于原签名载荷。原CI执行事实及签名不改写，active仍仅表示该受限CI Proof当前可读有效，不表示任务结果已证实。独立裁定、Evidence本身争议/重新验证和Honor联动尚未实现。

History关联Proof复用同一读取逻辑，宿主详情展示其当前上下文状态；测试覆盖提出→解决→普通纠正、status读取、履历一致、签名不变及公开隐私边界。2项针对性测试、lint、Adapter类型检查通过。无需数据库迁移，未部署动态服务。当前草稿发布引导进度另见 local-case-publication.md，以上较早宿主段落保留其当时范围。
