<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/4d/4d695f5b482236dd85644113f3b88602523348b682ba53b8b1ec66127fa3a9e5.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 当前客户端产物索引

2026-09-11：当前包为63源码/21入口/4固定依赖，SHA256与当前源码仍匹配，尚无正式公开发行。准确路径、包大小和本次签名/安装流程见[发行流水线](client-release-pipeline-v1.md)。

## 历史构建记录

以下保留各批次原文；其中“当前”只指当时构建，不替代上面的最新索引。

2026-09-10 Capsule增量：当前15导出入口，新增`/capsules`，显式会话支持11个已实现范围。旧tarball为当时快照，本批仅验证当前构建器。

2026-09-10 Honor增量：当前14个导出入口，新增`/honor`；复用history范围读取当前来源与公开规则。旧构建记录如下。

2026-09-10当前构建器：13个导出入口，新增`/moderation`；资格查询复用`/assistance`。本轮产物构建测试通过，未重新发行tarball。以下旧安装记录保留为当时证据。

# 独立客户端本地产物

**当前产物：** outputs/client-complete-1788961924103/galaxy-client-0.1.0.tgz，17源码、7入口、3依赖，17149字节；SHA256 d22d278f09ea8525f33c0ac66988e7d4b8edd394412762b9a7c650c331fdde41。新增/binding-status与/host-controller；local-host-runtime不进入轻量包。当前npm ci、npm pack、独立消费者安装/导入/无副作用预览及安装源码哈希比对均通过。下方旧数量及缺口保留为历史时点。

可复现验证：设置GALAXY_TEST_NPM_CLI为npm-cli.js的绝对路径，运行npm run test:client-install。脚本使用新的临时构建和消费者目录、空user/global npm配置、offline/ignore-scripts/no-audit/no-fund；失败明确退出，不访问凭据或全局改配置。成功产物及verification.json保留在新的outputs目录，临时消费者清理。已有缓存是前提，缺失依赖缓存会失败。

更新：新增/session-memory入口，当前生成15源码/5入口，仍3依赖。新包见outputs/client-session-d0-09-20260909，隔离npm ci与新增入口验证通过；下方14源码/4入口安装记录保留原时点。

构建入口：`node scripts/build-client.mjs ABSOLUTE_NEW_DIRECTORY`。目标必须为尚不存在的绝对目录，脚本拒绝覆盖。构建使用当前仓库TypeScript解析器检查静态导入与re-export，禁止动态加载；源码/平台/第三方依赖均在显式白名单内。意外引入数据库或签发模块会中止构建，不能仅凭包名判断隔离。

产物为`@galaxy/client`，当前private=true，不允许npm发布。导出仅包含`/discovery`、`/connection`、`/consent`、`/verification/connection`。源码仍以原模块为准，生成的lib副本不可手改；source-hashes.json供版本与漂移核对。

只保留14个源码模块，外部依赖为jose 6.2.12、ipaddr.js 2.5.0和zod 4.5.4。版本、integrity和公共registry来源来自现有Official锁文件；构建遇到新增传递/可选/peer依赖或安装脚本时要求显式审查。没有服务端数据库、签名私钥处理、MCP Server、worker或数据库迁移模块。Core只复用纯GUID/Genesis模块，不引入本地存储。

## 隔离安装验证

本次在新的临时目录构建，使用空user/global npm配置及`--offline --ignore-scripts --no-audit --no-fund`执行npm ci，然后npm pack，再在第二个消费者目录安装tarball。消费者仅出现`@galaxy/client`与上述三个包。

实际消费者导入四个公开入口，验证封装路径不能通过包导出直接访问；禁止DNS/HTTPS和本地凭据回调后，连接与Consent的prepare/cancel仍通过。此项证明隔离安装及无副作用预览，不证明远程服务、宿主集成或生产TLS。

`scripts/test/client-artifact.test.mjs`检查确定性源码哈希/锁文件、允许的依赖和导出、覆盖拒绝及动态导入拒绝，纳入根测试入口。安装测试使用原依赖缓存，没有购买服务、接触凭据或访问远程主机。

## AI Agent使用与部署边界

先在源码仓锁定依赖并运行统一检查，再向一个新的目录构建；使用该目录package.json和package-lock.json发现准确环境要求。当前构建/验证用Node 24.19.0；声明的Node>=22.13.0范围尚未逐版本安装测试。不要把最低engine声明当作完整矩阵证明。

在新环境配置npm的明确公共registry或经授权的缓存，禁用依赖生命周期脚本；此处不需要任何账号密钥。安装后检查依赖树与source-hashes，再运行客户端接口验证。不要对原工作区node_modules执行清理，或修改全局npm配置。

宿主运行时另需可信pin、明确用户确认、本机签名和当前授权回调；凭据通过安全存储接线，不写入package配置、Connection Profile或普通日志。发现调用可能保存公开信任缓存；仅导入不会发现/绑定/初始化。取消/超时不代表远端撤回，未知结果须通过状态恢复流程处理，不能自动重发。

本地tarball位于`outputs/client-d0-09-20260909/`，已被仓库输出目录规则忽略。源代码变更后应重新构建到新目录；旧tarball只是对应时点证据。D0-09仍缺宿主确认/凭据安全存储接线、真实HTTPS和恢复流程，不以产物安装成功宣称全项验收或上线。
