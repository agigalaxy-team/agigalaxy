<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/c1/c18739d7752469e5c78e60ef8bc7520ab91586502453937fea5c57aaf99d07ca.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 当前客户端发行流水线 v1

2026-09-11原生交付补充：便携 `@galaxy/client` 不包含本机签名/原生TUI；新增独立 `@galaxy/native-host` 本地候选补齐这一部分，已离线安装并在真实OpenCode运行五场景。该候选尚未正式签发，不能套用下文便携包的签名或摘要。见[原生宿主包](native-host-package-v1.md)。

2026-09-11：复用原构建器、离线安装消费检查和jose签名，实现单次候选生成。当前为可复核的本地交付；正式发布方、可信发行键、真实宿主矩阵与公开下载仍按原计划处理。此处不会以临时测试密钥冒充正式签发者。

## 一次执行

在代码仓根，用现有Node>=24.13和本机npm CLI：

```powershell
$env:GALAXY_TEST_NPM_CLI = '<实际npm-cli.js绝对路径>'
node scripts/prepare-client-candidate.mjs
```

`npm run prepare:client`是同一入口。执行顺序是固定七类Conformance → 源码匹配 → 构建允许范围内的包 → 离线npm ci/pack → JWS签名与预置公钥验证 → 独立消费者离线安装/导入 → 再确认源码未变化 → 写入candidate.json。只执行一次报告与一次安装；CLI默认签名purpose为local-validation，私钥仅在进程内使用。

脚本不会读取凭据中心、注册用户、连接Official、安装全局插件或发布npm包。缺少依赖缓存时明确失败。导入流水线模块不会运行构建；原`test-client-install.mjs [report.json]`调用方式仍保留。

## 调用方正式签名接线

`prepareClientCandidate({npm, releaseConfigurationFactory})`接受调用方函数；报告通过后才取得一次签名配置。配置字段复用已有`createClientRelease()`/`verifyRelease()`：publisher、purpose、privateKey、kid、trustedKeys、now、lifetime。正式候选使用release-candidate目的，trustedKeys由调用方独立固定；密钥通过进程内KeyObject或受控供应方注入，不写入CLI参数、项目或报告。

底层`buildAndVerifyClient({npm, reportBytes, releaseConfiguration, outputRoot})`可消费已经完成且仍匹配的报告；报告与签名配置必须同时提供。它复用现有构建与独立消费者，没有另写打包器或签名协议。签名核对包、报告、来源清单、依赖锁、发行者与有效期；退出前输出实际消费结果。

真实提供者/下载渠道尚未接入，因此即便调用方键验签通过，候选也保持publicationReady=false、productionTrustEstablished=false。签名正确不等于签发者已获正式授权；实际发布流程须核对发行身份、目标宿主与发布范围。

## 本次实际产物

[本次目录](../outputs/client-complete-0d848fb3-a56d-4e86-8062-20ebce48a4d3/candidate.json)包含：

- `galaxy-client-0.1.0.tgz`：63188字节，SHA-256 `e76c5329706d43265fd5952714ba84ad44ee60185581f73e0235050cb5c0fc56`。
- `release.jws`、`release-manifest.json`：临时local-validation签名，绑定上述包与实际报告。
- `conformance-report.json`：runner2.1.0、七类/13文件/31项测试，全部通过；478项源码/输入摘要。
- `package-lock.json`、`fixture-public-key.json`、`verification.json`和`candidate.json`：独立安装与消费记录，测试公钥只用于复核本次演练。

包仍是63源码、21入口、4依赖。此批更新了包内说明，明确identity入口是关联客户端而非OAuth服务器；已有本机ID和初始化不变。之前63128字节的包与71.6%阶段记录保留为历史产物，不能替换其原始摘要。

## 源码失效与兼容判断

runner2.1.0补入公共文档JSON、API目录定义、Caddy路由、公共文档生成器、版本约定与原生TypeScript入口/类型文件。新增这些输入或修改其内容都会改变报告目标摘要；报告不匹配时不签发当前候选。这里的478项是来源范围，不表示执行了478项测试；实际执行31项固定用例。

既有Registry兼容报告继续核对当前声明、Suite版本/来源/摘要/有效期和撤销、签发键、Consent与调用权限。来源变化或签名撤销后的失效已有当前Conformance工作流验证。报告仍不宣称第三方独立执行或通用能力认证。

[Core实现说明](core-spec-v0.1.md)与[协议/宿主矩阵](protocol-support-v1.md)描述对应范围；旧runner2.0.0报告保留原有效范围，不改写为2.1.0。新发行使用当前报告，不把旧报告签名重贴到新包。

## 升级、回退与后续发布

先保留已验证旧包及其摘要/签名/报告，在独立目录安装新包，再由宿主显式切换。升级不调用init/reset、不重新生成ID；回退客户端也不执行数据库降级。真实宿主切换、平台矩阵和用户体验仍待人工。

下一步对接选定的正式publisher/信任根、具体发行渠道和支持宿主；公开站点只在实际包、签名和下载可核对后增加安装入口。C03-02继续进行中。本地C15开发交付可复核，不据此修改公网服务状态。
