# 静态支持的可用性发现

所有位置固定于 `aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2`。以下为静态源代码证据，不是已执行的请求或测试。未提供可运行攻击载荷、压测方法或生产探测步骤。完整防护和不确定性是结论的一部分。

## A03 搜索引用重复重建可见语料

**优先次序 1，暂定中等可用性风险。** 独立静态复核支持，但线上语料规模、容量、延迟和停服均未验证。

**输入与权限。** 正常服务状态下，匿名请求可进入 `POST /v2/search/reference`；提供无效 Authorization 则失败。调用者选择合法 history/case 查询和引用 id/version；引用可不匹配现有可见记录，不要求先获取服务端签发引用。JSON 32 KiB、严格字段、ID 长度和版本格式校验仍有效。

**边界与工作。** Reference 内部逐页调用 Query；每次先扫描、授权、投影、过滤、排序并指纹化完整可见集合，再处理游标与切片。因此一个小请求能多次重建相同集合。设当前稳定选中记录数为 N，页大小 L，一次重建成本 R，完整缺失引用查找约需 `max(1,ceil(N/L)) × R`。这不是无限循环；稳定游标前进、重复游标防护、匹配即停止、变更或错误可终止。L=1 时支持至少二次量级的记录处理，不是精确运行时间或峰值内存断言。

**重要配额纠正。** 直达入口即使省略 after，也由生产适配器传入非空指针，实际扣 **一次**默认 `25/60s/IP` 搜索分页额度，并受 submission 外层默认 `300/60s/IP` 限制。问题是内部页未逐页计费，不能写成“完全绕过分页配额”。

**information 调用。** 匿名 `POST /v2/information/query` 接受 1 至 8 个不同 key 的选择，reference 形状复用同一 Search.Reference。相同来源可用不同 key 重复选择；正常顺序执行，不是并发或递归无限扩张。该包装器未在嵌套 `search.query` 检出分页字段，全 reference 选择不扣搜索分页额度，但仍扣独立默认 **`60/60s/IP` anonymous 外层额度**。完整成功工作最多在上述公式上乘选择数 k（1 至 8）。非 400 来源错误可被转成 unavailable 并继续下一项；取消上下文仍向后续 DB 调用传递，不能说取消后仍必然完成遍历。

**防护与影响边界。** 只处理当前可见记录，私有数据泄露未成立。小语料、早命中、来源变更、SQL 错误、取消均限制或终止工作。每语句 10 秒超时不等于整个请求 10 秒上限。外部代理、连接池和部署配额未知。潜在影响为共享 API/DB 重复工作和竞争，未实测。

**证据位置。** `go/internal/searchv2/service.go:302–340`，blob `d16ec69473dd8da89f89df3619fabc08ce280149`；`go/internal/historyv2/service.go:99–200,239–248`，blob `203ce7ce5ce6258bb2cdb24c5a79ccb3cbeb5438`。计费链：`searchv2/http.go:93–99` → `cmd/galaxy-api/fact-sources.go:46–52` → `httpboundary/quota.go:217–234,290–294`，blob `20d094bed5ddb5458c0bba6115260966b5c425de`；外层默认配置 `httpboundary/config.go:39–40`，blob `646b273e2bf71d4d63f3de3d84151f610d1d560a`。聚合：`information/http.go:30–37,58–109`，blob `4c8b2f25e28fe549ecdabbf9dea758dd6f6660fb`；`information/input.go:177–251`，blob `01685b32922388a462dd1a66b7004fa1e39bc67f`；`information/service.go:87–92,125–149,184–200`，blob `24b443cf1082aeabebe7b666d4876cffdb3b87fa`。独立复核依据为此次 independent-search/REPORT.md，包含语料前提及计费纠正。

## A02 Capsule 预览重复遍历共享来源图

**优先次序 2，暂定中等可用性风险。** 独立静态反证后仍成立；没有测得耗时、连接池耗尽或崩溃。

**输入与权限。** 普通有效设备主体可在自己的 standalone case 通过 `POST /v2/cases/events` 提交合法来源引用，再通过 `POST /v2/capsules/preview` 读取。需 case-teaser、capsules 范围、当前设备控制与精确签名同意。引用须指向有效可见的已有事实；不需要越权、不需要公开发布 Capsule。

**边界与工作。** 写入授权遍历保留 visited 集合，而预览来源遍历的 visited 仅在当前递归路径有效，返回后删除；不同分支共享的子图会反复加载 case 及当前授权。返回后的 dependenciesUnique 不能消除已经发生的工作。有限 DAG（有向无环图）在紧凑存储下仍可产生指数级路径展开；不提供构造载荷，也不宣称无限工作。结果投影携带来源 intervention 的 recordEventIds，是已核对的间接来源链，不是臆测递归 result.origin。

**防护与影响边界。** case 最多 1000 事件、每事件最多 24,000 字节、引用最多 32、HTTP 32 KiB；默认主体存储预算 1 MiB。预览为读操作，这些存储限额不等于遍历工作预算。默认每 60 秒 submission IP/主体/凭据限额 300/60/30；请求取消、SQL 错误、来源权限变化会中止，SQL 单语句超时 10 秒。部署总时限和并发限制未知。不能据此称为匿名存储型攻击、越权或线上停服。

**证据位置。** `go/internal/cases/fact_input.go:17–28,61–68,133–151`，blob `7c2d29b603bec2319f26b629fbe8aa5421aa5360`；`cases/fact_write.go:63–144,206–261`，blob `579d745305ace987cfc7efb38745897627b14e09`；`cases/facts.go:156–170`，blob `ddaee10e1bc0718eb51253651e24500985900176`；`cases/authority.go:67–74`，blob `677cb4f9d809f06a97be2ad801b55c9d2069877a`；`capsules/read.go:328–335`，blob `53be82e6747a38e2ce1a40cc23f9ce19a4286dd8`；`capsules/permissions.go:193–240`，blob `45925fb6090c48b362f2e7c5e458510b87d2b10e`；`capsules/sources.go:72–81,125–180`，blob `d2184f6fb762e9c74a4b27dac92a299643c139e5`。此次 server/CAPSULE-DAG-CANDIDATE.md 与 independent-resource/REPORT.md 分别记录原链及独立复核。

## A01 官方账户归档遗漏累计存储预算

**优先次序 3，暂定中等可用性风险。** 服务端路径与 auth 外层防护已交叉核对，未验证真实容量耗尽。

**输入与权限。** 普通官方账户使用自身合法 Cookie、Origin、CSRF 和当前账户权限，访问 `POST /v1/account/archives/create` 与 `/chunk`。可选择自己的新归档 UUID、合法选择元数据及块内容，不要求管理员或受害者标识。这里不是无限请求速率。

**边界与存储。** 官方 actor 的 origin 为 nil；ResourceWrite 仅用于非官方 actor。单次 create/chunk 属于增长操作，但官方归档不进入现有 subject 累计核算，且核算 SQL 仅选择 `origin_subject_id=$1`。每个归档受限，不代表一个账户全部归档之和受限。初始保留设置可为空，清理只处理显式到期项，未完成上传也无必然短期回收保证。已保存的定向 schema 核对没有发现账户总量或数量约束，不等于全部迁移语义已审完。

**防护与影响边界。** 当前账户重复鉴权、自有归档校验、行锁、重复块幂等、每块 262,144 字节及每归档 67,108,864 字节限制均存在。默认每 60 秒 submission IP/账户/凭据限额为 300/60/30，可配置。它们限制速率或单项大小，不能构成持久账户总量上限。风险为逐步增加 PostgreSQL 内容、WAL、备份与 IO 压力；账户准入、磁盘、压缩、监控及外部预算未知，耗尽时间未测。

**证据位置。** `go/internal/accountarchive/portal_http.go:76–142`，blob `323263582d50deb5ccd16336b36806c0bb729688`；`accountarchive/service.go:64–68,70–131`（尤其 124），blob `52c9e48a742416c0445be28129be8f7dc8ac6ec5`；`accountarchive/archives.go:120–121,162–228`，blob `866b2e1bae2b40d9ec1017a282481d01e59b180c`；`resourcebudget/sql.go:4`，blob `22f5a2e00226925b49c6ef66dd11bc932d669981`。保留依据为 `databaseschema/sql/85.sql:8,17–29`、`accounts/profile.go:71`、`accountarchive/retention.go:14–22`。此次 server/ARCHIVE-QUOTA-CANDIDATE.md 与 auth/attack-notes.md 记录完整边界及归属。

## 已保存的固定来源链接

以下 URL 原样来自此次独立审阅的 SOURCES.json；未编造行号链接、未重新抓取线上内容。其他精确位置以上文路径、基线和 blob 标识。

- [go/internal/searchv2/http.go](https://github.com/agigalaxy-team/agigalaxy/blob/aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2/go/internal/searchv2/http.go) — blob `cc67e87f401e032b4956f590ac62aa60f728b2fc`。
- [go/internal/historyv2/service.go](https://github.com/agigalaxy-team/agigalaxy/blob/aa9dbc6eae25dc06bb0a9fde7bab99b842f3cbd2/go/internal/historyv2/service.go) — blob `203ce7ce5ce6258bb2cdb24c5a79ccb3cbeb5438`。

术语：subject是设备授权主体，不等同于官方账户；case是案例对象，不是测试用例；submission/anonymous是提交类/匿名类请求配额；CSRF是跨站请求伪造防护；WAL是数据库预写日志；blob是Git文件内容标识。
