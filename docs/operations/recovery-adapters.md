# 维护Agent与恢复原生适配合同

`packages/galaxy-official/deploy/maintenance-agent/`保存主机执行器。备份/隔离恢复及具体方案批准边界统一见[恢复](recovery.md)，跨入口身份/原操作处理见[接口](../technical/interfaces.md#管理身份与原操作)。当前configuration.mjs只接受production.enabled=false；下列生产实现是候选合同，不提供打开开关的安装路径。

## 私有Agent与动态捕获

启动 `node packages/galaxy-official/deploy/maintenance-agent/server.mjs --config <保护JSON>`，只监听 `/run/galaxy-maintenance/<name>.sock`，无TCP。Agent JSON root普通文件0600；service key root所有、最多API专用组只读、无group write/other。API配置 `{version:1,socketPath,keyFile}` 由GALAXY_MAINTENANCE_NATIVE_FILE指向，socket目录root:API组0750、socket0660，apiGroupId从实际API运行用户解析。控制journal/贡献在 `/var/lib/galaxy/maintenance` root0700/文件0600，独立业务PG/恢复副本，不能被旧点覆盖。

双向先验service key再收≤64KiB原始JSON，核request ID、30秒窗口/HMAC；重签请求id拒绝，业务幂等另用operationId。副作用前回固定loopback `/v1/internal/maintenance/authorize` 取已提交意图；trusted proxy合同含固定X-Forwarded-For:127.0.0.1，公网/BFF拒private。浏览器只传闭合操作/批准ID，不接command/path/DSN/repoURL/LogQL/脚本/开放表达式。

安装固定捕获release（GALAXY_MAINTENANCE_RELEASE），不指可写开发树。sample systemd仅覆盖只读/备份所需路径；模型控制文件存在时保可选/v1/model-settings分支，不自动创建模型配置。动态定时命令为 `node .../maintenance-agent/manage.mjs backup --config <agent JSON>`，中断用同工具resume-writers；替换timer Exec命令不改变日程/retention/仓库。原timer没采用该入口的恢复点保持原覆盖。

footprint解析API/worker/publisher/admin当前release、CMS依赖、已知容器卷与Agno PG归属，停writer后重核同清单，漂移中止并恢复writer。已配置PG由pgBackRest提供点，新独立PG/ClickHouse/Redis/Meili卷按实际owner有界停写捕获，不能复制活动DB卷冒充一致。Gateway usage.sqlite3随点，当前model-settings的keys/env/bindings/models/control ledger、PG model version/credential refs保当前。restic目录总数覆盖配置仓库，分页只是读取窗口，processed bytes不是物理占用；check --read-data仅工具完整性。overview/logs/point健康只读，不触发备份、全仓校验或恢复。

## 固定恢复阶段和数据权威

执行器固定contain→capture-current-facts→prepare→restore→reconcile→validate→activate→validate→open。staged仅隔离准备证明，切换后最终ready才统一open一次，阶段不接调用方表达式。

| 模块 | 必需消费者/顺序 |
|---|---|
| current-facts / maintenance-recovery-facts | 同schema私有quarantine合并当前主体/角色/读权/撤回/期限、独立消息限制、模型版本/refs、SMTP与外部投递账本 |
| host-database | business/已记录Agno库隔离准备与名称切换；当前Keycloak/accounts集群不回滚，不导旧PG角色密码，保现有ACL，失效旧会话、取消旧外发与原生ticket |
| host-files / website-pointer | 仅approved owner/path/source binding，保当前/etc/galaxy、配置/控制release、Keycloak卷；保旧目录/网站指针供接续 |
| protected-configuration / model-preservation | PG当前版本/绑定/credential refs与保护文件、双方引擎读回一致，非空与未配分别核，不能只保raw key |
| discovery-reconciliation | 精确业务副本+原匿名reader全量核Meili/Gorse，去无canonical/失效条目、阻旧排队回写，保独立account/visitor usage |
| caddy-control / public-gate | 原admin off Caddy、固定runtime JSON和单runtime drop-in，保IAM/控制、其他503；来源变化拒open，无新管理端口 |
| native-health | API ready、原生读、当前IAM/模型版、受控public probe分别核 |

P13/112存在时策略heads暂停、非completed/no-action runs blocked；旧schema两表皆无不补造、一表缺失拒绝。按approved footprint只给精确目标及父目录写权；Caddy runtime专用 `/run/galaxy-maintenance-caddy` 与 `/run/systemd/system/caddy.service.d`，不可将sample unit改全盘可写。缺动态source bindings、镜像或新增卷贡献的旧恢复点拒绝，不回填。

## Garage与Grafana当前安全态

固定上游核对入口为Garage2.4.1 [API类型](https://docs.rs/garage_api_admin/2.4.1/src/garage_api_admin/api.rs.html)、[key handler](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.4.1/src/api/admin/key.rs)，以及Grafana13.2.4的[sqlstore migrations](https://github.com/grafana/grafana/tree/v13.2.4/pkg/services/sqlstore/migrations)；实际schema仍由当前原生PRAGMA核对，不以浮动上游替代。

当前原生安全态在writer停后捕获到操作绑定私有贡献；Garage/Meili为捕获暂留RPC/HTTP，之后再停卷。Garage2.4.1使用 `garage json-api <endpoint> -` stdin，不用secret argv的key import、不加admin listener/token；Allow只添加true，撤权必须Deny。恢复卷切换后先撤点内旧桶权/别名、失效旧key/admin token，再设当前key/expiry/createBucket/精确桶权/别名/网站访问；当前secret不得套另一旧ID，点缺桶不凭别名建。CORS/lifecycle按原值，不新增政策。key/secret、read/write/owner、global/local alias、网站资格须完整列举，10000上限触顶拒不称完整。

Grafana13.2.4以实际SQLite schema/migration在精确candidate grafana.db事务合并，不经无法导完整hash/secret的HTTP API，不另建身份库。需同镜像、operation guard；保当前org/user、password/salt/rands、disabled/admin、service account/OAuth、teams/members、roles/permissions/assignments/撤销、加密签名keys/secret。旧session/token/external-session/cache失效，旧账户不复活。点内业务dashboard/unified内容保点，当前ACL按org+stable UID映射，不能用标题/位置。data source、plugin/alert连接及secret整行保当前，防当前key送旧目标。472:472/0400 key只在匹配当前精确只读/run/secrets mount时接受，合并前和最终复查绑定。

| 原生条件 | 闭合阻断码/行为 |
|---|---|
| Garage持久admin token secret不可导出 | maintenance_garage_current_admin_token_not_exportable |
| 当前桶点内不存在 | maintenance_garage_current_bucket_missing_from_point |
| 同key ID异secret | maintenance_garage_existing_secret_conflict |
| 版本、触顶、tombstone/native操作未证 | maintenance_garage_version_not_supported / inventory_incomplete / native_operation_failed，不造替代身份 |
| 网站routing rule未支持 | maintenance_garage_website_authority_unsupported |
| Grafana未知unified类型（非dashboard/folder/advisor） | maintenance_grafana_unified_authority_not_supported |
| 外部snapshot/cloud migration capability | maintenance_grafana_external_capability_not_supported |
| 未知security table/namespace、schema差异 | 对应not_supported或maintenance_grafana_schema_changed |
| ACL无stable UID | maintenance_grafana_current_acl_target_unknown |
| key owner/mount/content/version绑定变化 | maintenance_grafana_current_key_binding_required / changed |

这些条件在空实例也须保留。最终open前复核native key/权限/绑定与旧会话失效，不能按旧计数跳过。

## Prosody离线贡献与同连接probe

固定Prosody13.0.6，原 `mod_galaxy_rooms_v2.lua` 只用API gateway component，不加c2s/s2s/注册/管理入口。`prosody-storage.lua`直接调用该镜像internal driver，由原生负责stanza、MAM key、list/lidx写与回读，只收inspect/capture/reconcile/verify；固定代码argv，敏感事实stdin。运行无网络/capabilities、rootfs只读；读当前data只读，写仅同operation精确 `.galaxy-next-<operationId>` 副本。

1. 读实停的chat writer后捕获native accounts/roles/MUC/galaxy_erased。validateDeletionLedger只认已验签且实际execution_result的all-owned-service-data GUID，不从申请/批准/关联账户推删除。
2. quarantine中按消息ID/房间/作者/修订/期限/状态找精确key；仅当前撤回/到期或已执行删除主体自己的key进入清除，其他作者独立保留，未知/冲突孤儿拒绝。
3. 私有native副本删除并archive:get证absence后，逐key正回执交原ChatService.eraseSubject/purgeOne，复用房间退出/继任/单成员/agent grant；已清且purge_pending=false行也不能复活，只消费原精确行，不宽扫purgeExpired。
4. 由当前事实PG投影房间/修订/成员，清旧owner/admin，仅API member；点有而当前无DB对象房间保无成员archived，清旧occupant/state/history，当前native账户角色覆盖旧权，配置/component secret不回滚。SQL必须在host-database.prepare的pg_dump前完成。
5. 高修订不在点中保持archive pointer null，不将旧正文标新版；withheldOlderRevisions独记，不延长tombstone/期限，当前更长原标记保持。

同连接readiness源是原ProsodyChatTransport.probe：复用@xmpp/component已认证流，向rooms.galaxy.internal发送固定XEP-0030 disco#info iq/get、无node，核同request ID/from/to/result、conference/text identity与MUC feature。固定13.0.6 disco handler优先级0在MUC room handler -2前处理服务metadata，不查items/房间/subject/archive。旧XEP-0199 ping未被该component继承，不能继续作为合同。

`POST /v1/internal/maintenance/chat-probe`为loopback service key先body、原raw request ID/时点/HMAC、禁query；输入 `{version:1,kind:'prosody-current-state',operationId:UUID|null}`，返回仅authenticatedGateway/roomsDomain/roundTrip/readOnly/bodyReturned五字段。prosody-live-client从authorizationUrl派生固定路由，禁redirect/限响应，传固定可信forwarded头，注入createHostRestoreAdapters的prosodyProbe。未接实际同连接回读则maintenance_current_chat_native_readiness_not_proven，进程status不替代。禁另登同component、新admin_shell/端口或私有材料probe。chat模块还要求同批business数据库，否则maintenance_prosody_current_database_scope_required。

## 已执行删除的精确对象贡献

Prosody归档回执不代替Garage附件。对象执行器只消费同一已执行签名all-owned GUID，当前writer停后指针、点内SQL删除回放前指针、合并当前事实后的canonical指针相交。私有0600计划含table/object ID、storage key、key ID/hash/size/资格，不含名称/正文/URL。归属限原本人chat_attachments、本人forum_attachments_v1、原定义本人/作者outcome_materials_v2；账户上传/账户私聊/反馈不因关联GUID收养。

owner/key/hash/size在current/point/canonical须一致，跨对象key复用/独立引用/活lease/缺source或不明身份拒绝。有界完整ListObjectsV2只发现未知key并拒，不生成删除目标。原worker固定LoadCredential source引用经loadAttachmentConfiguration读取，不能依赖停worker后消失的/run/credentials，仅当前loopback S3。

Garage激活卷先并当前key/ACL、应用与worker仍停，再逐原key HEAD→重核资格→DeleteObject→HEAD；原对象hash/size须符。Delete ACK丢失只查原key，确认为absence才继续，否则保持关闭；SQL用固定psql stdin写同ID/key/hash/size最小清除事实，不重建行、不处理其他pending/expired。恢复writer后、open前再核这些key仍不可见。桶命名空间absence不证明物理块/外部副本删除。

## 当前schema删除归属与检查范围

完整schema131的 `lockDeletionTables` 已为此前缺失的39张表加入封闭的逐表归属：网站账户数据随账户维护；registered/management目录、命令和登录fence属于独立认证身份；AI身份、授权、运营配置与审计属于独立运营权威。本地ID删除不因文本相同或账户关联删除这些记录；未知新增表和缺失已登记表仍在副作用前拒绝。隔离PGlite回归在下列全部39表写入非空记录，执行ID删除及旧副本删除重放后逐行比较，另验证所属上传正文被清除和独立ID保留。此前缺口集合及现行归属范围：

| 迁移 | 表（统一前缀保留原名） |
|---|---|
| 121 | operations_registered_commands_v1、directory_v1、entries_v1、generations_v1、login_fences_v1、subjects_v1（后五项同operations_registered_前缀） |
| 122 | operations_management_accounts_v1、commands_v1、directory_v1、entries_v1、generations_v1、login_fences_v1（后五项同operations_management_前缀） |
| 123 | operations_ai_work_accounts_v1、operations_ai_work_assignments_v1、operations_ai_work_commands_v1 |
| 124 | operations_system_general_publications_v1、operations_system_settings_commands_v1、operations_system_settings_heads_v1、operations_system_settings_versions_v1 |
| 125/127 | account_follow_operations_v1、account_follows_v1；official_account_registrations_v1 |
| 129 | operations_ai_duty_operations_v1、operations_ai_role_delegation_events_v1、operations_ai_role_delegations_v1；operations_autonomy_commands_v1、configs_v1、decisions_v1、event_consumers_v1、events_v1、health_v1、receipts_v1、runtime_v1、runtime_versions_v1、strategy_schedules_v1、tasks_v1、tool_calls_v1、versions_v1、workbench_runs_v1（该组简写均加operations_autonomy_前缀） |

当前安全态捕获另保留19张新身份安全表：注册预约、registered/management目录和原操作/登录fence、稳定AI工作身份、角色分配与委托撤销、原AI受托操作。旧点中的AI身份、分配和委托先停用，再合并当前值，当前账号禁用、登录撤销和AI停用不倒退。系统业务设置不因同属新迁移就当作当前安全态覆盖，仍随准确恢复计划选择；普通自主策略配置在隔离合并后停用，非终态任务按原operation重新核对前保持blocked，不能恢复后自动重做副作用。配置与密钥原有保护合同继续适用。

不能用旧schema、通配excluded或跳过表绕过。定向测试源为maintenance-production、maintenance-native-authority、maintenance-prosody-current-state及在线/对象贡献相关tests：SQL/PGlite、node:sqlite、tmpfs原生Prosody、临时文件与显式RPC/S3/HTTP doubles分别报告；历史通过数/旧主机只读计数不进入现行结论。具体结果层次见[开发](../technical/development.md#故障定位与未验证范围)。
