# Prosody 当前授权与原生归档贡献

下文保留 r4 的交付范围；后续 r5 已增加在线探针源和精确附件贡献，实际接续及仍未部署的部分见 [LIVE_CONTRIBUTIONS.md](./LIVE_CONTRIBUTIONS.md)。r4 原检查结论不覆盖 r5。

这是恢复 A 的 v4 候选增量，未部署。`production.enabled:false` 保持；没有运行生产恢复、归档删除、对象删除、备份、账号/权限变更、组件重启或第二条 gateway 连接。

## 复用与实际边界

当前固定 Prosody 13.0.6 的 `mod_storage_internal.lua`、`util/datamanager.lua`、MUC `room:freeze/restore_room` 已从实际镜像只读取得并核查。Prosody MIT/X11 许可保持。当前银河 `mod_galaxy_rooms_v2.lua` 没有公开 c2s/s2s/注册/原生房间管理入口；只有原 API 的 `gateway.galaxy.internal` component。产品身份与房间成员权限仍由 PostgreSQL 决定，Prosody 是原生 MUC/MAM 投影，不新建身份库。

新 `prosody-storage.lua` 直接调用该镜像自身的原生 storage driver，原生实现继续负责 stanza 序列化、MAM key 查找/删除、`.list/.lidx` 写入和回读。没有正则改写存储文件、通用 Lua 执行 API 或新增管理监听。脚本只接受固定 inspect/capture/reconcile/verify。

`MaintenanceProsodyCurrentState` 固定当前已注册 container/image/data mount；原生版本必须精确为 13.0.6。短进程无网络、无 capabilities、只读 rootfs；当前只读时只挂原生 data 为只读。写入仅能挂同一 approved operation 的精确 `.galaxy-next-<operationId>` 私有副本。脚本经 argv 传递的是固定代码，敏感事实只经 stdin，捕获件是原控制目录 0600 私有文件。

## 当前授权合并与删除回执

1. 捕获前要求记录中的原聊天 writer 已停止，并再次读取实际 stopped 状态；当前 native `accounts/roles`、MUC 授权及既有 `galaxy_erased` 标记进入独立私有 contribution。普通撤权只保留当前授权状态，不推导为删除所有资料。
2. 原签名删除账本经既有 `validateDeletionLedger` 再核。只有已有实际 execution_result 的 `all-owned-service-data` 请求形成该 GUID 的原生删除依据；请求、批准、关联账户、payload 自报身份都不能替代执行事实。账户 `account:UUID` 与关联 GUID 分开。
3. 在精确 recovery quarantine 中取得消息 ID、房间、作者、修订、原期限和状态。当前撤回/到期的精确 key，或已验签且已执行删除身份自己的原生 key，才进入清除。其他作者的独立消息保持。未知/身份冲突的原生孤儿数据拒绝继续，不能借同房间删除。
4. 先在私有 native 副本按 key 删除并 `archive:get` 确认不存在，才把逐 key 正回执交原 `ChatService.eraseSubject/purgeOne`。原房间退出、继任、单成员状态和 agent grant 撤销复用原逻辑。当前已清除而 `purge_pending=false` 的消息，也不能让旧副本复活；仅对已有撤回/到期的精确行重新消费回执，不宽扫 `purgeExpired`。
5. 房间与修订/成员按隔离 PG 当前事实投影；旧 native owner/admin affiliation 清除，成员只设置原 API 的 member affiliation。点内但当前无数据库对象的房间只保留无成员 archived 状态。旧 occupant/state/history 不接续。当前 native 登录账号/角色覆盖点内旧授权，已撤账号不复活；组件 secret 和原受保护配置不回滚。
6. 上述 SQL 必须发生在 `host-database.prepare` 的 pg_dump 之前；否则会把未经 native 贡献的旧 PG 再转入 live。新 callback 已在这个位置接入。原生删除不声明物理块回收，不延长 tombstone/聊天期限；新标记只覆盖源原有的不可变 expires_at，当前更长的既有标记保留。
7. 更高修订未在恢复点中时，沿既有 source gate 保持 archive pointer 为 null。旧正文不标成新版本，不从别处拉新正文；可以保留为不可读的旧原生副本，汇总单独记录 withheldOlderRevisions。

## 在线 readiness 仍待的精确入口

实际读取确认当前 native storage 可读，1 房间、0 归档消息、0 原生登录用户；这是读取时点元数据。`prosodyctl status` 和这一读取都不证明原 API 的 authenticated component 已往返。

`requireLiveComponent` 只接受内部注入的固定 probe，必须实际报告 authenticatedGateway、roomsDomain=rooms.galaxy.internal、roundTrip=true、readOnly=true、bodyReturned=false。当前没有该 probe；默认在任何 containment 前以 `maintenance_current_chat_native_readiness_not_proven` 拒绝。

最小接法是原 API 借它已经认证的那一条 component 连接做无正文 XMPP ping/空 metadata 往返，再经既有受保护 maintenance 回调返回闭合证明。不能在 sidecar 用相同 component 身份再登录，以免替换现有 API 连接；不能开启 admin_shell/新管理端口或拿普通用户材料作探针。本批未改当前中央/transport，未伪造 callback 成功。

## 附件对象仍缺的独立贡献

Prosody MAM 删除不等于 Garage 附件删除。当前 `ChatAttachments.eraseSubject` 会转入全范围 `purgeExpired`，不能复用来处理本次具体恢复。`purge_pending`、SQL 删除回放和旧 Delete ACK 都不是对恢复卷中新出现对象的确认。

因此，objects 已选且当前有已执行删除请求时，在 containment 前以 `maintenance_current_object_deletion_contribution_not_connected` 阻断；计数不能读取则 unknown 拒绝，最终开放前也再次要求该独立证明。当前还没有这个受限执行器。

后续可沿原已执行 all-owned 请求，核隔离 PG 的真实 owner/storage pointer、当前引用/期限/独立副本，再用现有 S3 客户端逐 key Delete 和 Head 回读；未知孤儿 key、独立材料或无法证明归属的对象不得猜测清除。不得调用宽范围 purge，不借此改 TTL/普通清理批准。普通账户的 OpenPanel/Gorse account profile 与 GUID 各自独立，不能因 GUID 删除就清除关联账户的使用历史。

## 检查与部署说明

新 `test/maintenance-prosody-current-state.test.mjs` 三个唯一叶最终通过：真实签名删除与 PGlite quarantine；同一实际 Prosody 13.0.6 镜像中的无网络、无生产挂载 tmpfs 原生存储；进程-only、陈旧 ACL、缺失回执及对象贡献缺口的闭合拒绝。原生叶首次失败及两次诊断保留，修正 Docker stdin 缺少 `--interactive` 后只补该叶。新增对象边界只补第三叶。原 r2 九叶、Garage/Grafana 三叶和其他业务组未重跑。

新适配实际只读第一次暴露 ChatService 静态 import 进入旧 schema 的 ESM 环，已仅改为 SQL 阶段动态载入；只补该实际只读入口通过。完整证据见项目 `p19-maintenance/backend/PROSODY_VALIDATION.md`。合成 native 数据检查不等于生产 MAM/ACL 合并验收。

这是依赖 r3 及同一受控 API 源/锁定依赖的差异包，非 standalone release。没有新 migration、端口、配置开关或用户表单。保留 root 的 stable runtime/manage/server/model 源；没有允许启用 production 的部署步骤。
