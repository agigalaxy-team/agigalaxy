# 首批已复核发现

状态：进行中。基线 `9fa17ee2b74c621303c598fcd272f8c38f4b9b8f`。本页仅登记已经具备源码证据的发现，不是最终报告；以下均未动态执行、未证实现网发生。

## NATIVE-001 身份恢复凭据未纳入归档凭据过滤

- 优先级：高优先修复；影响为身份恢复材料的保密性。实际风险取决于恢复凭据仍有效、用户误粘贴以及归档/上传选择。
- 状态：confirmed_static；独立源码复核完成，动态复现未执行。
- 受影响路径：
  - [identity-recovery.go 31–47](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/identity-recovery.go#L31-L47) 和 [125–127](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/identity-recovery.go#L125-L127)：本机恢复凭据包含可导出恢复签名私钥的种子材料。
  - [redaction.go 182–198](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/localdata/redaction.go#L182-L198)、[267–277](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/localdata/redaction.go#L267-L277)：字符串凭据模式和对象敏感字段没有覆盖本产品恢复码格式与 recoveryCode。
  - [archive-material.go 163–203](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/archive-material.go#L163-L203)：宿主消息经过该过滤器后写入本机归档。
  - [sync-archive-prepare.go 47–78](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/sync-archive-prepare.go#L47-L78)、[connection-privacy.go 66–76](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/connection-privacy.go#L66-L76)：获准上传的会话快照复用同一检测器，不能弥补上述漏识别。
  - [upload-archive.go 146–151](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/upload-archive.go#L146-L151)、[180–185](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/upload-archive.go#L180-L185)：发送前仍用同一检测器，再提交快照分块。

### 前置条件和影响边界

用户把恢复凭据误粘贴进已选中的宿主对话，才触发本机归档路径；进入云端还需要该会话的同步与隐私授权。独立本机恢复页面不会由上述代码自动泄露到宿主。没有发现真实秘密、没有查看私人归档、没有验证外部攻击者可读云端内容。不能据此宣称账户已经被接管。

### 修复与验证建议

统一扩展本产品身份恢复凭据的字符串与结构化字段分类，覆盖本机存储、导出、上传准备及发送前重检，避免各消费者各自维护不一致正则。凭据应在任何归档副本生成前排除。

隔离回归使用合成、不登记的测试材料，断言纯文本、JSON 字段、混合消息与嵌套结构均被排除；检查旧归档重导出和旧同步队列的发送前阻断。同时验证正常公开身份标识不被误删，撤销上传选择继续生效。不得使用真实恢复码作测试。

## SVC-001 两个 P13 测试入口绕过专用数据库目标校验

- 优先级：中；属于操作与测试安全风险，不是远程未认证生产漏洞。
- 状态：confirmed_static；独立源码复核完成，未执行破坏性验证。
- 受影响文件：[test_p13_strategies.py 92–103](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/services/galaxy-operations-agentos/tests/test_p13_strategies.py#L92-L103) 与 [test_p13_continuation.py 45–54](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/services/galaxy-operations-agentos/tests/test_p13_continuation.py#L45-L54)。
- 两处直接读取测试 DSN，仅校验固定 schema 名称，就创建连接并执行指定 schema 的 DROP … CASCADE。没有调用现有 [database_contract.py](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/services/galaxy-operations-agentos/tests/database_contract.py) 的目标和实际角色只读探测。
- 这两个入口属于同一问题类别，不能按两个文件计为两个独立漏洞。

### 前置条件和影响边界

测试 DSN 被误配至运行数据库，且该角色具有足够权限时，可能删除其中对应固定测试 schema 并写入测试对象。不是整库删除。没有运行过这些测试，也没有生产损失证据。NativeRuntime 入口已接专用校验，其旧回退问题不应再次报告为未修。

### 修复与验证建议

让所有写数据库的测试入口通过统一专用目标校验，再允许初始化、清理或创建业务运行器；复用现有拒绝运行目标、限制测试数据库/角色/命名空间、实际身份及权限探测能力。固定 schema 名称不能代替数据库隔离。

用仅合成的错误配置做负例：运行目标别名、缺少显式变量、过高权限角色及不匹配 schema，必须在任何写入前失败。正例只使用可销毁的独立数据库和最低权限测试角色。

## 尚未完成的验证

以上修复尚未实施。本轮未运行隔离回归，未检查真实用户安装与生产部署是否包含受影响版本；最终报告需单独记录部署适用性和剩余证据，不能把静态修复建议写成已解决。


## WEB-L003 离线来源原作者签名校验缺少身份归属绑定

- 优先级：中；完整性与来源归属风险。
- 状态：confirmed_static，经两个审阅方向独立发现并由主审复读。SVC-002 与本项合并，不重复计数。
- [verification/trust-package.mjs 103–112](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/packages/galaxy-contracts/src/verification/trust-package.mjs#L103-L112) 校验提供的 identity 控制链与其中设备签名，但只比较 consent.subjectId 与 source.authorId，没有把实际签名身份的 subjectId 绑定至这两个字段。
- Go 实现存在同根遗漏：[trustpackages/portable.go 416–447](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/trustpackages/portable.go#L416-L447) 验证提供的身份链后，仅比较已签 consent.subjectId 与声称作者，没有比较该已验证身份本身。主审已复读该分支；本项同时覆盖 JS 与 Go，不重复计数。
- 相邻 verifyTrustPermission 已有 grant.subjectId 与 proof.identity.subjectId/source.authorId 的等值要求，不能用复制许可的独立校验代替原作者签名校验。
- 导入 verifyTrustPackage 对无效复制许可记录 invalid-or-expired 后继续计算 originalSignature，所以可出现“复制许可无效、原作者签名却有效”的错误归属结果。CLI verify-trust-package 输出保留该字段。

### 条件与影响

接收者导入外部资料包或读取该验证器输出。提供者拥有自己的合法身份私钥，可让其签名载荷声称另一作者；无须取得被声称作者的私钥。这里确认的是错误的原作者签名归属，不是外层包完整性失效、线上权限绕过、复制许可通过或能力认证。

### 修复与验证

宣称原作者签名有效前，要求验证后 identity.subjectId、原 identity.subjectId、source.authorId 和已签 consent.subjectId 一致；按实际协议严格校验 consent 结构、用途和设备授权范围。用离线合成身份 A/B 的正负例验证 A 签署、声称 B 的材料不得返回原作者有效，外层签名完整也不能修复内层归属。未执行该回归。

## NATIVE-006 并发修改单项归档选择可恢复已撤销的采集

- 优先级：中；本机隐私选择与并发一致性风险。
- 状态：confirmed_static；主审独立复读关键读改写与数据库写入代码，未动态复现。
- [work-archive-choice.mjs 3–9](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/integrations/host-adapters/opencode-stable/work-archive-choice.mjs#L3-L9) 先读取全部选择，再合并某一工作的修改并全量 configure。
- [archive.go 167–211](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/native/archive.go#L167-L211) 在锁内写入，但没有 settings revision 比较，锁不包含前一步客户端读取。
- 同身份两宿主并发：原选择 [A]；客户1为启用 B 读取 [A]；客户2停用 A 并成功提交；客户1用旧快照提交 [A,B]，重新启用 A。
- recorder 后续重新读取设置并对选中会话回填，因此可能重新采集本机消息。此项不代表云端上传授权被绕过。

修复应采用服务端单项原子修改或 revision/CAS，冲突时只重新应用用户当前明确指定的工作，不恢复其他已撤销范围。隔离回归应有两个共享临时 store 的客户端，在读/写间设置确定性屏障，验证停 A 后启 B 最终仅包含 B，并覆盖全局暂停、保留期限和切换身份。现未执行。

## 其他发现的处理状态

Native 信任缓存更新、RPC 超时/关闭、验证后设备投影，以及构建目录残留公开等线索已完成分域源码追踪，仍在主审复核和统一影响分级，不在本页提前列为最终验收结论。其余资源预算、上游依赖与运行环境风险继续审阅。


## IDENTITY-001 成果文字的个人数据导出未复核当前来源许可

- 优先级：中；当前授权撤回后的正文读取边界。
- 状态：confirmed_static，经身份/数据生命周期审阅并由主审复读关键代码和产品合同；没有动态或生产验证。
- [outcome.go 395–445](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/taskmaterials/outcome.go#L395-L445)：撤销先更新状态与 purge_pending，正文异步清除；普通 live 读取检查状态、请求许可和批准许可。
- [subjectlifecycle/catalog.json 263–270](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/subjectlifecycle/catalog.json#L263-L270)：outcome-materials-v2 以请求者 subject_id 为导出归属，选择 body_text。
- [export.go 327–371](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/internal/subjectlifecycle/export.go#L327-L371)：通用 owner 查询得到该正文，只有 attachment 来源另调用 OutcomeMaterials 当前读取器；文字来源未走此检查。
- [生产接线 subject-lifecycle.go 58–92](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/go/cmd/galaxy-api/subject-lifecycle.go#L58-L92)：没有该文字数据集的专用 OwnerReader 或转换覆盖。
- [产品合同 data-and-files.md 28–30](https://github.com/agigalaxy-team/agigalaxy/blob/9fa17ee2b74c621303c598fcd272f8c38f4b9b8f/docs/product/data-and-files.md#L28-L30) 明确受控派生正文撤回/到期后先停读再清理，导出按当前许可。导出票据 cutoff 是创建时间上界，不是权限快照。

### 条件与影响

请求者曾获作者批准取得消息型成果材料，并有当前有效 data-export 凭据和导出票据。作者之后撤销批准许可、材料撤销或到期，但正文仍在数据库时，新的导出页可能返回该正文，即使普通读取已判不可用。不是读取从未批准过的材料，不是任意跨主体访问，也不是撤销已经合法下载到外部的副本。只讨论撤回后再次向服务器取正文。

### 修复与验证

文字与附件导出都经过所属领域的当前授权读取器；不可用时仅保留允许导出的元数据回执，移除正文，不依赖异步擦除及时性。保留原 requester 范围和 cutoff 限制，但不要把 requester 等同作者或永久复制许可。

隔离回归以合成作者 A、请求者 B 和有限期限许可覆盖撤销材料、到期、撤销批准 consent、撤销绑定四条路径；在暂停清理的条件下，普通读取和所有导出/MCP 页均不得返回正文。另测有效许可、不同请求者与真正本人创作的正例。未执行该回归。
