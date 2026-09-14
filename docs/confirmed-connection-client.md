<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/2b/2bdc291226ebfc8d53cfe909fd368d74c86d64f146dee5727c844837af504cfb.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 绑定和会话连接客户端

`packages/galaxy-official/src/connection-client.mjs`把四个协议验证器接入连接流程；当前面向可信宿主组合入口，不会自动读取宿主配置或初始化Galaxy ID。

prepare仅接受本机已有subjectId、严格genesisProof、installationId与有限scope列表。沿用Core的genesis验证，不另造ID算法。预览固定端点、准确请求JSON、最长绑定/会话期限及五分钟本机确认时限；无联网、签名、凭据生成或落盘。用户确认后才调用execute，传入该预览的精确确认文本。宿主必须完整展示这些内容，不能程序化填入文本绕过用户。

execute依次执行：

1. POST binding-challenges；验证响应与准确请求、clientSession摘要及期望端点一致。
2. 本机签名原始challenge；重新检查时限与pin，然后POST bindings并验证回执。
3. 本地产生随机会话凭据，只提交其摘要到session-challenges；验证返回绑定ID、scope、摘要和时限。
4. 本机签名原始session challenge，再次验证后POST sessions；验证激活结果、回执及当前本地授权。

每个等待点后检查取消和当前授权；assertCurrent必须由可信宿主实现，结合当前本地意图、身份、已验证目标/Manifest、撤销及用户取消状态返回严格true。不能把网络内容中的许可字段当此回调。trustedKeys来自已有信任配置/验证链，不能从challenge自声明取公钥。

公共网络出口对这四个固定路径开放无Bearer POST，分别要求201/200/201/200响应。它不允许其他业务路径匿名写入，保留公共地址、DNS固定、正常TLS、不跟随重定向等限制。测试的loopback映射仅通过可信send注入，不改变生产网络规则。

成功对象含公开连接信息和takeCredential方法；凭据保存在闭包，JSON序列化不含它。可信宿主只能提取一次，必须使用安全存储或短期内存，不能写入Connection Profile、日志、MCP普通输出或项目文件。成功前没有凭据保存；本地取消、到期或重复提取返回空值。已经交给宿主的凭据仍需宿主管理与服务端撤销。

每个预览只能执行一次，没有自动重试。网络错误、取消或校验失败可能发生在服务端已创建binding之后；不声称远端事务回滚，不自动撤销绑定或重新生成身份。需要先确认远端状态再决定恢复。成功的会话也不创建Consent，不证明能力或Evidence。

自动测试使用真实本地HTTP API与合成PGlite数据库：四步正向链路、凭据在服务端认证、确认前无副作用、四个步骤的未知结果、错误/重复确认、取消、pin撤销及签名期间挑战到期。平台网络出口另外测试固定路径、凭据隔离及响应状态码。本地HTTP联调不等于真实HTTPS/生产TLS验收。

剩余：原生宿主确认与安全凭据存储接线、独立客户端包、实际HTTPS验证和连接状态恢复。因此D0-09仍进行中，没有发布或改变/galaxy冻结交互。

后续组合实现：[可信本地主机入口](local-host-runtime.md)已提供；默认用户级配置未安装该入口，实际HTTPS和宿主人工另验收。
