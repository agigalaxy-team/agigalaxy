# P19 恢复 A 原生适配候选

本地整合说明（2026-10-26）：本目录保留完整生产适配器候选及隔离测试，当前 `configuration.mjs` 仍只接受 `production.enabled: false`；普通服务配置不能启用真实恢复。下文安装与生产适配描述是方案和前置合同，不表示本候选已执行整站恢复、已覆盖 schema131 的全部新自主任务状态，或已获准启用。具体恢复仍由人工批准一次方案后另行接入及验收。

## 当前交付状态

本文件对应后续候选 `galaxy-current-authority-host-restore-v5`。初次维护 Agent、受控读取、统一备份与具体恢复方案已另行部署；本候选尚未加入该生产发行。`production.enabled` 保持 `false`。没有执行真实恢复、对象删除、原生索引改写、Caddy 切换或新备份。r2/r3/r4 记录和源码包保持原件；Garage/Grafana 见 [NATIVE_AUTHORITY.md](./NATIVE_AUTHORITY.md)，Prosody 离线贡献见 [PROSODY_CURRENT_STATE.md](./PROSODY_CURRENT_STATE.md)，新增在线 probe 与精确对象贡献见 [LIVE_CONTRIBUTIONS.md](./LIVE_CONTRIBUTIONS.md)。

用户批准的恢复含义是：业务内容、文件和各引擎按所选点恢复；账号、密码、当前权限与密钥保留当前。一次人工批准绑定具体点、范围、损失窗口、方案版本与全部开放条件。布局选择不是恢复批准。失败或 ACK 不明不自动回滚、重新执行或开放。

## 固定代码及边界

| 源模块 | 实现与边界 |
| --- | --- |
| `production-restore.mjs`、`restore-executor.mjs` | 固定 `contain → capture-current-facts → prepare → restore → reconcile → validate → activate → validate → open`。隔离准备只产生 staged 证明；切换后才允许最终就绪证明与一次开放。每阶段当前授权，不信浏览器或模型传入的步骤、路径、命令。 |
| `current-facts.mjs`、`../../src/operations/maintenance-recovery-facts.mjs` | 私有捕获并向精确 quarantine 合并当前控制身份、业务角色、当前读权/撤回/期限、独立消息限制、当前模型版本与凭据引用、当前 SMTP 配置及外部投递账本。需要相同 schema 版本；不从恢复正文倒推当前授权。 |
| `host-database.mjs` | 业务和已记录 Agno 数据库的隔离准备与名称切换；当前 accounts/Keycloak 集群不回滚。不导入旧 PostgreSQL 角色密码；保留当前数据库 ACL。旧会话失效，旧外发任务取消，Agno 待执行 ticket 取消；旧效果不自动重演。 |
| `host-files.mjs`、`website-pointer.mjs` | 仅处理已批准清单内的精确 owner/path/source binding。保留当前 `/etc/galaxy`、`/var/lib/galaxy/config`、当前控制 release 和 Keycloak 卷。旧目录与旧网站指针保留，不自动清理。 |
| `engine-security.mjs`、`garage-security.mjs`、`grafana-security.mjs` | 在私有副本向 OpenPanel/Grafana 合并当前原生身份与授权，使旧会话失效；Meili/Garage 重放完整当前 key/权限。Garage 通过原生 RPC JSON stdin，Grafana 通过原生 SQLite；秘密只进私有贡献，不进入 DTO/日志。独立前提、具体拒绝条件和实际检查范围见原生安全贡献说明。 |
| `model-preservation.mjs`、`protected-configuration.mjs` | 当前 PG 模型生效版本、连接/场景绑定、credential refs 必须和当前受保护文件及两个原生引擎回读一致。只保留 raw key 不足以证明旧启用状态未复活；当前未配置也不能代替未来非空检查。没有模型调用或配置应用。 |
| `discovery-reconciliation.mjs` | 使用精确私有业务副本与原匿名公开 reader 核对所配置 Meili/Gorse 全量条目，移除无 canonical 来源的幽灵条目或当前已失效内容，阻止旧排队索引任务回写。保留独立账户/访客使用历史；没有新增画像用途、全库任意清理或物理擦除保证。 |
| `caddy-control.mjs`、`public-gate.mjs` | 复用实际 `admin off` Caddy 服务、固定 runtime JSON 与单一 runtime drop-in；不新增管理端口。保留当前 IAM/控制入口，其他业务暂时 503。原文件或当前启动来源变化即拒绝开放。 |
| `native-health.mjs` | 当前 API `/readyz`、原生读检查、当前 IAM、模型版本与受控 public probe 分别核对。Prosody `status` 只证明进程，未冒充数据/组件就绪。 |
| `prosody-current-state.mjs`、`prosody-storage.lua` | 同一13.0.6原生 internal driver 在无网络私有副本合并当前账号/角色、房间权限和删除标记。已验签且已执行身份删除、当前撤回/到期消息精确回读 native key 后，原 ChatService 消费回执；PG处理在 dump 之前。旧 occupant 清除；缺少同连接 probe 时仍在 containment 前拒绝。 |
| `prosody-live-client.mjs`、原 `ProsodyChatTransport.probe()` | 固定 XEP-0030 rooms 服务级 `disco#info`，核 `conference/text` 与 MUC feature，不查询 items/room/消息；使用原 API 已认证流，不新建 component。签名 loopback callback 仍仅核五个字段，不冒称 MAM/材料权限已核。中央 route 与 runtime 注入由主会话串行接。 |
| `object-deletion.mjs` | 原签名已执行 all-owned 范围，current/point/canonical 指针相交；未知 native key/独立引用/活跃 lease 拒绝。当前 Garage key/ACL 合并后，应用 writer 恢复前逐键 HEAD/Delete/HEAD，仅正 absence 回执更新最小源记录；无宽扫或新 TTL。 |

P13/112 若存在，恢复合并会把策略 heads 暂停，非 `completed`/`no-action` runs 置为 `blocked`，并保留当前 103/105 权限检查。旧 schema 两表都不存在时不补造 112；一表缺失则拒绝。新增窄叶覆盖这一分支，没有因它重跑原核心组。

## 当前强制拒绝的范围

| 范围 / 闭合码 | 具体事实与尚缺贡献 |
| --- | --- |
| Garage 特定点或当前状态 | 不再按整个 objects 模块静态阻断。v2.4.1 原生 `json-api … -` 支持秘密经 stdin；已接 key/ACL/别名/有效期的当前贡献。当前存在不能导出 secret 的持久管理 token、所选点缺少当前桶、同 ID secret 冲突或原生 tombstone 无法导入等情况仍具体拒绝，不新建替代 key 或桶。 |
| Grafana 特定点或当前状态 | 不再按整个 configuration 模块静态阻断。原生 SQLite 用户/OAuth/服务账号/key/角色/ACL、加密与签名 key、绑定连接均按当前合并。未知 unified security 资源、未支持的外部 snapshot/迁移 capability、schema/migration 不同或当前 key/mount 绑定变化仍具体拒绝。 |
| `chat` / `maintenance_current_chat_native_readiness_not_proven` | 正确 status 仍仅进程证据。同连接固定 probe 源已完成；中央 private route/注入未部署时仍阻断，不能另登录同一 component 或开启管理端口代替。 |
| 私聊范围未包含其业务数据库 / `maintenance_prosody_current_database_scope_required` | 当前身份/房间权限和消息状态必须使用同一已恢复且合并当前权威的数据库；不在只恢复 native 卷时宣称已共同完成。 |
| objects / 具体对象贡献无法证明 | 不再按“存在执行删除”静态拒绝。v5 已接精确执行器，仍要求同批 business 作为可核当前源；未知 native owner/key、独立引用冲突、来源变化、SSE key 不可用、处理占用或 Delete 结果未确认等继续闭合阻断。Prosody 回执不替代该对象贡献。 |

私聊已知缺口与当前 native metadata 前提在 `contain` 之前核对；只能在私有点副本确定的 schema、映射或原生导入条件在对应阶段拒绝，失败后保持隔离。完整整站范围包含仍未接齐的私聊模块，当前不可执行；即使误设启用，也不能绕过这些贡献。能力不可从进程健康、旧快照存在、单一 env key 或测试替身推导为可用。

原有 `../../src/operations/deletion-ledger.mjs`、`deletion-execute.mjs`、`deletion-transports.mjs` 与 `../../src/chat.mjs` 的真实范围仍保留。现有 chat transport 的 `archiveDeleted:true` 只证明其负责的归档层；S3 `erase` ACK 只证明对象接口层，不声明底层物理块已回收。

## 集成合同

1. 候选是同一受控源树的差异包，不是独立可运行服务。必须保留已捕获 release 的 `operations-stack`、maintenance 公共 service/schema/catalog、锁定依赖、当前中央授权和 root 的模型控制模块。不要将整个开发目录复制到稳定发行。
2. 入口仍是 `node packages/galaxy-official/deploy/maintenance-agent/server.mjs --config /etc/galaxy/maintenance/agent.json`。没有新端口、迁移或 browser body 参数；root 的可选 `/v1/model-settings` 分支及 `manage.mjs` 动态 resume 必须保留。差异包不覆盖这三类 root 所有源。
3. Agent 仍通过 UDS/service key/HMAC 接受闭合意图，变更前向固定 loopback API 重新授权。`runtime.mjs` 该请求现含 `x-forwarded-for:127.0.0.1`，供现行 trusted-proxy 检查；这不是放宽外部认证。该一行已经单独交主部署流程应用于稳定 runtime，不能因此把整个候选文件混进当前修复包。
4. 当前 `configuration.example.json` 与已部署配置继续 `production.enabled:false`。本候选不提供开启生产恢复的部署命令，也不安装单元或修改当前 timer。原恢复点缺少动态 source bindings、镜像/新增卷覆盖时拒绝，不回填历史证明。
5. 未来接齐贡献后，需依据已批准 footprint 为原子目录切换提供精确目标及父目录写权限，并仅为 Caddy runtime 增加 `/run/galaxy-maintenance-caddy`、`/run/systemd/system/caddy.service.d`。当前只读/备份示例单元不是生产恢复权限模板，不应改成全盘可写。P20 的当前 `/etc/galaxy/model-settings` 写入范围仍由其独立控制合同维护。
6. 私有贡献与 journal 固定保存在 `/var/lib/galaxy/maintenance`，root 0700/文件 0600，不进入源码包、日志或业务恢复点。原生读写必须使用同一当前镜像/实际 schema、受限 socket 与当前服务配置。未知 schema、源绑定、授权、原生结果或开门状态均拒绝。

## 证据边界

新增 `test/maintenance-production.test.mjs` 为九个唯一行为叶：真实 PGlite SQL、临时私有文件/符号链接，以及明确的原生命令、存储/HTTP替身。首轮模块 SyntaxError 未运行行为叶，原件保留；后续只补未过或实际受改动影响的叶。已有公开合同、删除贡献、前端/Next 与其他页面检查没有重复运行。

Oracle 只读检查记录了实际 API Host/forwarded 头、Caddy 启动路径及 `admin off`、Prosody 正确配置路径、Garage CLI 和 Grafana 表结构元数据。这些不是恢复、Caddy 重启、key 回放、原生索引写入或所有组件就绪验收。逐项结果与第一次失败见本轮支持目录 `p19-maintenance/backend/PRODUCTION_VALIDATION.md`。

本次另新增三叶 native-authority 组：Garage 写语义是明确替身，Grafana 是原生 PRAGMA 结构的实际 SQLite，私有贡献与资格接线使用临时文件。三叶首轮通过；现场只读接续发现原生 472:472/0400 key 所有者假设差额后，仅补第三叶与 Grafana 读取，保留首读失败；补齐未知 ACL 对象必须拒绝的分支后，仅补第二叶。不重复计数，不重跑 r2 九叶，也不把它们的通过时点改写到新源上。

v4 再新增三叶 Prosody 当前状态组，最终通过；原生13.0.6只在无网络/无生产挂载的tmpfs执行合成资料。首次stdin缺失和独立metadata入口ESM环失败保留，仅补受影响叶/只读入口；对象未接贡献边界只补接线叶。现场最终只读为1房间/0消息/0原生登录用户、liveComponentRoundTrip=false，不能从空消息推导恢复正确。详见本轮 `p19-maintenance/backend/PROSODY_VALIDATION.md`。

v5 新增三叶最终通过：固定认证流/签名回调（传输明确替身）、真实签名删除与 PG 精确对象/回执（S3 明确替身）、先安全合并/对象贡献再恢复应用 writer 的主机顺序（原生效果替身）。首轮 feedback INSERT 夹具 42P18 保留；只补该叶通过。随后补 docker exec 显式 stdin，并把抑制逐对象状态输出的 quiet 参数收进固定 helper，均只补同一对象叶，用真实原生 psql 只读固定字面量确认通路；不叠加唯一用例数。另当前 PG/S3 只读为 1 指针/0 native 对象，没有读取文件正文或调用删除。具体结果见 `p19-maintenance/backend/LIVE_CONTRIBUTIONS_VALIDATION.md`；未跑旧组或实际恢复。


## 当前生命周期目录缺口（2026-10-26 本地整合）

完整 schema131 的合成 PGlite 检查确认：`lockDeletionTables` 对下列39个新表没有既定的数据归属合同，当前真实 `executeDeletion` 在任何删除／撤销副作用前拒绝。保护逻辑保留；没有用通配 excluded、跳过表或删除断言让恢复显示成功。

- 迁移 121：`operations_registered_commands_v1`, `operations_registered_directory_v1`, `operations_registered_entries_v1`, `operations_registered_generations_v1`, `operations_registered_login_fences_v1`, `operations_registered_subjects_v1`。
- 迁移 122：`operations_management_accounts_v1`, `operations_management_commands_v1`, `operations_management_directory_v1`, `operations_management_entries_v1`, `operations_management_generations_v1`, `operations_management_login_fences_v1`。
- 迁移 123：`operations_ai_work_accounts_v1`, `operations_ai_work_assignments_v1`, `operations_ai_work_commands_v1`。
- 迁移 124：`operations_system_general_publications_v1`, `operations_system_settings_commands_v1`, `operations_system_settings_heads_v1`, `operations_system_settings_versions_v1`。
- 迁移 125：`account_follow_operations_v1`, `account_follows_v1`。
- 迁移 127：`official_account_registrations_v1`。
- 迁移 129：`operations_ai_duty_operations_v1`, `operations_ai_role_delegation_events_v1`, `operations_ai_role_delegations_v1`, `operations_autonomy_commands_v1`, `operations_autonomy_configs_v1`, `operations_autonomy_decisions_v1`, `operations_autonomy_event_consumers_v1`, `operations_autonomy_events_v1`, `operations_autonomy_health_v1`, `operations_autonomy_receipts_v1`, `operations_autonomy_runtime_v1`, `operations_autonomy_runtime_versions_v1`, `operations_autonomy_strategy_schedules_v1`, `operations_autonomy_tasks_v1`, `operations_autonomy_tool_calls_v1`, `operations_autonomy_versions_v1`, `operations_autonomy_workbench_runs_v1`。

这阻止当前 schema 的完整本地 ID 删除及依赖完整删除账本重放的生产恢复验收。旧 schema110 的检查、SQL 子合同、模拟 native RPC 和配置源已恢复，不替代这些缺表的逐表用途、保留及独立主体设计。本候选继续禁用生产恢复入口；没有运行真实数据库迁移、备份、清理或恢复。
