<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/a2/a20646726f9c7444ef4ab833920f875b2a9090388342fc766cfe2e2b8192359e.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Node 任务证据关联 v1

2026-09-10。C15-03 的节点证据部分已实现；实际端点可达性仍待开发，动态服务未部署。

建设者目录现在分别显示登记、Node 对准确声明的授权、兼容报告、所有者心跳、所有者 CI 证明引用及 Node 签署的任务证据关联。`node-attested-ci-evidence` 表示节点持钥者确认了来源关联；CI 事实来自现有 Proof 验证链。节点是否实际执行任务以及任务能力仍未获得独立认证。

## 使用流程

在日常建设者菜单打开 Worker 登记。Node 身份先批准该所有者及准确声明，然后选择“以Node身份关联任务证据”，填写 Case、Attempt、Result、当前 CI Proof ID 和参与说明。客户端沿用本机签名与准确内容预览；已有持久待办支持重启后的回执对账和原事件重试。

可选 A2A 端点及任务 ID 只作为节点提供的引用保存，二者必须同时填写。该操作不读取端点，不验证 A2A 来源，也不将此引用当作端点控制权或执行归属证据。

“节点关联的任务证据”提供准确来源和局限；Node 或登记所有者可单独撤销某次关联。撤销事件持久有效，撤销其 Consent 不会使旧关联重新生效。首次 `/galaxy` 初始化流程不变。

## 服务与存储

- 复用 `builder.publish` 的准确签名 Consent、`/v1/builders/events`、登记读取/目录查询、授权视图导出及本机待办。没有增加一套任务数据库。
- Migration 34 仅扩展 `builder_events.kind`：`work-evidence` 与 `work-evidence-revoke`。当前共 41 张表，30 类本人导出数据集。
- 关联绑定声明 ID/原始字节摘要、Node 授权事件 ID、Node ID，以及准确 Case/Attempt/Result 和 1–8 个 Proof。
- 服务核对 Case 原始事件及当前授权、Result 对 Attempt 的引用、Proof 对准确 Case/Result 的引用和现有 CI 验证状态。公开关联要求所有来源当前可公开读取；私有关联沿用声明的接收范围，读取时仍逐条检查来源授权。
- 新关联取代相同声明、Node 授权、Case、Attempt、Result 下的旧关联。新关联撤销或变为不可读时，不回退旧记录。

## 返回状态

`evidence.items` 保留已有所有者 Proof 引用；`evidence.nodeWorkEvidence` 新增 Node 关联及其当前数量。数量是关联记录数，不是独立 Evidence 数或任务成功数。

| 状态 | 含义 |
|---|---|
| `current` | 关联授权、声明、Node 授权及全部来源当前有效且对读者可见 |
| `superseded` | 相同来源组合已有更新关联 |
| `revoked` | Node 或登记所有者已撤销 |
| `stale-declaration` | 原声明已被替换 |
| `node-authorization-unavailable` | Node 授权被替换、撤销、过期或不可用 |
| `source-unavailable` | 至少一个原始来源或 Proof 已失效/不可见 |

关联本身不可见时不返回该行；其他非当前状态只返回关联标识及状态，不复制 Case/Attempt/Result/Proof ID、说明或 A2A 引用。当前来源中的结果仍标注 `case-owner-reported`；`executionAttributionVerified`、`capabilityVerified` 均保持 false。

## AI-agent 开发与部署接续

复用现有 Official 配置及数据库角色。先按项目发行流程迁移至 Schema 34，再使用现有建设者接口；不需要新增凭据、端点白名单或后台探测配置。迁移保留历史声明、授权及事件，不自动降级删除记录。

只启用已接通的接口。当前 `automaticEndpointProbes:false`，A2A 引用不会被抓取；不要从心跳、Node 授权或任务关联推断可达性。后续 C15-03 需补真实端点观测及时间/失败状态，并保留现有可见性、额度和恢复语义。

直接相关验证入口：`test/builder-work-evidence.test.mjs`（API/客户端、真实签名和受控 CI 来源流程）、`test/builder-menu.test.mjs`（原生菜单）、`test/postgres/search.test.mjs`（真实 PostgreSQL 的受限 API/Worker 角色）。案例来源是受控测试数据，实际建设者、真实来源和人工宿主验收仍保留。
