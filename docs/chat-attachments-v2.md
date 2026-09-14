# 私有临时聊天附件 v2（schema65）

2026-09-13，M12 普通聊天 / M19 受管保留切片。本页描述已实现接口；真实生产发行状态由对应发布回执确定，不能因本页或底座已启动而宣称完整聊天产品已经上线。

## 来源、采用与责任

- [M12 完整工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M12.md)、[M19 完整工作包](../../../../02-architecture/redesign-v1/predevelopment/work-packages/M19.md)。
- 卷09 §09.10–09.12、§09.28：消息与附件共享、发送回执、真实权限及成果引用；卷12 §12.5–12.11、§12.23：附件独立期限、撤销、本人导出、服务持有副本与外部副本区分。
- [本轮完整来源阅读与差额记录](../../../../07-logs/development/chat-attachments-preparation.md)。CUR-35 恢复开发与部署，后台备份仍暂停。
- 普通附件从首次接收上传开始固定30天。短消息期限可以先终止共享读取；它不让本人仍保留的原文件自动失效。撤回消息则撤销关联下载并排队清理附件，独立撤销附件不改写消息文字。
- 初始单文件10MiB、本人64MiB、服务10GiB、每消息4个是本轮已授权资源配置；可独立调参，不能描述为用户要求无限托管。准备上传有效1小时，同时最多4个在途上传，正文只进入受控存储。最小无正文擦除回执归入既定180天安全审计类别；已执行主体删除后，真实对象删除回执到达即可删除该主体元数据。

## 已实现流程

1. 用户选择本机文件，预览文件名、大小、类型和期限，明确确认上传。客户端保存原操作ID、声明字节数/hash、身份和房间；不把全文件自动写入聊天草稿或模型上下文。
2. 服务验证当前会话、账号条件、房间及父区成员关系，预留真实存储额度。未发出的文件仅上传者可读。上传必须与原大小/hash相同，文件名不作为对象路径。
3. 受限原始 PUT 上传成功后进入 scan-pending；后台用实际 ClamAV INSTREAM检查同一份字节及签名数据库时效。扫描不可用保持等待，检测到威胁或超出引擎限制不能成为可用文件。clean 只表示当前配置范围未发现威胁，不是安全保证或 Evidence Verification。
4. 可用文件通过精确 `{id,sha256}` 绑定同一作者、同一房间的一条消息。绑定与消息预留同一事务，实际发送前再检查；未知发送回执重试沿用原消息ID。没有附件时解析器不加空数组，旧载荷hash保持原样。
5. 历史页返回可见文件状态，下载每次重新校验原会话控制、当前房间/父区成员、消息状态、个人隐藏、源删除状态、附件撤销/期限，并验证实际取回字节hash。客户端同样验证摘要。下载固定 octet-stream / attachment，不内联执行未知文件。
6. 读取、编辑消息、重试或重新打开页面不续期。源作者提出删除请求先对他人隐藏；取消未执行请求恢复尚有效权限，不提前物理擦除。只有明确撤销、消息撤回、到期或已验证删除执行才使对象进入删除队列。
7. 对象删除失败继续保留 key、额度和清理状态。S3 删除回执只表示逻辑对象移除，磁盘块由 Garage 回收；不声称已验证存储介质擦除。普通文件不会自动进入长期 Evidence、Capsule 或公共源许可。

## 接口与模型边界

全部路径使用绑定会话的 `binding` scope；接口不返回桶地址、对象key、SSE材料或可转发的长期下载URL。JSON请求沿用32KiB上限。

| 方法与路径 | 输入 / 返回 |
|---|---|
| POST /v2/chat/attachments/config | {}；返回配置启用状态、限额、固定期限含义；配置存在不等于当前存储健康 |
| POST /v2/chat/attachments/prepare | attachmentId、roomId、name、mediaType、size、sha256、purpose=temporary-room-attachment、confirmed=true，可选agentGrantId；返回原操作状态 |
| PUT /v2/chat/attachments/{id}/upload | octet-stream、精确Content-Length；字节不得超过准备值；返回scan-pending或原回执 |
| POST /v2/chat/attachments/read | {attachmentId,agentGrantId?}；当前可见状态 |
| POST /v2/chat/attachments/query | {roomId,after?,limit?}；本人该房间上传分页 |
| POST /v2/chat/attachments/revoke | {attachmentId}；本人文件立即拒绝下载，清理异步 |
| POST /v2/chat/attachments/{id}/content | {}；当前房间获准文件流，响应含 X-Galaxy-Content-Sha256 |
| POST /v2/chat/attachments/{id}/export-content | {}；仅本人仍保留原文件；不能借导出取得别人的附件，退出原房间后仍需本人当前有效身份 |
| 既有 chat room send | 可选attachments:[{id,sha256}]；旧文本、编辑、回执及hash保持兼容 |

浏览器 `api.attachmentTransfer` 使用已核验的同一个服务端点、内存会话及 generation；不向附件组件暴露token，不允许重定向到对象存储。网页显示上传阶段、扫描、恢复及期限；响应丢失先查询原准备记录，不直接生成第二次上传。每条消息仍带用户填写的说明文字。

MCP新增4个真实工具：配置、当前附件状态、本人房间上传清单、撤销。聊天send可引用已可用附件；MCP不假装能读取宿主本机文件，不把二进制自动塞进模型。宿主的本地文件选择器/浏览器完成实际上传。用户Agent只得到有界状态，不由银河模型分析文件。

## 存储、权限和生命周期

新增 `chat_attachments` 一表；旧迁移1–64不改写。随机对象key与上传ID一一对应，保留原作者、房间、大小/hash、固定期限、租约、扫描状态与清理回执。普通消息依旧在 Prosody/MAM；没有第二份聊天全文数据库。

API仅有上传元数据所需SELECT/INSERT及指定列UPDATE；worker有实际扫描和清理需要的列权限。扫描和删除由现有worker消费，不增加Agent心跳或备份任务。附件字节用专用配额，通用1MiB载荷配额只统计元数据，避免把一份合法10MiB文件错误计算为超限普通JSON。

M19的 `chat-attachment-receipts` 导出仅本人元数据，不包含对象key/SSE材料。原字节从独立本人导出端点授权取回。删除表登记为外部对象受管表，PG行删除不等于S3擦除；批准执行后排队清理，当前源立即不可读。最小文件擦除记录保留审计期限，不能反向恢复正文。服务关闭分享时仍允许本人撤销；退役takeout期间仅本人原文件出口，新增上传继续拒绝。

## 部署给AI Agent的具体说明

底座使用 [Garage 2.4.1 官方发行](https://garagehq.deuxfleurs.fr/_releases.html) 与 [ClamAV官方容器](https://docs.clamav.net/manual/Installing/Docker.html) 1.4.6 LTS，均固定实际镜像摘要。单机 replication_factor=1，无高可用承诺。Garage使用SQLite、fsync和私有loopback入口，不启用备份快照任务。AWS SDK3.1131.0与file-type22.1.0固定在包和lock中。

Garage的[S3兼容说明](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)与[加密说明](https://garagehq.deuxfleurs.fr/documentation/cookbook/encryption/)支持本方案的SigV4/path-style/SSE-C。适配器显式传入32字节SSE-C密钥；没有把普通HTTP传输描述为公网加密通道。存储/扫描只走同机loopback，API代理负责现行ACL。扫描通过[ClamAV INSTREAM协议](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)实际执行，禁止用可用性假值顶替扫描。

只在 `GALAXY_ATTACHMENTS_CONFIG_FILE` 或 systemd `CREDENTIALS_DIRECTORY/galaxy-attachments.json` 指定时启用。Linux配置必须是受控私有文件，不从用户目录、归档或其它服务.env自动发现。API/worker使用相同loader；不存在则报告未配置，已指定但语法或权限错误则启动失败。密钥不放仓库、日志或前端公开配置。

```json
{
  "version":1,
  "store":{"endpoint":"http://127.0.0.1:3900","bucket":"galaxy-chat-temporary","region":"garage",
    "credentials":{"accessKeyId":"由部署系统注入","secretAccessKey":"由部署系统注入"},
    "sseKeyId":"attachment-key-1","sseKeyBase64":"由部署系统注入32字节密钥的base64"},
  "scanner":{"host":"127.0.0.1","port":3310,"timeoutMs":60000,"maxSignatureAgeSeconds":259200},
  "policy":{"version":1,"maxFileBytes":10485760,"maxSubjectBytes":67108864,"maxGlobalBytes":10737418240,"maxFilesPerMessage":4}
}
```

此例中的文字占位不满足密钥schema，不能直接拿来启动；具体材料由已选服务器的受控部署加载。不能轮换SSE密钥后删除旧材料，否则旧附件仍占空间却无法读取；本切片不含多版本密钥迁移。上传服务不启动Shell、解压运行环境或云模型；ClamAV单独进程承担扫描，资源及签名更新必须真实配置。AGPLv3的Garage和GPLv2的ClamAV分别独立部署，客户端SDK为Apache-2.0、file-type为MIT；对外源码/容器交付继续按各上游许可处理。

## 已取得证据和明确余项

- 本地领域/实际HTTP1项、实际PG受限API/worker1项、BrowserRuntime实际HTTP1项、旧聊天恢复1项通过。账号注册在附件夹具中明确隔离，不作为新账号或真实参与者验收。
- 2026-09-13T02:12:01Z底座适配实测通过：SSE-C Put/Head/Get/Delete、无害样本clean、内存EICAR blocked。
- 2026-09-13T02:24:58Z真实隔离Prosody+Garage+ClamAV+HTTP组合通过；元数据是独立PGlite，真实PG权限另行验证。隔离容器、合成聊天数据与组件key已清理，无生产重启。对应项目报告保留全部精确源摘要。
- 普通临时文件路径可进入受控发行；最终生产发布/实际用户视觉体验由各自回执确认。父区ACL继续复用既有requireRoom，长期观察和真实用户体验不由自动测试替代。
- 长期Evidence二进制托管、附件来源显式再披露许可、大文件分块恢复、图片预览、多密钥轮换属于后续独立需求；本次不取消，也不以普通文件已上传计作完成。
