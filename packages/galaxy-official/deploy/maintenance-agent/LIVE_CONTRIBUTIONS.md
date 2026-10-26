# P19 r5：在线组件与已执行身份删除的对象贡献

这是 `galaxy-current-authority-host-restore-v5` 候选增量，依赖 r3/r4 的当前安全态合并。`production.enabled:false` 保持；没有运行生产恢复、备份、对象删除、原生账号/ACL 变更或组件重启。

## 原 API 的 Prosody 连接

`ProsodyChatTransport.probe()` 只使用现存 `@xmpp/component` 已认证流，向配置中的 `rooms.galaxy.internal` 发送固定 XEP-0030 `iq/get/query`，namespace 为 `http://jabber.org/protocol/disco#info`，不传 `node`。没有房间、身份、消息、正文或任意 stanza 参数，不查 `disco#items`，也不建立第二条 component 连接。只接受相同请求 ID、精确 from/to、`type=result`，服务信息必须含 `conference/text` identity 和 `http://jabber.org/protocol/muc` feature。服务名称、其他 feature 和可选原生服务表单不进入五字段 DTO；错误、无关目标、其他 query 或额外正文全部拒绝。

当前固定 Prosody 13.0.6 的 `mod_muc.lua:115–117` 显式依赖 `disco` 并注册上述服务身份和 feature。`mod_disco.lua` 的 host-info handler（默认优先级 0）只生成 host metadata 并返回；MUC 房间 handler 的优先级为 -2，所以该固定服务请求不会进入 room、subject、archive 或 items 查询。原 r5 的 XEP-0199 探针虽符合 `mod_ping` 回包格式，但当前 MUC component 不继承全局 ping，现场不能由此得到空 IQ；本次只修 transport，不修改原生配置。来源副本保留 MIT/X11 原版权。`ChatService.maintenanceReadiness()` 仍只转接这个方法，成功也不证明消息材料权限或 MAM 存储正确。

中央接线合同：`POST /v1/internal/maintenance/chat-probe`；仅 loopback，沿现有 maintenance service key **先于读取 body**，再核原始 body 的 request ID/时点/HMAC，禁止 query。严格输入 `{version:1,kind:'prosody-current-state',operationId:UUID|null}`，不接任意参数。调用现有 `services.chat.maintenanceReadiness()`，只返五个闭合字段 `authenticatedGateway/roomsDomain/roundTrip/readOnly/bodyReturned`。不进入 BFF、公域仍拒绝 private 前缀。中央由主会话串行接入，本候选没有改其 server/routes。

`createMaintenanceProsodyProbe({configuration,fetchImpl})` 从现有 `configuration.authorizationUrl` 只派生这个固定端点，复用受保护 service key；发送固定可信本机 `X-Forwarded-For:127.0.0.1`，禁止 HTTP redirect，限制响应大小并严格核对五个字段。后续主会话把它传给 `createHostRestoreAdapters({prosodyProbe})`。未注入时继续拒绝，不把健康状态冒充在线探针。

## 精确对象贡献

1. 沿原 `validateDeletionLedger` 再核完整签名、批准与执行链。只有实际 `execution_result` 的 `all-owned-service-data` 请求产生 GUID 删除范围；提交、批准、关联账户、到期或 `purge_pending` 都不产生范围。
2. 当前对象指针在原 writer 停止后私有捕获。点内指针在精确 quarantine 中、原 SQL 删除回放之前捕获，再与当前事实合并后的实际 PG 指针交叉检查。只包含表/对象标识、真实 storage key、加密 key ID、hash、大小和处理资格，不含名称、正文或下载 URL。计划是同一 operation 的 0600 私有贡献，不能由浏览器或模型提交。
3. 已有生命周期决定覆盖本人 `chat_attachments`、本人上传的 `forum_attachments_v1`，以及原代码已明确的本人/本人作者 `outcome_materials_v2`。账户 cookie 的公开上传、账户私聊文件和反馈附件不因关联 GUID 删除而归属这个 GUID。独立资料的既有政策不新增或改写。
4. 同一对象在 current/point/canonical 中的 owner/key/hash/大小必须一致。跨逻辑对象 key 复用、独立引用冲突、仍在处理的 lease、缺失来源或无法证明的身份全部阻断。原存储 bucket 的完整有界 `ListObjectsV2` 只用于发现未知 key 并拒绝继续，**不把未知 key 变成删除目标**。
5. 当前凭据从原 worker 的固定配置绑定发现。现场是 systemd `LoadCredential=galaxy-attachments.json:...`，不是 worker.env 中显式配置；候选解析唯一原 source 引用并复用 `loadAttachmentConfiguration`。不依赖 worker 停止后消失的 `/run/credentials` 副本，不复制/输出 secret；只允许当前 loopback S3。
6. Garage 恢复卷激活后，先合并当前原生 key/ACL；API、应用和 worker 继续停止。此时只对签名范围内的精确原键执行 `HEAD → 当前资格再核 → DeleteObject → HEAD`。已有对象必须与原 hash/大小相符。Delete ACK 丢失只查询原键：确认不可见后继续；仍存在或查询失败则停止，保持站点关闭及业务 writer 停止，不宽扫或盲重放。
7. 原生 absence 确认后，只对同 ID/key/hash/大小的实际记录写最小清除事实，不重建已删除行、不消费其他 pending/expired 对象。恢复 SQL 的更新通过固定 psql stdin，避免大清单进入 argv。随后才恢复应用 writer，并在统一开放前再次查这些精确键不可见。

DeleteObject ACK、HEAD 不可见和 DB 记录证明的是当前 bucket 命名空间/源记录状态。没有证明底层物理块回收，也不声称外部副本或整服务全部删除。未知孤儿、旧加密 key 不可用、当前源冲突、原生持久管理 token 不可导出、当前桶不在点内等具体条件仍阻断。对象模块需要同批 business，避免缺失可核的原生源清单。

## 部署接续

本候选不修改 stable runtime/manage/server、中央、前端、模型或任何生产配置。主会话后续需把上述固定 private route 与 probe 注入同一候选发行；当前 false 部署保持原隔离准备行为。只有用户批准某个具体恢复方案后才允许代码进入恢复阶段；这份源和检查不构成该批准。

新行为检查的实际范围和首轮/受影响补查结果以项目 `p19-maintenance/backend/LIVE_CONTRIBUTIONS_VALIDATION.md` 为准；旧已通过组没有重跑。原生生产效果仍未执行。
