<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/6e/6e714d874eae5a82c3bbb344ba6ccbc83febdd9996036b4435623d264f41ac66.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 确认后发送的Consent客户端

当前实现：`packages/galaxy-official/src/consent-client.mjs`。这是D0-09的一条受控写入路径；不表示binding/session客户端、宿主远程界面或独立客户端发行已完成。

`createConsentClient`由可信宿主组合入口提供endpoint、readAuthorization和signIntent。创建和prepare不会加载身份、读取凭据、签名或访问网络。prepare使用现有Consent schema及强制策略校验，复制输入并生成不可修改的预览；宿主必须展示完整intentJson，其中包含对象、字段、用途、接收方、可见性、有效期和payloadHash。

宿主在用户明确确认后调用execute，并原样提供预览对应的confirmation。该确认文本是程序侧绑定预览的机制，不是用户认证证明；宿主不得自行填写以跳过用户确认。伪造/复制预览对象、错误确认文本、重复执行或已取消操作均拒绝。

readAuthorization每次返回当前subjectId、bindingId、scopes、expiresAt、revoked和credential。适配器必须从当前可信本地会话状态读取，不能缓存永久有效的布尔同意。客户端在签名前后核对主体、binding、consent scope和有效期；signIntent只负责对提供的准确JSON使用`galaxy-consent+jws`类型签名。它应使用用户本机密钥，不能接入服务端签名密钥或在此初始化新身份。

发送通过public-fetch的共同公共网络出口：HTTPS、无URL凭据/查询/片段、公共IP/DNS检查、固定解析结果、正常TLS主机验证、禁重定向、有限响应体和超时。GET不携带POST凭据。send参数仅供可信测试/组合入口替换，不能由远程Manifest或普通用户输入指定。

每次执行最多发送一次POST /v1/consents。取消可阻止尚未调度的请求；已发送后的取消或超时不保证服务器回滚，因此操作不会自动重试。同一预览不能重新执行；应先检查远端结果，再由用户决定是否建立新预览。调用者不得把超时理解为“服务端没有接受”。

本机在签名期间撤销/到期/切换主体时不发送。最后一次本地检查之后的撤销竞态由服务端当前认证及事务授权保证；测试覆盖在dispatch边界服务端撤销binding后拒绝写入。客户端不会以本地检查替代服务端检查。

响应必须只有consentId、status和intent，状态为active且ID一致；返回intent重新经过严格schema校验，与预览所有字段比较。响应字段重排不改变含义，扩大scope相关字段、延长时限、替换主体/接收方/摘要或附带未定义字段都会拒绝。响应通过后再次读取本地授权；发现撤销或到期不会显示成功。异常响应可能对应已经提交的远端事实，仍不得自动重试。返回值是核对后的服务端确认，不是独立Evidence或永久有效授权。

## 验证与剩余范围

`consent-client.test.mjs`覆盖预览无副作用、输入修改隔离、精确确认、重复/取消、签名中撤销/到期/主体改变、不自动重试及真实业务服务的签名接收和撤销拒绝（PGlite合成数据）。

`public-transport.test.mjs`只替换平台DNS/HTTPS I/O，运行真实出口逻辑，验证DNS固定、混合公共/私网结果拒绝、DNS期间取消、POST凭据/GET隔离、重定向/压缩/超限响应拒绝及发送后中止。它不证明真实TLS或云网络配置；没有为了测试放开私网或禁用证书验证。

仍需：独立轻量包的安装依赖边界、binding/session宿主确认与安全存储接线及实际HTTPS集成验证。D0-09保持进行中。未改/galaxy冻结布局或发布远程功能。

## Binding/session验证模块

`src/verification/connection.mjs`提供四个无网络、无签发逻辑的验证函数。每次调用必须提供明确当前秒数now，issuer/audience和pin来源于可信配置。

- verifyBindingChallenge：与本机已确认request逐字段比较，核对挑战ID、clientSession摘要、用途、端点及binding期限。
- verifyBindingReceipt：核对bindingId、主体、公钥指纹、安装ID、scope、撤销路径和challenge审计关联，回执JWT到期必须等于批准的binding到期。
- verifySessionChallenge：核对已验证binding、当前客户端生成的credentialHash、scope、用途和不超过600秒/绑定期限的凭据有效期。
- verifySessionActivation：核对challenge绑定的ID、scope和准确期限；过期挑战不接受为当前激活结果。

request、challenge、binding分别由可信本地预览和前一步验证输出提供，不能使用响应里自声明的“expected”对象替代。外层完整客户端仍须保存不可变快照、处理取消和安全保存凭据；这些纯函数自身不维护事务、重放缓存或远端撤销状态。它们不是已集成的宿主远程连接。

`connection-verification.test.mjs`使用真实服务生成挑战和回执，验证正向链路；再用有效服务端密钥签发被扩大/替换的字段，确认客户端仍拒绝。因此测试覆盖“密码学签名有效但不符合本机意图”，不只覆盖坏签名。

完整四步流程现见[连接客户端说明](confirmed-connection-client.md)，宿主接线和生产HTTPS仍待验收。
