<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/52/52245f5eae57ec3e1e2cff273735ec0d9df3d5431f80747df50e7d4ca955b2e7.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Worker / Hub 公共元数据搜索 v1

2026-09-10：补齐 C11-04 的 Worker/Hub 后续扩展。复用建设者登记、当前来源读取与 PostgreSQL 公开索引；没有连接或探测登记端点，动态 Official 服务未部署。

## 接口与来源

```json
{"type":"worker","query":{"query":"compiler coding","limit":8}}
```

`POST /v1/search/query` 新增 `worker` 和 `hub`；查询字段为 `query`、`ownerId`、`after`、`limit`。关键词最多 200 字符、8 个词，默认每页 8、最多 20。使用已有 UUID 游标、连续翻页额度和来源 ID 排序。

| 来源 | 可匹配的公开声明字段 | 版本引用 |
|---|---|---|
| worker | 名称、范围、发行版本、配置摘要、模型系列、工具、任务类型、声明能力与局限 | Builder ID、Owner ID、Declaration ID/Hash、当前修订、发行版本 |
| hub | 名称、范围、发行版本、operator、地区、声明 endpoint、Manifest specVersion | 同上 |

本入口仅检索公共元数据，包括登记所有者登录后查询自己的记录。已有建设者目录仍支持按授权读取私有登记，Bridge 继续使用目录接口。可公开声明由当前准确版本及 Public/public-profile 授权决定；不回退到已被替换的旧公开声明。

结果保留 `worker`/`hub` 来源、匹配字段说明和有限目录状态：登记、Node 批准、兼容报告、Owner 心跳、Owner 的 CI 证据状态及维护提示。这些状态不推导端点可达、实际 Worker 执行或能力认证。

## 查询、索引与维护

建设者候选在限制扫描规模之前过滤当前声明授权，读取后再次按来源检查。私有登记不能产生匿名游标或挤占公共候选；扫描最多 200 条可见候选，使用额外一条判断分页结束。有未扫描候选时保留 `windowLimited`，不宣称全库无匹配。

Schema33 扩展既有 `search_documents` 的来源类型，新增 Builder 变更触发器，并扩展既有扫描、队列和受限锁函数。没有新增数据表：仍为 41 表、30 个本人云端导出集。

- 已有数据库升级后重置扫描游标，纳入此前登记；关闭的索引继续关闭。
- 新登记、声明替换、维护变化及时删除旧候选并排队重建；声明 Consent 或 Binding 撤销沿既有依赖失效。
- Worker 只读登记与事件，复用已有索引任务租约、续跑、重试及最长 60 秒候选有效期。
- 索引不提供授权或状态事实；API 重新读取当前声明与目录状态，下架和私有替换不返回旧结果。
- 既有本人删除流程按 owner 清理这两类派生文档及索引作业，不另建保留副本。

## 客户端与原生入口

便携 `createSearchClient`、`galaxy_remote_search` 和 `/galaxy` 日常分类型搜索统一支持六种来源。Worker/Hub 的认证查询使用 `builders` scope；只具有 `history` scope 不能读取它们的认证入口。匿名 HTTP 仍只读公共目录元数据。

原生入口新增 Worker/Hub 与登记 Owner ID 筛选；主动反馈保留准确 Declaration ID，并纳入本机按来源汇总、修改和移除。无需增加远程反馈 API；首次初始化冻结流程保持原样。

## 验证与 AI Agent 部署说明

检查覆盖实际 HTTP/便携客户端、MCP 输入、原生来源选择、主动反馈、授权前分页、私有替换、下架恢复、维护变化、Consent/Binding 撤销和当前来源重读。真实 PostgreSQL 使用受限 API/Worker 角色复用工作流；结果记录在项目 `GALAXY_BUILDER_SOURCE_SEARCH_PROGRESS_2026-09-10.json`。

部署时先执行追加迁移 33，再应用现有 Worker 角色配置，使其获得 `builders` 和 `builder_events` 的 SELECT 及既有受限锁函数执行权。索引启用仍由显式 Worker 配置控制。不要访问声明中的 endpoint、policy 或 artifact URL 来“补齐”可达性；这些链接在本功能中仅为声明字段。

回退可关闭统一搜索的新增入口及索引处理，保留原始登记和迁移。旧应用的 Schema 校验会拒绝未知版本，因此不能直接把 Schema32 程序指向已迁移的数据库；按现有应用回退/备份恢复流程处理。真实第三方端点、用户相关性、实际宿主体验和公开部署仍按原阶段验收。
