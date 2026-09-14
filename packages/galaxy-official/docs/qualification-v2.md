# M08 任务资格与外部范围核查 v2

本实现切片为 M08 S1/S2 的数据服务和参与条件计算，不代表 M08 全部完成。Honor 仍是 M08 S3；请求方信誉完整呈现、真实审核者运营、宿主界面和公开试点须分别交付。旧 qualification API、既有合法记录及 policy ID/version/hash 保留。

## 用户获得什么

模型可针对某个 Task、候选人、能力范围和当前规则，查询 `satisfied`、`not-satisfied` 或 `insufficient-evidence`。这是本任务参与条件，不能用于全局能力分、公开排名、通用专家认证或自动选人。没有设置历史要求的开放协助允许空履历新人开始。付费任务仍先声明预算，代码没有支付执行能力。

当前 `facts-v2` 算法将同一 Case 的多次介入去重，外部工作按稳定来源摘要去重。实际确认、实际介入或 Attempt、精确 Result、请求方在约定范围内接受交付，能成为一项相关经历的依据；接受诊断无需谎称整个问题解决。声明、读 Capsule、发布 Capsule、CI 通过和上传附件不自动形成独立审核。合成来源只出现在显式 `includeSimulation` 的模拟结果中，不能通过真实参与门槛。

原用户要求免费门槛低、付费有一定历史；“至少一项相关实际介入/结果并有验收或核查”来自已授权代选 C-Q-paid_criteria，不能伪称逐字用户阈值。其他依据：完整产品方案卷06、M08工作包、B-06-Q02、B-08-Q04、ROOT-Q-RANKING及历史Core25—29、178、380—382、415/498。具体读取记录见项目 `07-logs/development/qualification-v2.md`。

## 当前操作与接口

下列 HTTP 均为 POST，要求当前 `assistance` 权限和真实身份。MCP 与 HTTP 调用相同服务。

| 路径 | 方法 | 输入及结果 |
|---|---|---|
| `/v2/experience/submit` | `experienceReviews.submit` | `{consentId,payloadJson}`；声明、范围核查、纠正、撤销，各自不可变事件 |
| `/v2/experience/read` | `experienceReviews.read` | `{id,version?}`；精确来源状态、核查范围和来源关系 |
| `/v2/qualification/evaluate` | `qualification.v2.evaluate` | `{taskId,subjectId,evidence,includeSimulation?}`；本任务三态及条件 |
| `/v2/qualification/calculation-permissions` | `qualificationCalculations.submit` | `{consentId,payloadJson}`；候选人计算授权、源作者派生披露许可及撤销 |

MCP 工具在 `personal-mcp-qualification-v2.mjs` 导出 `qualificationToolDefinitions(services,actor)`。提交内容必须由客户端实际签署 Consent；服务不生成、猜测或伪造用户授权。独立来源作者和核查者分别拥有其签名事件。

`evidence` 接受 `participationIds`、精确 `externalReviewRefs:[{id,version}]`、`capsuleUseIds`、兼容的 `proofIds/assistanceIds`，以及可选 `calculationGrantId`。省略字段按空列表处理。临时演示字段不能通过严格 schema 自动变成正式字段。

## 原生工作与选择重算

新 Task 可显式设置 `qualification:{policyId,policyVersion,profile:'facts-v2'}`。没有此 profile 的合法旧 Task 继续使用旧规则语义，不暗中升级。选择参与者和参与者确认/确认新范围时，M11 在同一事务调用 v2 计算；界面上此前的“满足”不能替代当前授权与来源检查。

原生依据核对当前 Task、候选主体、当前 capability、参与确认、scopeVersion、交付者、真实 Result 的精确版本和它的 Attempt/Intervention。新的 Result 不会替代已接受的旧交付引用；旧版本被纠正后，旧交付不能继续当作当前资格依据。工作处于有效暂停或争议会影响该工作的支持材料；普通未生效举报不是全局封禁。当前仅实现任务暂停这一可验证限制，不把缺失的全局限制系统伪装成已检查。

M06 相关 Evidence/Verification 经原 Case 依赖校验进入可用性判断；工具观察、同控制者自测与独立核查持续分离。本切片的跨任务计算许可仅覆盖 Case/Task 原生 participation，不能借此打开任意 M06、聊天或第三方来源正文。专用 compute 不接受混入外部核查、Capsule、CI及旧协助ID，返回 `qualification_calculation_source_kind_unsupported`。这些来源仍可通过普通查询按当前实际读取权限计算；缺乏许可时返回材料不足，等待相应来源的限定许可扩展。

## 私有旧工作的有限计算

原 M11 私有参与仅给原双方读取，新请求者不能按旧 Task/Participation ID 读取。v2 新增独立限定计算意图，而非假装以候选身份访问：

1. 候选人选定任务、请求者、来源和精确版本，模型解释为什么需要这些材料。
2. 每个非候选作者，为自己拥有的精确源事件签署 `source-permission`。原有阅读许可本身不替代本次派生披露许可。
3. 候选人签署 `compute`，引用许可ID及相同证据选择。用途固定为本任务资格计算，设置到期时间，指定唯一请求者。
4. 计算仍保留实际调用者。候选人和该请求者可以复算；每次检查原始来源授权、作者许可、候选人仍有读取权、来源未被受管删除、精确字节摘要一致。
5. 结果只含公开条件及是否满足、材料不足原因和核查范围，不含旧项目标题、旧 Case/Task/Result ID、第三方姓名/GUID或正文。不授予源浏览和公开履历权限。
6. 源作者撤销、候选撤销、到期或删除时，相关计算不再可用。取消或失败不改变原旧 Task 的正常双方权限。

来源引用格式是 `{kind:'case-event'|'task-event',id,eventVersion:1,payloadHash}`。ID 指不可变事件，而非可变逻辑对象；`eventVersion:1` 是该不可变事件正文版本。逻辑 Fact 版本仍在所选事件与交付中明确核对，不能把事件序号误读为 Fact 版本。Hash 只保证所选字节对应，不能证明原文真实或模型已经理解。

Consent action 分别是 `qualification.compute` 与 `qualification.source-permission`，objectId 为命令 `id`。正文固定 `purpose:'this-task-eligibility-computation-only'` 和 `disclosure:'public-conditions-and-bounded-satisfaction-only; no-source-text-or-other-party-identity'`。Private viewers 仅候选人和该请求者，源许可作者仍拥有自己的材料。撤销命令 `{kind:'revoke',id,grantId,reason}` 沿用原许可 action。

## 外部工作、挑战与核查者

`experience.submit` 的 objectId 为 `operationId`。经历声明包含源系统、稳定记录、源时间、原作者、链接、内容版本、实际介入、结果、范围、限制和归属声明。链接多个不增加经历数；稳定来源的 SHA256 作为内部去重键，不保存私有标题到键中。挑战标记始终保留，不伪造为生产项目履历。

`review` 由当前实际登记的核查者签署，引用精确经历版本，明确方法、观察、限制、来源、时间和检查项目。`verified-in-scope` 必须明确检查来源、归属、实际介入、结果及验收/独立核查。自己不能给自己签非当事人核查；若接入的控制关系读取器发现同控制者，也拒绝。未知关系明确保持未知，不能声称已排除一切关联。

核查者配置使用 `experienceReviewerSchema`，限定 subject、capability、external-work/challenge 类型、scope、有效时间和运营登记依据。默认没有审核者，不创建“系统专家”。实际服务启用当前运行登记，删除角色或修改其范围会使旧服务的报告不可作为当前依据。范围审核是签名报告，不是服务器自动验证了互联网真实性。

纠正追加新版本及理由；原稳定来源或被核查对象不能在同ID下替换。经历撤销、不可读、纠正或核查者失效后，关联报告返回 `dependency-unavailable`。读取显式历史版本可见其 `superseded` 状态，不能纳入当前资格。受管删除留下的空正文只提供不可用状态，不恢复原文或继续认证。

## 存储、兼容与余项

追加迁移55：`experience_objects` 为主体归属与版本容器，`experience_events` 为各作者签名事件，`qualification_calculation_grants` 为计算和来源许可及撤销回执。旧迁移不重写，旧合法数据不删除。M19 按实际 subject 导出和删除；不同作者的报告各自保留，依赖被删除的来源时只能显示不可用，不凭外键残留重建内容。

仍需后续交付：完整请求方信誉视图、Honor规则及展示、真实审核者注册与运营受理、受限 Capsule 实际复用的独立审查适配、其他来源类型的限定计算许可、真实宿主和参与者验收。查询列出的路径是保留的产品路径，不代表所有路径均已获真实运营证据。

验证命令与结果记录在项目开发日志。代码测试验证协议行为；合成测试和静态接口不能作为真实付费协作、真实专家审核或完整业务上线证明。
