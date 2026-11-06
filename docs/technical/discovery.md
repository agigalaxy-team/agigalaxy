# 搜索、推荐与使用分析适配

银河适配实现在 [`go/internal/discovery/`](../../go/internal/discovery/runtime.go)；原生构建源见 [`services/galaxy-discovery/SOURCE_BUILD.md`](../../services/galaxy-discovery/SOURCE_BUILD.md)，运行模板在 `deploy/discovery-stack/`。本页保存adapter、采集和原生配置合同，分析投影的共享解释见[接口](interfaces.md#受控查询投影与使用分析)。

## 参与者发现与内容推荐的区别

Meilisearch、Gorse 和 OpenPanel 负责本页所述内容搜索、推荐和分析，不能据此宣称已经实现专家匹配。当前参与者线索另由 `go/internal/opportunities`、`searchv2` 和 `builders` 提供。

机会匹配要求双方存在对应参与意愿和共同目的，按功能标签交集／并集形成相关性；候选分页读取，不是全网语义排名。当前项目、参与者类型和能力主要来自声明，详情可关联可读履历。自己的 Agent 可结合问题、实际经历、可用工具及条件理解候选，但声明不证明专业水平，愿意联系不等于接受工作或当前在线。

Builder 的 A2A 协议探测只观察协议表现，不验证对端工作能力、控制权或服务质量。现有线索尚未与统一专家匹配、对端运行接入及混合房间协作完整贯通；这不否定已有查询和结构化匹配。产品上的人、组织、Agent 与工具应按实际能提供的帮助组织，不能用后台五岗位或一种标签算法代替整个参与者网络。

## 原生栈与启动

| 引擎 | 模板选定范围 |
|---|---|
| Meilisearch | community v1.55.0、MIT，keyword/index/tasks，不引入enterprise |
| Gorse | v0.5.11、Apache-2.0，native统计协同、neighbor/latest fallback；LLM/embedding/reranker配置空 |
| OpenPanel | 固定public2.x源，AGPL-3.0，SOURCE_BUILD/source-inputs定义完整构建；不以同名3.x替代 |

发行线tag不等immutable digest，目标pull须取实际RepoDigest并作为部署override。compose/gorse.toml/ClickHouse配置为非秘密源，runtime.env.example只列名字；各自独立key/password/卷，不借业务数据库或别人的Redis。默认主机loopback端口Meili17700、Gorse guard18088、OpenPanel18001，启动前核可用；native Gorse network internal且不发布原生API/dashboard，共享Docker网络允许所需loopback binding。

Gorse多candidate不支持ranker.type=none；模板采用单native协同候选及neighbor/latest。v0.5.11 Redis cache适配要求RediSearch，所以当前cache用独立Gorse PG、galaxy_cache_前缀与btree_gin；OpenPanel自己的普通Redis队列独立。原生Gorse AuthFilter可能把拒绝key写日志，guard以constant-time验证并在闭合路由转固定native key；不暴露原生端口、不向它发故意错误key。

OpenPanel API执行自己的migration。首次healthy后在API容器运行 `node /opt/galaxy/bootstrap-openpanel.mjs`，加载实际TS Prisma client `packages/db/src/generated/prisma/client.ts` 及原scrypt（不是未生成的默认@prisma/client）。仅创建配置的org/project、非登录service-owner membership、独立project-bound读写client；org:admin会员关系防上游hourly orphan删除，不伪造User/Account/Session/Invite或订阅。已有owner/credential漂移拒绝，控制器更新不能重跑初装/bootstrap。

## Runtime和Worker组合

API 和 Worker 从受保护的 `GALAXY_DISCOVERY_CONFIG_FILE` 读取当前配置，字段与校验见 [`configuration.go`](../../go/internal/discovery/configuration.go)。`galaxy-api` 装配 Store、当前社区来源、Meilisearch、Gorse、OpenPanel 和权限适配；配置缺失时保留明确 not-connected，不创建第二套 Node Runtime。

[`Runtime`](../../go/internal/discovery/runtime.go) 维护查询与状态，[`Worker`](../../go/internal/discovery/worker.go) 分页完成 reconciliation sweep，再接续索引和投递；Meili 写入须等原生 task 成功才确认。业务迁移106和角色授权来自 `go/internal/databaseschema/sql/` 的中央迁移，不从 JS schema 生成，也不另设隐含删除任务。

Worker 使用独立数据库角色及配置中的原 `sourceMetadata`，以当前 Go 社区只读来源核对内容、许可、分类、治理、编排、标签、撤销和到期状态。它不取得账户授权的写权限、不读取私聊或附件，也不在 Worker 启动时重配专业引擎。配置及组装入口见 [Go 核心运行说明](../../go/README.md)。

## 采集事件和用途

collector把实际路由映射成home/community/find/account/help/download闭合page key，不传任意URL/query/accountId/visitorId。服务端从official session或签名HttpOnly visitor cookie定身份，匿名在途事件不因ambient cookie变化收养为账户事件。OpenPanel用途site-usage-analytics，Gorse仅用实际合格内容反馈：

| 事件 | 实际源动作 | Gorse |
|---|---|---|
| pageview / search | 实际页面、find社区搜索 | 无 |
| search-click / content-click | 当前合格搜索结果/推荐链接 | click |
| content-view | 当前公开post/reply读取成功 | view |
| content-exposure | 推荐卡≥50%可见 | 无 |
| not-interested | 本人明确偏好 | 本地立即排除及native反馈 |
| content-bookmark | 当前匿名可读forum post的保存已ack | bookmark |
| content-participate | 账户post/next version/reply发布已ack | participate |
| 帖子／回复点赞及取消 | 账户真实互动关系与原操作回执 | 一条 `like` 反馈；取消按类型、账户、内容精确删除 |

bookmark/publication以原operationId作稳定eventId，并核原账户fresh session及准确版本/revision；按钮、未知写入、取消收藏、状态刷新不记成功。现有收藏collector不含单reply、私聊及其他kind。采集失败不改变业务已ack结果。新增page/event从真实动作扩展，不把当前六类固化为永久产品范围。

内容事件带精确kind/id/version并通过当前匿名reader；私聊、案件/举报/证据、通知、邮件正文及打开/点击/派生标签无此schema，不进入推荐。敏感页面若需基础usage须另设metadata-only page key。Meili只返回candidate ID/revision，Galaxy按当前source返回正文，不能用引擎旧snippet/totals；revision含公开curation。Gorse不合格item连feedback删除，IsHidden不等训练移除，返回前再核negative preference；cold-start/latest显式标其依据。

## 社区互动、关系与推荐信号

帖子和回复的互动状态、批量读取、办理及原回执由 `community` 服务负责。每个账户对同一对象只有一条当前点赞关系，计数是真实人数；取消沿原关系修订办理。`accountsocial` 复用原关注及回执：旧关系迁移为私人，首次新建关系默认公开，可直接修改可见性。公开关注／粉丝分页只读取公开关系和当前可公开查询的人物，本人原列表继续包含私人关系。旧操作回执保持原样，不能把新字段追写进已保存回执。

点赞事实与推荐反馈分开保存。用户命令在同一事务保存关系、原回执和期望反馈；后台按关系串行同步 Gorse，一次互动只对应一条真实反馈。关系修订和反馈投递代次分别记录：内容、许可、治理或到期变化沿既有发现来源队列触发重核，当前不再公开时按 `like` 类型、账户与对象精确删除反馈；恢复公开后可按仍有效的点赞关系重新投递。读取来源发生错误时重试，不将错误视为撤权；迟到投递按代次核对，不能覆盖更新后的期望状态。该机制依赖相关来源事件、Worker 和引擎实际运行，不能仅凭代码存在认定远端已经同步。

推荐策略的社区信号由获授权管理者配置，默认关闭；配置与原推荐策略共用版本及操作回执。启用时只处理个性化候选：当前资格、主题与负反馈裁剪之后，以候选原顺序为匹配基础，融合收到的真实点赞和作者对应领域的已采用权重，再执行原有重复及集中控制，返回前重核当前内容。显式最新和搜索排序不受此配置改变。

首版采用排名融合，同值并列、同分保持原顺序；匹配权重须大于两项辅助权重之和。初始参数为匹配 1、内容认可 0.1、作者影响 0.1、平滑参数 20，均可在允许范围内调整。内容认可依据实际点赞，评价者缺少有效权重时按中性参考；作者缺少有效权重同样按中性参考。两项辅助贡献取较大值，避免共同来源无条件叠加。线上读取已保存且依据仍有效的权重结果，不在网页请求中调用模型；实际反馈数量不因权重复制。内部请求记录保存采用的结果版本，公共响应不暴露数值、计算依据或隐藏系数。

互动、成长和关系变更通过现有事件流通知相关页面局部更新；公开事件不包含点赞者、私人关注对象或 AI 权重。事件是重读提示，不授予新访问资格；失去公开资格的内容仍由当前读取规则处理。旧 GUID 荣誉及尚无明确账户归属的来源，继续按[社区成长设计](community-growth-and-reputation.md)中的资格与承接边界处理，不据关联猜测归属。模型材料、权重更新及推荐的实际效果仍需按该设计验证，部署和开启状态以目标环境为准。

## HTTP与原生分析

[`Handler`](../../go/internal/discovery/http.go) 接网站 Origin、访问身份、当前账户和既有权限服务，提供以下入口：

| 路径 | 方法/解析 |
|---|---|
| /v1/discovery/config | GET无query，visitor cookie/CSRF |
| /v1/discovery/events | POST≤2048字节，精确website Origin、discovery CSRF，登录时另核账户ID/CSRF |
| /v1/discovery/search | GET q/topic/数字after/limit，匿名当前source |
| /v1/discovery/recommendations | GET mode/topic/limit，official或visitor身份 |
| /v1/operations/discovery/analytics | GET kind/days/scope/accountId，以analytics.read在native前后核验 |
| /v1/operations/recommendation/community-signals | GET读取、POST保存社区信号配置；沿原推荐权限、版本及操作回执 |

拒未知/重复query及未知event字段，CORS只准所配Origin和准确headers，Bearer宿主凭据不作为analytics账户。overview/retention/paths/account用public2.x native Insights读client；business用相同client的GET /export/charts、ChartEngine、用途filter及reading/searching/bookmarking/participating四序列。计数是event occurrence，不是人数/session；取等长不重叠秒级[from,to)，不使用会把边界截成日期的event export totalCount。

原生overview的unique_visitors/total_sessions/total_screen_views、cohort近12周任意活动on_or_after、top-path子集的session transitions、profile lifetime是不同basis，DTO分别记录。原cohort含visitor:与account:混合，不称注册留存。Galaxy account-scope patch仅为cohort/user_flow增加scope=accounts与可选UUID accountId；对应Galaxy retention/paths使用，overview/business不受此scope，account kind仍要求ID。native headers必须确认准确scope/account，旧引擎忽略query则拒绝；无identify/alias或匿名回填。scoped cohort基于窗口首次合格活动，ClickHouse timezone没提供则未知，flow按account+session与native project timezone。匹配patch image启用后才开放scope，源码公开链接由固定source archive提供，不从旧版本推出支持。

AgentOS通过Galaxy受控工具，不能直接取native engine。searchSelected须服务端当前task选中的非空post/reply集合，模型不能改选集；候选过滤并重核，返回ID/version，再经固定read tool取正文；不产生新public endpoint/collector。

## 写入确认与定向探针

OpenPanel outbox先持久化submission_started再发送，unknown以稳定event ID经native reader核对，不因lease到期盲重发。ingestion ack与ClickHouse可见是不同观察。相关检查按[开发](development.md#故障定位与未验证范围)解释。

需要原生中文/write检查时，已授权部署者运行 `services/galaxy-discovery/native-probe.mjs`，输入保护文件或stdin `-`，shape为 `{meilisearch:{url,apiKey},gorse:{url,apiKey}}`，分别用operational master key/guard key。只创建一个galaxy_native_probe_UUID index和post_UUID item，不写真实内容/user/feedback、不调用OpenPanel；等Meili task、核中文match、读Gorse latest（warm-up空如实保留）。finally仅删原精确index/item并核完成/404；清理失败保ID/闭合码，不宽扫业务index。此命令不是日常健康检查。
