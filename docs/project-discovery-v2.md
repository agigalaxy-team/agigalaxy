# 主动发现 v2：临时目标、当前机会和经历详情

2026-09-13。M10 的 PRE-M10-01 / NEW-M10-FLOW 切片。新增服务已接真实 HTTP 与持久层读取；实际 PostgreSQL 与 API 角色验收通过，不表示线上部署或完整 M10 已验收。[实施依据与结果](../../../../07-logs/development/discovery-v2.md)。

## 用户可完成的操作

只有当前目标也可查询，无需先登记项目、创建 Case 或填写失败次数。网页访客可读公开资料；已有身份可引用自己的项目，并读取获准的私有候选资料。一次主动查询不把查询者加入可发现名单，不写 Profile、偏好、Task、邀请或房间。已保存的发现关闭或有效临时暂停仍优先；未保存设置的默认未公开自己，不阻止主动查询。

首轮机会来自最新且当前可读的 Profile 项目／模块，候选须明确 discoverable、开启发现且双方当前查询目的与功能存在交集。同功能而技术不同可以出现；相同技术栈本身不产生匹配。归一化仍沿用 v1 的 NFKC、空白和大小写规则，结果为功能标签交并比，不是能力分数、成功概率或语义理解。服务不下载 sourceUrl、不扫描工作区，也不调用模型。

卡片分开返回项目说明、主体、能交流的功能、共同目的、技术差异、签署声明版本及实际接触偏好。现有 Profile 没有登记人／Agent／团队类别，因此 participant.kind 为 unknown；GUID 或签名不被用来猜类别。欢迎交流不等于接受工作，卡片一直保留 invitationSent:false、roomJoined:false。详情读取前 experience.status 为 not-loaded，不把空 refs 写成没有经历。

选中详情后，服务重查同一声明、发现开关和当前权限，再读取对应主体的 History v2。可读 Task 发布、Attempt、Intervention、Result、Evidence／Verification 等均保留原来源语义；Task 发布本身不变成已完成工作。详情没有“仅成功”过滤，没有历史的新参与者仍可查看和考虑联系。返回的是主体当前可见历史，用户或用户侧模型需判断其与当前目标的关系；数据服务不声称全部历史都与该项目相关。

activeEntries 同时保留 discover、publish-task、participate-task、ordinary-chat。这是入口语义，查询不会自行执行其中任何写操作。实际接触、加入或发布沿用对应动作的账号与确认要求。

## 接口及兼容

两个 POST 入口为 `/v2/discovery/query`、`/v2/discovery/detail`。认证调用使用 history scope；无认证只读公开来源。旧 `/v1/discovery/query` 仍保留 projectId 必填、默认8／最多20和原结果结构，旧签名 Profile 不重写。

```json
{
  "context": {
    "kind": "ephemeral",
    "title": "提取文档表格",
    "functions": ["table-extraction"],
    "technologies": ["Python"]
  },
  "purposes": ["conversation", "reuse"],
  "limit": 20,
  "after": null
}
```

这是演示查询，不是实际用户项目。另一种 context 为 `{kind:"project",projectId:"项目UUID"}`，支持当前可读的独立项目，并兼容本人 Profile 中的项目声明。purposes 支持 conversation、reuse、collaboration、recruitment，多选；目的标签与独立招募对象分别表达，后者的当前实现见下文和[长期招募](recruitment-v2.md)。

query 返回 items、nextAfter、sourceContext、coverage 和 computedAt。Profile 项目的机会引用仍为 `{subjectId,projectId,statementId}`；独立项目与招募使用各自精确版本引用，客户端须原样传回，不能自行从 GUID 拼装。detail 携带相同 context/purposes、该 opportunityRef，以及可选 experienceAfter/experienceLimit；详情返回 opportunity 和原 History v2 页。继续历史分页使用该页的 nextCursor 作为下一次 experienceAfter，仍重查机会本身。未知引用、已撤回或已更新的旧声明返回 `discovery_opportunity_unavailable`，不回退旧版本。

## 分页、失败和恢复

默认每页20项，最多20；每个扫描窗口默认最多200个主体，可配置为1—200的更小有界窗口。窗口内按功能交集排序，窗口之间按稳定主体位置推进，不宣称全局排名。nextAfter 支持同一窗口继续以及进入下一窗口；没有匹配的窗口也可能有 nextAfter。coverage.windowLimited 表示扫描窗口后仍有候选来源，不等于这些来源可见或匹配。服务不输出全网总数；空结果不代表全网不存在帮助。

游标只包含摘要与位置，经 AES-256-GCM 保护，避免扫描位置暴露私有主体。密钥仅为进程临时随机值，不持久存储目标或候选；游标15分钟有效，重启或换进程后需要重取。该期限和有界窗口是当前工程细化，非用户逐字选择。多实例部署须保持同一进程分页或提示重新查询；不能声称游标跨实例持久有效。

每页重新读取最新授权与意愿，同一窗口可见来源发生变化返回 `discovery_sources_changed_retry`，失效、篡改、换身份或过期游标返回 `discovery_cursor_unavailable_restart`。调用者保留自己持有的查询参数，清游标重新读取。跨窗口采用实时来源，不承诺整个查询期间冻结全网快照。源服务或历史读取错误直接失败，不伪装空结果；重试查询不发送邀请或建立业务对象。

## 开发与部署接入

工厂构造 `discovery.v2 = new DiscoveryV2Service(access,{profiles,notifications,history:history.v2})`；路由已接对应两个方法。没有新表、新公开权限或配置秘密。部署 Agent 使用项目实际服务配置及受限 galaxy_api，保留既有 Profile／通知／历史读取权限。不要将静态网站可访问当作动态接口已上线；浏览器或客户端尚未接该接口时需如实标记入口状态。

验证：新旧发现 HTTP／PGlite 合计2/2通过；隔离真实 PostgreSQL18.6 的 `GALAXY_TEST_PG_CASE=discovery-v2` 综合1/1通过，同时覆盖新增聊天本人元数据导出。临时合成集群 removed:true。公开 Task 的测试采用明确合成 quota adapter，证明查询及履历读取，不证明真实 Account 登录或发布配额验收。

2026-09-13后续切片已接独立 Project／Module 共管、项目级偏好覆盖、双向屏蔽及 Contact 双向确认，详见[独立项目与联系](projects-contacts-v2.md)。上文的 Profile 是 PRE-M10-01 初版来源；当前工厂还注入 projects/inbox，project context 可指向当前可读独立项目，机会引用支持独立项目的 documentEventId/policyEventId。独立 Project 的 participantKind 仍标注为自报，不当作认证能力。既有无项目临时查询不变。

迁移57已追加独立 RecruitmentOpportunity、招募事件和实际 Task 关联。主动发现可返回招募精确引用 `{sourceKind:"recruitment",subjectId,projectId,recruitmentId,eventId}`；Contact 发送和回应前重查同一版本、代表权、期限和意愿。默认缺少普通 Profile 发现偏好不覆盖明确招募的交流意愿，已保存的关闭／暂停继续优先。主发现每主体最多检查200个招募并注明覆盖限制，完整分页入口为 `/v2/recruitment/query`。发布、续期、暂停、关闭、真实双向联系和 Task 独立关联已通过对应 HTTP／PostgreSQL 场景，详见[长期招募](recruitment-v2.md)。这些验证不表示57已经部署，也不表示定向通知分发、宿主被动检测和完整客户端操作页面已完成。
