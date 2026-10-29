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
