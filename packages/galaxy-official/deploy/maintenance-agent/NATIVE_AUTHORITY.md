# Garage / Grafana 当前原生安全态保留

本文件描述恢复 A 的候选增量，不是生产启用记录。生产仍 `enabled:false`；没有实际恢复、删除、修改账号/权限、创建 key、重启原生组件或开始备份。主会话当前发行、模型故障修复与 stable snapshot 均未改动。

## 原生复用

Garage 固定 2.4.1 的 [API 类型](https://docs.rs/garage_api_admin/2.4.1/src/garage_api_admin/api.rs.html)、[key handler](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.4.1/src/api/admin/key.rs) 和实际二进制 help 均已核对。普通 `key import` 需要 secret argv，本候选不采用。实际 `garage json-api <endpoint> -` 支持从 stdin 读取 JSON，经当前 RPC 配置调用，既不新增 admin HTTP listener，也不创建管理 token。固定 API 的 Allow 只添加 true 权限；撤权必须使用 Deny。

Grafana 固定 OSS 13.2.4 的 [用户](https://github.com/grafana/grafana/blob/v13.2.4/pkg/services/sqlstore/migrations/user_mig.go)、[OAuth](https://github.com/grafana/grafana/blob/v13.2.4/pkg/services/sqlstore/migrations/user_auth_mig.go)、[API key](https://github.com/grafana/grafana/blob/v13.2.4/pkg/services/sqlstore/migrations/apikey_mig.go)、[RBAC](https://github.com/grafana/grafana/blob/v13.2.4/pkg/services/sqlstore/migrations/accesscontrol/migrations.go)、[面板 ACL](https://github.com/grafana/grafana/blob/v13.2.4/pkg/services/sqlstore/migrations/dashboard_acl.go) 和 [加密 key](https://github.com/grafana/grafana/blob/v13.2.4/pkg/services/sqlstore/migrations/secrets_mig.go) 原生表已核对，并以当前实际 SQLite PRAGMA 取得结构元数据。没有复制用户行或秘密到测试夹具。HTTP 管理 API不提供密码 hash/完整 secret 导出，因此只在精确私有副本内使用原生 SQLite 事务合并，不另建身份库或修改上游服务。

## 固定执行链

1. 方案检查读取当前 native 前提。执行时当前授权再核，公共业务入口受控；相关业务 writer 先停。Garage/Meili 仅为当前权限捕获暂保留原生 RPC/HTTP，捕获完成后在准备阶段停下，再处理数据卷。
2. 当前原生安全态进入既有 root 私有、0600、操作绑定的 engine contribution。Garage secret 只经内存/标准输入；Grafana 密码、OAuth、签名及加密 key 不进入 DTO、argv、运行日志或源码包。
3. Grafana 在激活前的精确 candidate `grafana.db` 中合并当前身份与授权，要求临时 operation guard、同一镜像和一致 schema/migration。业务面板与 unified 业务内容保持所选点；当前面板 ACL 用 org+UID 映射点内 ID，不按位置或标题猜测。
4. Garage 在受控切换后通过原生 RPC 撤掉点内旧桶权限和别名、失效点内旧 key/管理 token，再设置当前 key、有效期、createBucket 与精确桶权限/别名。当前 secret 不能修改到另一个旧 ID；当前缺失的桶不凭别名补造。网站公开访问属于授权一部分，按当前保留；点内 CORS/生命周期值按原值传回，未设新清理或保留政策。
5. 最终开放前再次核对 native 当前权限、key、绑定与旧会话失效。未知或冲突保持隔离；没有自动换 key、扩大权限、延长期限、重放不明原生效果或开放的后备路径。

## 当前保留内容

- Garage：完整已列举 S3 key/secret、过期时间、createBucket、桶 read/write/owner、global/local alias 及当前网站可读资格。配置型 admin/RPC key 仍取当前受保护文件。原生列表到达 10,000 上限不冒称完整。
- Grafana：当前 org/user、password/salt/rands、is_disabled/is_admin、服务账号、OAuth、team/member、role/permission/builtin/user/team assignment、撤销状态、原生加密/签名 key 与 secret 表；旧 session/token/external-session/cache 全部失效。
- Grafana 当前 data source、plugin/alert 连接与 secret 必须整行保持绑定，不能把当前 key 送往旧目标。当前受保护文件也不随点覆盖。原生 13.2.4 的 472:472/0400 secret 文件允许保留，前提是匹配当前精确只读 `/run/secrets` 挂载；未改变现场 ACL。元数据/内容绑定会在合并前及最终再核。
- 点内旧账号不会因恢复回到可登录状态，点内旧 role/key/分享 token 不作为当前授权。已发外部效果的独立账本仍按既有 P19 当前事实贡献处理。

## 继续准确拒绝的条件

| 条件 | 闭合拒绝 |
| --- | --- |
| 当前存在持久 Garage admin token，原生 API 无 secret 导出/导入 | `maintenance_garage_current_admin_token_not_exportable` |
| 当前桶不在所选点中 | `maintenance_garage_current_bucket_missing_from_point` |
| 已存在的相同 key ID 对应不同 secret | `maintenance_garage_existing_secret_conflict` |
| Garage 版本不符、列表触顶、native 导入 tombstone/操作结果不可确认 | `maintenance_garage_version_not_supported` / `maintenance_garage_inventory_incomplete` / `maintenance_garage_native_operation_failed`；不制造新身份替代 |
| 当前 Garage 网站含未支持 routing rule | `maintenance_garage_website_authority_unsupported` |
| Grafana unified resource 不在明确支持的 dashboard/folder/advisor 类型内 | `maintenance_grafana_unified_authority_not_supported` |
| Grafana 存在本批未支持的外部 snapshot/cloud-migration capability | `maintenance_grafana_external_capability_not_supported` |
| Grafana 出现未知安全表/控制 namespace，或点与当前 schema/migration 不同 | 对应 `maintenance_grafana_*_not_supported` / `maintenance_grafana_schema_changed` |
| 当前 Grafana ACL 的原生对象 ID 无法取得稳定 UID | `maintenance_grafana_current_acl_target_unknown`，不静默丢弃或把 grant 移到另一对象 |
| Grafana 当前 key 所有者、只读挂载、内容或版本绑定变化 | `maintenance_grafana_current_key_binding_required` / `maintenance_grafana_current_key_binding_changed` |

这些具体条件不能靠当前实例恰好为空而删除。后续 v4 已加入 Prosody 离线当前账号/房间权限合并与精确 MAM 删除回执，见 [Prosody 当前贡献](./PROSODY_CURRENT_STATE.md)；v5 在线 component probe 与 Garage 附件精确贡献已落候选源，中央实际接线仍待主会话合入，见 [在线/对象贡献](./LIVE_CONTRIBUTIONS.md)。完整生产恢复仍未执行。以下三叶和读取结果仍保持本 r3 当时的实际范围。

## 本轮检查

新 `maintenance-native-authority.test.mjs` 的三个唯一行为叶首轮通过：Garage 原生 RPC 写语义明确使用 double；Grafana 使用真实 `node:sqlite` 和实际 native PRAGMA 结构的合成行；私有 contribution 与接线用临时文件。现场 adapter 只读接续先确认 Garage 可读，Grafana 首读因 root-only 假设拒绝；按实际只读 472:472/0400 挂载修正后，仅补第三叶和 Grafana 读取，均通过。随后补齐“当前 ACL 无法取得稳定 UID 必须拒绝”的明确分支，仅补第二叶通过。总计仍是三个唯一叶，Garage 第一叶及 r2 原九叶未重复执行。

现场最终只读结果为 Garage 1 key/1 bucket、无持久 admin token，Grafana 2 user/129 role/772 permission；这些是读取时点的数量，不是恢复效果或已验证原生账号写入。实际敏感行仅在服务器受保护进程内，未保存到检查目录或报告。逐项结果位于本轮 `p19-maintenance/backend/NATIVE_AUTHORITY_VALIDATION.md`。
