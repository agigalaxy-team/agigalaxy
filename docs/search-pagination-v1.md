<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/42/425cc67af34053d0f06a479832e152fbacc678027b84245382f37ec9724c7d87.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 搜索分页与连续翻页额度 v1

2026-09-10，C11-05。兼容原有 UUID keyset 游标；没有引入新的搜索引擎或游标协议。

## 已实现的边界

- 分类型搜索四类请求统一默认 8 条、最多 20 条。旧 `/v1/history/query` 保留默认 20、最多 50，避免改变旧客户端协议。文本不超过 200 字符，履历和 Proof 的词数不超过 8；不接受 OFFSET、批量 ID 或任意查询字段。
- Case/History 先过滤权限和基础条件。带派生条件时最多扫描 200 个可见候选；Proof/Capsule 同样采用 200 个候选的扫描窗口，逐项经原服务复核后返回。分页仅给当前可读来源的游标与当前页计数。
- Capsule 复用记录也在 LIMIT 前过滤自身和目标版本的可见授权、来源 Case 有效性；只有成功读取的记录能形成下一页游标。多取一条判断是否还有结果，最后一页不因刚好满页而提供额外游标。
- HTTP 同一主体每 60 秒最多执行 25 次带 `after` 的搜索请求，所有查询条件、来源类型、新旧履历/Capsule 查询接口共用额度，换凭据不重置。匿名请求按现有可信代理规则解析的客户端地址计数，具备会话的不同主体不因共享 IP 共用该翻页额度。
- 达到额度时返回 HTTP 429、`Retry-After: 60` 和 `X-Galaxy-Quota-Category: search-pagination`。额度在查询执行前扣取。首次查询与撤销不占用翻页额度，仍受已有普通请求限流约束；界面保留条件并提示重试时间。
- 复用现有有界 `fixedWindowLimiter`，最多记录 10,000 个主体/地址条目；容量满返回 503，过期条目清理。`createApi` 的 `searchPageLimit` 参数可配置额度，服务默认 25。

这是连续翻页速率限制，不是查询结果终身只能读 25 页。限制每次候选规模、使用 keyset 避免 OFFSET 深度成本，并限制单位时间内的连续读取；用户稍后可继续。计数为单 API 进程，重启重置，多副本全局预算需要部署阶段的共享限流或入口控制，不能把当前实现宣称为多实例全局配额。

## 验证

`test/search-pagination.test.mjs` 通过真实 HTTP 验证跨入口共用计数、主体隔离、凭据轮换、任意游标不重置额度、匿名计数、到期恢复及撤销保持可用。`test/capsule-workflow.mjs` 验证复用记录的授权和末页。

真实 PostgreSQL 针对性入口：设置 `GALAXY_TEST_PG_BIN` 与 `GALAXY_TEST_PG_CASE=search` 后运行 `node packages/galaxy-official/scripts/test-postgres.mjs`。它使用隔离集群、受限 API/Worker 角色，运行 Capsule 复用和四类来源搜索工作流。实际结果见项目 `GALAXY_SEARCH_PAGINATION_PROGRESS_2026-09-10.json`。

不新增数据库表、物理搜索索引、后台重建任务或远程部署。真实来源和用户相关性、实际宿主体验及发布阶段验收继续保留。
