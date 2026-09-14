<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/c7/c7f924827866b720129e8e1a5ea64bf6a952c0780ee6b1095e9a1969fb025193.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 原生宿主包发行流程

`scripts/native-host-release.mjs` 复用 `release-artifact.mjs` 的标准 JWS/Ed25519，补齐原生包的签发与独立字节核验。便携客户端默认仍只接受 `@galaxy/client`；原生消费者必须显式传入 `expectedPackage: '@galaxy/native-host'`。两种清单不能混用。

## 当前候选

`outputs/native-release-20260911-1/` 包含 `galaxy-native-host-0.1.0.tgz`、`release.jws`、`release.json`、`host-acceptance.json`、锁文件、源码摘要、候选回执与验证记录。tarball 为 181871 字节，SHA-256 `13b32760166cef9b98a3ba433d0856c89fc782e3b0fe71ccbe45bd03dbae0e89`，内容与独立安装的候选 5 完全一致。

签名清单为 `galaxy-native-host-release`；绑定包摘要/字节数、版本/入口/固定依赖、锁文件/源码清单摘要，以及 `galaxy-native-host/1` 宿主报告摘要。报告只带实际检查范围、版本、终端尺寸、事件数和原报告摘要，不携带本地路径、终端内容、身份、环境变量值或私钥。

实际使用 5 份同一安装目录的 OpenCode 1.18.29 / Windows 报告：80×24 初始化 21 状态、120×40 初始化 21 状态、80×24 数字键初始化 34 状态、旧配置 10 状态、离线 11 状态，共 97。离线场景通过已记录摘要的合成 wrapper 精确绑定该安装目录的 `configured.js`。这些是本地实际宿主与合成身份检查，不证明真实用户体验、全平台覆盖或第三方认证。旧候选 3/4 的绑定/切换报告不会混入候选 5 的签名报告。

本次 `purpose=local-validation`，`publicationReady=false`。演练私钥仅在进程内；`verification.json` 中的 public JWK 只用于复核此一次演练，不构成正式发行信任。

## 调用与部署接续

1. 发现已安装的 Node ≥24.13、绝对路径 tar、明确候选目录、独立安装目录和同包宿主报告。标准 tar 只列出及读取成员，不执行包代码或解压到磁盘。
2. `inspectNativeHostCandidate()` 核对当前源码、包内 13 个普通文件、9 个 JS 和独立安装内容；源码变化应重建候选并重新取得对应宿主证据。
3. `prepareNativeHostRelease()` 接受上述路径、新输出目录和 `releaseConfigurationFactory`。工厂返回 `{publisher, purpose, kid, privateKey, trustedKeys, now, lifetime}`；正式 publisher、密钥提供者与公钥信任由调用方明确注入。代码不会搜索凭据或自行发布。
4. 下游通过 `verifyRelease(jws, {trustedKeys, publisher, artifact, report, expectedPackage: '@galaxy/native-host', now})` 校验。信任项为 `{publicKey, notBefore, notAfter, revoked}`，秒时间戳；有效期最长 30 天。包或报告变更、错包、错 publisher、撤销或过期均拒绝。
5. 核验成功后再在独立目录安装并由宿主切换。保留旧包和本地 Galaxy ID；回退到已验证版本，不执行 init/reset、不修改全局 OpenCode 配置。

`currentRevocationChecked=false` 表示只核对调用方当前给出的撤销状态；未在线查询新撤销。当前生成器的证据输入是本地受信工作产物，哈希只能绑定材料，不能独立证明报告诚实。人工复核与正式发布渠道仍是原计划条件。

一次性演练入口为项目 `05-build/tools/prepare-native-signed-candidate.mjs`，已经执行，不要重跑并覆盖现存结果。复核现有结果可读取保留的演练公钥，在签发时刻验证历史签名；不能据此把过期演练当当前正式发行。没有新增公开下载或占位安装命令。

## 验证

`node --test packages/galaxy-official/test/release-artifact.test.mjs scripts/test/native-host-release.test.mjs`：3 项通过，覆盖便携格式兼容、原生显式包类型、签名/材料篡改/撤销/时限与证据脱敏。`node scripts/check.mjs lint` 通过。实际候选另通过包篡改、报告篡改、错包、撤销键 4 类负例。

本次没有重跑全部项目测试或真实宿主矩阵；111 个原生源码和现存候选/安装字节均未变化。便携客户端旧 Conformance 是其历史源码时点的证据，不能说它覆盖本次发行模块变化；下一次正式构建须取得新匹配报告。
