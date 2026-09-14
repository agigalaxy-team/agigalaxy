<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/bd/bd42b07c8ce56726bbc88e29090f0c1614536f4a72fce10ec2fc600fe1b002e3.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 隔离真实TLS验证

设置GALAXY_TEST_OPENSSL_BIN为OpenSSL 3可执行文件绝对路径，然后运行npm run test:tls。缺少前提会失败，不静默跳过。本次使用OpenSSL 3.5.5和Node 24.19.0。

测试生成临时密钥和带SAN的自签名证书，启动仅监听127.0.0.1随机端口的真实HTTPS服务。证书仅通过该测试请求的ca选项信任，不安装系统CA，不设置NODE_TLS_REJECT_UNAUTHORIZED，不覆盖checkServerIdentity。公用出口仍执行公网地址检查；测试仅在平台request边界把固定逻辑主机路由到本地套接字。密钥不写入仓库或日志，退出清理专用临时目录和套接字。

验证真实加密请求的匿名GET、显式认证GET与握手POST；不受信任证书和错误主机名在HTTP业务请求到达前失败；混合公私DNS被阻止；真实重定向、超量响应、超时、取消均不重试。它不证明公网DNS/路由、Oracle TLS/Caddy配置或生产证书续签。实际部署仍需对应清单实测。

TLS层另有依赖，因此与统一快测分开报告。当前3项均通过；测试入口packages/galaxy-official/test/tls/public-tls.test.mjs。

实现参考：[Node HTTPS请求的TLS选项](https://nodejs.org/api/https.html#httpsrequesturl-options-callback)支持按请求设置ca等TLS参数；[OpenSSL req](https://docs.openssl.org/3.5/man1/openssl-req/)用于生成测试证书和SAN扩展。这里采用的是隔离测试信任，不改变生产验证策略。
