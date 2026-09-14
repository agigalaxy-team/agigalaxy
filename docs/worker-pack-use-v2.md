# Worker Pack 的实际使用关联

对应 M20、NEW-M20-FLOW、NEW-J20-INTEGRATE。schema69 为追加迁移；schema64 清单和原 builder work-evidence 保持其版本语义。此说明不表示第三方 Pack 已安装、取得独立能力认证或投入生产。

## 产品依据与完整流程

现行 C-Q-worker_pack 授权代选采用“可导出版本清单＋外部来源引用”，逐次关联实际 Configuration、Attempt 和结果，作者、运行者、验证者分别归因。依据为完整方案卷13.34、PWP-M20/PREP-M20-FLOW02、开放架构 v1.3 原快照 §6.2/§8.1–8.2。CUR-02/03 明确用户侧模型及 Skill/MCP 分工；银河不集中运行模型。

旧登记配置摘要是支持声明，不是使用者的实际 Configuration。旧 Node work-evidence 关联 v1 事实；新 PackUse 由实际 Attempt 的作者持有，不写入 Pack 作者修订流。签名说明谁声明用了哪个版本，不能独自证明环境实际安装、因果贡献或专业能力。

1. 查询 Worker，核对精确清单版本、哈希、来源、许可、依赖、模型要求、权限和环境。安装由原发布方及用户宿主处理。
2. 使用者登记明确选定的 Configuration 条件。完整 Prompt、私钥、认证资料和未选 Skill 正文保留在原位置。
3. 实际工作遵守已有 Case/Task/Participation/Context 授权，产生本人 Attempt。没有真实尝试就没有使用记录；网页下载不会创建尝试。
4. 选择该 Attempt 已关联的准确 Configuration 版本，签署 PackUse。进行中的尝试可先登记，结果保持未记录。
5. 结果产生后追加同一使用的新版本，选择来自同一准确 Attempt 版本的本人 Result。Evidence 与 Verification 使用精确版本，后者须指向所选 Attempt 或 Result。
6. 查看时重新核验来源，分别展示作者、运行者、配置作者、结果作者和核验作者；保留失败、部分完成和未知。关联不使原核验升级为独立验证。
7. 升级使用新 manifest、Configuration 和新 Attempt，记录 follows=upgrade；重试需要另一真实 Attempt，可继续使用原配置。旧引用不随新版发布自动替换，新版不继承旧验证。
8. 使用者可撤回关联；原 Case、结果与他人核验不被删除。停止网页重试只停止本机行为，Worker 停止由原宿主处理。

无配置工作仍可正常协作；只有创建可比较的 PackUse 要求实际配置引用。配置正文授权后来收窄时，独立尝试和结果仍成立，条件显示未知；明确依赖配置正文的结果继续服从原服务限制。已成立关联补结果不会因条件未知而凭空删除工作。

## 对象、权限与版本

worker_pack_uses 保存本人主体、准确 builder/manifest/Case/Attempt 引用、版本和撤回状态。主体＋manifest＋Attempt 唯一，避免多个新编号重复归集同一次使用。没有指向源对象的删除级联。

worker_pack_use_events 保存独立 operation_id、use_id、subject_id、版本、record/revoke、Consent、原载荷和摘要；只记录引用，不复制 Case、配置、证据、许可正文或身份控制材料。

后续记录不能更换原始 Pack、Case、Attempt ID、配置版本或前后关系；同一 Attempt 的精确历史版本可以选择。更正原始关联应撤回错误声明，不能把旧尝试偷偷移到新 Pack。

写入复用 builder.publish、builders scope，签名对象是 operation_id。本人可私有记录或公开关联；这不增加来源受众。源读权限逐对象、逐版本检查，作者从认证主体与实际 Attempt 推导。公开关联不会枚举私有 Case。游标只来自可见结果。

输出分别表达报告成功、尝试状态、问题解决、核验观察和 Pack 因果关系。successfulReuseVerified=false 与 professionalCapabilityVerified=false 表示此服务不作两种认证，不是否定贡献。合成来源保留 synthetic。

## HTTP、MCP 与恢复

HTTP 均 POST：

| 路径 | 输入与含义 |
|---|---|
| /v2/builders/pack/manifest | builderId、manifestId、可选 manifestHash；准确历史版本仍核验当前许可 |
| /v2/builders/pack-uses/candidates | 可选 caseId、after、limit；本人实际 Attempt 和可用来源选择项 |
| /v2/builders/pack-uses/events | consentId、payloadJson；record 或 revoke |
| /v2/builders/pack-uses/read | id、可选 version；当前来源投影 |
| /v2/builders/pack-uses/query | 可选 builderId、subjectId、after、limit |
| /v2/builders/pack-uses/receipt | operationId、payloadHash；仅原提交者对账 |

准确历史清单要求现行登记可读，原历史声明与原清单授权均有效。新版本不覆盖旧引用；下架或安全维护阻止新增关联，历史事实继续按许可解释。

MCP 六项调用同一服务：galaxy_worker_pack_manifest、galaxy_worker_pack_candidates、galaxy_worker_pack_use_record、galaxy_worker_pack_use_read、galaxy_worker_pack_uses、galaxy_worker_pack_use_receipt。数据服务不决定是否安装、扩大材料或让模型长期执行。

WorkerPackUseWorkspace 从清单和真实工作列表选择，不要求用户以手输ID为主要流程。签名前本地保存准确业务载荷，签名完成后先保存再发送。Consent 或业务回执丢失后对账并重试原编号/内容。原业务与原授权均未记录且旧绑定不能使用时，用户审阅后才替换授权，业务 ID 不变。停止本机重试保留最小 ID/摘要继续查询，不声称服务端取消。

## 导出、删除与保留

本人导出两表的本人关联及操作，不带来源正文。源材料仍经各自授权视图导出。此长期事实关联沿履历与配置类策略保留至本人删除，不借用临时邀请、评论日额或摘要30天期限；授权到期影响读取，不等于自动删除历史。

全服务删除按叶至父清理本人 events/uses；不删除他人的 Pack、Case、Evidence/Verification。源作者删除后，独立使用者的关联不能继续充当成功证据：来源不可用，正文停止投影。pending-deletion 遵守公共 ConsentReader 的可取消隐藏语义，不提前硬删。没有新增备份系统。

## AI Agent 部署与验收

本模块没有外部模型端点、下载凭据或常驻服务。追加迁移69后按 API/worker 角色配置两表有限权限；保留旧迁移与合法数据。服务注入真实 BuilderSupport、Case、Configuration、Verification，缺服务不回退到未经授权的原表正文。

必要验证：准确清单→第三方本人配置/尝试→结果和其他参与者核验→重复回执→许可撤销→升级新引用→导出删除。测试保持合成标识，不把本机进程、签名或自动测试写成真实第三方效果。真实宿主安装和模型运行需相应宿主实际记录证明，不能通过填写表单生成。

实施和部署证据见项目 07-logs/development/worker-pack-use-v2.md。
