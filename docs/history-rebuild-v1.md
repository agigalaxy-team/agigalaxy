<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/e3/e363c47ea0550a99b0edc3d9ef5d1a7e55e6a8ac81d605e076eacc9e982af03d.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 履历来源与版本化重建 v1

2026-09-10，当前本地实现为Schema31/39表，动态服务未部署。

对应 C10-01 的来源关联及 C10-02 的可重复重建。现有 History 从 Case 事实事件及当前可见 Proof、Capsule 复用记录现场生成，不新增一套可手填的能力履历，也不建立后台缓存队列。

## 返回内容

每条履历新增 `rebuild`：

- `rule`：当前服务为 `case-history@4`，客户端兼容规则 v1/v2/v3；与历史 API 响应格式 `projectionVersion:1` 分开。v3新增字段规则和报告结果时间线，v4增加当前可见的独立处理沿革，见[视图与结果说明](history-views-and-outcomes-v1.md)及[重验说明](evidence-revalidation-v1.md)。
- `endpoint / caseId / sourceVersion / view`：明确来源、事件版本和当前条目的owner/authorized/public视图。一次全部可见查询中，本人条目可以使用owner视图，即使整页标为authorized。
- `sources.events`：当前可见Case的完整事件ID、种类、顺序版本；不包含原文、Consent或隐藏配置的摘要。
- `sources.proofIds / capsuleUseIds / assistanceIds`：该条投影实际显示的来源。各最多20条，不宣称全量独立证据；Assistance引用为规则 v2 新增。
- `contentHash`：已显示字段的稳定SHA256。固定字段白名单与对象键排序；忽略投影中的 `checkedAt` 观察时间，保留事实时间、状态、签名及纠正内容。

所有源事件的当前授权验证通过后才创建重建记录。公共/获授权视图不通过摘要泄露本人配置：摘要输入只来自该视图已经返回的字段。来源事件的kind/ID/版本均属于同一已经获准查看的Case。

既有 `projectionHash` 保留原语义，仍可能随关联来源的检查时间变化；新对照使用 `rebuild.contentHash`。旧客户端和旧反馈记录无需改写。两种摘要都是端点报告内容的标识，不是独立签名证明或能力认证。

## 重建与对照

查询在读取父Case时持有共享行锁，防止追加源事件过程中返回旧sourceVersion配新事件。事件序号或根事件不一致时返回 `history_source_inconsistent`，不生成貌似有效的投影。该路径只读取事实，重建失败不改写源事件。

独立客户端在内存中最多保留128条重建记录，按当前主体和binding分开。没有自动落盘、后台查询或自动翻页。下一次查到同Case、同视图、同规则的记录时，返回 `rebuildComparison`：

- `unchanged`：来源版本、当前可见内容与引用没有变化，检查时间本身不算事实改变。
- `changed`：给出版本/可见内容/来源引用变化，以及新增、移除的事件、Proof、Capsule复用ID。移除仅表示不再返回，不能直接判断是撤销、过期、权限变化或其他原因。
- `incomparable`：没有同会话基线，或端点、Case、视图、规则版本不同。旧响应没有重建记录时仍兼容显示。

SDK通过已有 `/history` 导出 `compareHistoryRebuilds(before, after)`，可对照调用者明确保存的两份重建记录；不读取本地文件。不同规则版本会明确报告无法直接比较，后续算法升级需定义对应版本和迁移证据，不能把两种算法的摘要差异当作事实改变。

客户端先检查整页新记录的摘要与条目对应关系，再更新内存基线；无效响应不污染旧基线。普通已授权查询和会话检查保持原路径。原生界面显示规则/来源版本、内容摘要、对照结论及最近10条来源事件；完整来源列表保留在API响应中。

## 验证和部署

相关检查覆盖可见性/撤销、规则和视图隔离、检查时间变化、字段顺序、真实事实变化、无效记录拒绝、旧响应兼容、会话替换、原生展示及Capsule关联回归。受限API角色的真实PostgreSQL子集为 `GALAXY_TEST_PG_CASE=history`；runner只创建临时本地集群。

AI Agent 更新服务和独立客户端后，查询一条本人及公开履历，核对来源版本和投影规则；追加纠正后重新查询，对照变化但保留原结果。没有SQL迁移，API角色既有Case列更新权限支持共享锁。后台投影无队列，因此不存在等待重建的后台延迟；响应的checkedAt仍显示实际查询检查时间。

回退可恢复旧服务/客户端；旧字段和事件不变，新字段为可选扩展。不要把内存对照记录作为长期审计或完整事件仓库。真实来源、真实用户相关性反馈和原阶段共同验收保留。

## 能力需求与参与来源（规则 v2）

`collaborationContext` 关联同一 Case 下当前可见的 Assistance 根请求。`capabilityIds` 和 `requestedScope` 来自请求者声明的原始能力需求，固定 `requestVersion:1`；不推断提供者擅长什么，不表示当前变更后的协作范围，也不生成认证、评分或计功。

`participantLinks` 区分签署请求的 requester 和签署 confirm 事件的 provider，附来源事件 ID 与 authority。确认只证明曾确认参与，不证明已交付、成功或当前仍在履约。Case 自述参与者、本人尝试配置及现有 Proof 引用继续使用原字段。

根请求和每个参与确认分别复用现有 Consent/Binding 检查。本人 Case 视图可见当前获准的签署者；其他登录者只返回自己的参与关联；匿名视图无参与者身份。撤销确认只移除相应参与记录，撤销根请求移除整个能力需求关联。私有请求、私有 offer/select/confirm 不改变公共需求列表或其重建摘要。

关联查询明确从按 ID 排序的200个候选中返回最多20个当前可见请求，响应以 `coverage` 说明上限，不返回隐藏数量或完整覆盖的承诺。规则 v2 的摘要包括此可见关联；与 v1 比较返回 `incomparable`，同规则比较支持 Assistance 引用增减。既有 `projectionHash` 不纳入新增关联，保留旧兼容语义。

原生履历详情显示配置、能力需求与来源参与事件，并标注“非认证”。无需数据库迁移。验证包含公开摘要不受私有协作影响、本人/参与者/旁观者视图、分别撤销确认和根请求、来源事件不改写、客户端 v1→v2 切换及原生展示；真实 PostgreSQL history 子集复用同一流程。
