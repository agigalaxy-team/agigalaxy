# 搜索、推荐与使用分析适配

银河适配实现在 [`go/internal/discovery/`](../../go/internal/discovery/runtime.go)；原生构建源见 [`services/galaxy-discovery/SOURCE_BUILD.md`](../../services/galaxy-discovery/SOURCE_BUILD.md)，运行模板在 `deploy/discovery-stack/`。本页保存adapter、采集和原生配置合同，分析投影的共享解释见[接口](interfaces.md#受控查询投影与使用分析)。

## 原生栈与启动

| 引擎 | 模板选定范围 |
|---|---|
| Meilisearch | community v1.55.0、MIT，keyword/index/tasks，不引入enterprise |
| Gorse | v0.5.11、Apache-2.0，native统计协同、neighbor/latest fallback；LLM/embedding/reranker配置空 |
| OpenPanel | 固定public2.x源，AGPL-3.0，SOURCE_BUILD/source-inputs定义完整构建；不以同名3.x替代 |

发行线tag不等immutable digest，目标pull须取实际RepoDigest并作为部署override。compose/gorse.toml/ClickHouse配置为非秘密源，runtime.env.example只列名字；各自独立key/password/卷，不借业务数据库或别人的Redis。默认主机loopback端口Meili17700、Gorse guard18088、OpenPanel18001，启动前核可用；native Gorse network internal且不发布原生API/dashboard，共享Docker网络允许所需loopback binding。

Gorse多candidate不支持ranker.type=none；模板采用单native协同候选及neighbor/latest。v0.5.11 Redis cache适配要求RediSearch，所以当前cache用独立Gorse PG、galaxy_cache_前缀与btree_gin，旧Redis卷仅legacy-cache profile保留；OpenPanel自己的普通Redis队列独立。原生Gorse AuthFilter可能把拒绝key写日志，guard以constant-time验证并在闭合路由转固定native key；不暴露原生端口、不向它发故意错误key。

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

bookmark/publication以原operationId作稳定eventId，并核原账户fresh session及准确版本/revision；按钮、未知写入、取消收藏、状态刷新不记成功。现有收藏collector不含单reply、私聊及其他kind。采集失败不改变业务已ack结果。新增page/event从真实动作扩展，不把当前六类固化为永久产品范围。

内容事件带精确kind/id/version并通过当前匿名reader；私聊、案件/举报/证据、通知、邮件正文及打开/点击/派生标签无此schema，不进入推荐。敏感页面若需基础usage须另设metadata-only page key。Meili只返回candidate ID/revision，Galaxy按当前source返回正文，不能用引擎旧snippet/totals；revision含公开curation。Gorse不合格item连feedback删除，IsHidden不等训练移除，返回前再核negative preference；cold-start/latest显式标其依据。

## HTTP与原生分析

[`Handler`](../../go/internal/discovery/http.go) 接网站 Origin、访问身份、当前账户和既有权限服务，提供以下入口：

| 路径 | 方法/解析 |
|---|---|
| /v1/discovery/config | GET无query，visitor cookie/CSRF |
| /v1/discovery/events | POST≤2048字节，精确website Origin、discovery CSRF，登录时另核账户ID/CSRF |
| /v1/discovery/search | GET q/topic/数字after/limit，匿名当前source |
| /v1/discovery/recommendations | GET mode/topic/limit，official或visitor身份 |
| /v1/operations/discovery/analytics | GET kind/days/scope/accountId，以analytics.read在native前后核验 |

拒未知/重复query及未知event字段，CORS只准所配Origin和准确headers，Bearer宿主凭据不作为analytics账户。overview/retention/paths/account用public2.x native Insights读client；business用相同client的GET /export/charts、ChartEngine、用途filter及reading/searching/bookmarking/participating四序列。计数是event occurrence，不是人数/session；取等长不重叠秒级[from,to)，不使用会把边界截成日期的event export totalCount。

原生overview的unique_visitors/total_sessions/total_screen_views、cohort近12周任意活动on_or_after、top-path子集的session transitions、profile lifetime是不同basis，DTO分别记录。原cohort含visitor:与account:混合，不称注册留存。Galaxy account-scope patch仅为cohort/user_flow增加scope=accounts与可选UUID accountId；对应Galaxy retention/paths使用，overview/business不受此scope，account kind仍要求ID。native headers必须确认准确scope/account，旧引擎忽略query则拒绝；无identify/alias或匿名回填。scoped cohort基于窗口首次合格活动，ClickHouse timezone没提供则未知，flow按account+session与native project timezone。匹配patch image启用后才开放scope，源码公开链接由固定source archive提供，不从旧版本推出支持。

AgentOS通过Galaxy受控工具，不能直接取native engine。searchSelected须服务端当前task选中的非空post/reply集合，模型不能改选集；候选过滤并重核，返回ID/version，再经固定read tool取正文；不产生新public endpoint/collector。

## 写入确认与定向探针

OpenPanel outbox先持久化submission_started再发送，unknown以稳定event ID经native reader核对，不因lease到期盲重发。ingestion ack与ClickHouse可见是不同观察。相关检查按[开发](development.md#故障定位与未验证范围)解释。

需要原生中文/write检查时，已授权部署者运行 `services/galaxy-discovery/native-probe.mjs`，输入保护文件或stdin `-`，shape为 `{meilisearch:{url,apiKey},gorse:{url,apiKey}}`，分别用operational master key/guard key。只创建一个galaxy_native_probe_UUID index和post_UUID item，不写真实内容/user/feedback、不调用OpenPanel；等Meili task、核中文match、读Gorse latest（warm-up空如实保留）。finally仅删原精确index/item并核完成/404；清理失败保ID/闭合码，不宽扫业务index。此命令不是日常健康检查。
