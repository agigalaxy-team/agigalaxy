<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/0a/0a2e0754e8e1e44fb59752a5b208ccbf2d3ae989d481389dd3fdbeafe262ee15.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 分类型来源搜索 v1

2026-09-10：C11-04 首期搜索实现。当前在本地及隔离数据库验证，动态 Official 服务未部署，实际宿主体验和真实用户相关性仍待复核。

## 调用与来源

`POST /v1/search/query` 接收 `{ "type": "proof", "query": { "query": "compiler", "conclusion": "failure", "limit": 8 } }`。客户端通过 `@galaxy/client/history` 的 `createSearchClient` 调用；原 `createHistoryClient` 保留。远程 MCP 增加只读工具 `galaxy_remote_search`。

| type | 当前读取范围 | 筛选 | 返回来源 |
|---|---|---|---|
| case | 当前可见 Case 的履历投影 | 既有履历条件 | Case ID、来源版本、投影规则 |
| history | 当前可见履历 | 既有履历条件 | 履历所对应的 Case ID、来源版本、投影规则 |
| proof | 当前可读的独立 Proof | 仓库、commit、run ID、CI 结论、scope 文本；主体及结论 | Proof、Evidence、Observation ID 和已发布的 CI 来源 |
| capsule | 当前可读 Capsule 版本摘要 | 标题/问题文本、Capability ID、作者 | Capsule ID、准确版本 ID、版本号 |
| worker | 当前公共 Worker 登记声明 | 公开名称/范围/配置/声明能力等文本；Owner ID | Builder ID、Owner、准确声明 ID/摘要、修订和发行版本 |
| hub | 当前公共 Hub 登记声明 | 公开名称/范围/operator/地区/endpoint等文本；Owner ID | Builder ID、Owner、准确声明 ID/摘要、修订和发行版本 |

Case 和 History 共用现有授权投影，响应保留不同 `type`；不会把 Case 事件原文增加到公共读取范围。Worker/Hub 元数据已复用建设者目录接入本入口与公开索引，仅搜索公共声明，登记不代表运行、可达或能力认证。细节见 [建设者来源搜索](builder-source-search-v1.md)。

响应包含 `type`、`items`、`nextCursor`、`checkedAt`、`windowLimited`、`pageCount`、`countsScope: visible-page-only`、`order: source-id`。每项包含来源、现有记录、匹配原因及局限。不同类型单独查询，不计算跨类型能力排名。

## 分页与当前状态

- 单页默认 8、最多 20；文本最多 200 字符。Case/History/Proof 文本最多 8 个不同词，Capsule 沿用完整子串规则。
- 客户端将 `nextCursor` 放入同一类型/条件的 `query.after`；游标按来源 UUID 排序，没有 OFFSET 扫描。
- Proof/Capsule 每次最多检查 200 个候选，再用第 201 个判断扫描上限；可见性在候选 LIMIT 之前过滤，每条返回前仍通过原服务完整读取。
- 多读一个匹配项判断下一页。没有下一条时返回 `null`，不把“刚好满页”冒充还有结果。
- 达到扫描上限时标记 `windowLimited`；可继续时提供最后一个当前可读来源游标。如果候选全部失效，返回空页且无游标，界面提示缩小条件；不声称完成了全库搜索。
- 总数仅描述当前可见页。HTTP 复用现有匿名/主体/凭据频率限制，另对带 `after` 的新旧搜索入口共用每主体/匿名地址每分钟 25 次的连续翻页额度，详见 [分页说明](search-pagination-v1.md)。
- Schema 32 加入可显式启用的公开候选索引；匿名结果仍逐条通过原服务读取。有会话的查询保持实时授权视图。失效、后台扫描和租约重试见 [公开索引说明](public-search-index-v1.md)。

## 原生入口

开发版 `/galaxy` 日常连接菜单第 4 项进入“分类型搜索”，只显示当前会话具备相应 scope 的类型。选择来源后填写条件、主动查询、查看来源详情、翻页；返回/取消会丢弃旧响应。Case/History 的“完整履历筛选与反馈”继续使用已有表单；四类结果详情均可填写主动反馈，搜索首页可查看本机汇总。离线查看、修改及数据格式见 [主动反馈 v2](search-feedback-v2.md)。

首次初始化冻结流程未修改。没有安装全局宿主配置、创建真实用户身份、认证远程服务或部署。这里的 HTTP 与本机签名验证使用隔离测试夹具。

## 证据范围

针对性自动化覆盖：四类实际 HTTP/便携客户端读取、相同 Case 的来源区分、私有 Case 下显式公开 Proof、准确 Capsule 版本、末页、私有条目不改变匿名结果、按来源 scope 拒绝、撤销联动、取消/迟到响应、原生编号入口及真实 MCP 客户端。

真实 PostgreSQL `history` 场景复用受限 API/Worker 角色运行同一分类型工作流；离线 npm 安装实际导入搜索客户端，并验证无会话时不产生网络请求。实际运行结果、源文件摘要和客户端包摘要登记在项目 `GALAXY_TYPED_SOURCE_SEARCH_PROGRESS_2026-09-10.json`，该记录生成前不作为检查已通过的声明。
