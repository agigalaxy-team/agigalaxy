<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/52/5278c7f886d19f45b31e5e63b5887541e9dae5331913adced00706c6405d2253.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 分层自动验证

`npm run check:layers`执行10层；或`node scripts/verify-layers.mjs --layers=fast,tls`只选择明确层。保持原check入口兼容。每次创建新的outputs/layer-check目录，report.json逐层原子更新，每层独立日志。

| 层 | 范围 | 前提 |
|---|---|---|
| requirements | 来源、阅读包、图与旧197项只读检查 | Python>=3.10；匹配项目资料 |
| host-contract | 宿主接口模拟与本地MCP契约，不含真实宿主渲染 | Node及项目依赖 |
| fast | 全部当前Core/Official/工具测试及lint，含浏览器演示模块 | Node>=24.13、项目依赖 |
| adapter | 原生Adapter TypeScript检查 | TypeScript依赖 |
| core-runtime | 当前Node下真实本地读写/恢复与并发 | Node |
| postgres | 独立临时真实PG、权限、并发及恢复 | GALAXY_TEST_PG_BIN |
| proxy | 真实本地Caddy转发和配额 | GALAXY_TEST_CADDY_BIN |
| tls | 真实本地HTTPS证书/主机名与异常 | GALAXY_TEST_OPENSSL_BIN |
| client-install | 新消费者离线安装和源码哈希/导出边界 | GALAXY_TEST_NPM_CLI及已有依赖缓存 |
| web-build | 现有网页构建脚本 | GALAXY_TEST_NPM_CLI |

工具变量须为绝对路径（PG为bin目录，其余为可执行/CLI文件）。缺失前提记blocked且整体选择结果非零；未选择记not-run，失败记failed，只有进程真实退出0才记passed。失败不会把后续层省略为通过，仍继续执行后续安全层。selectedPassed仅覆盖选择集，automatedComplete要求全部自动层通过；releaseReady永远不从此脚本推定。

长于180秒标记overdue并保留PID/运行态，等待原进程完成；不会为显示超时就杀死数据库或代理测试并遗留服务。各测试内部自己的时限仍有效；通过结果保留超时提示与耗时，不能把overdue当成进程已终止。观察中断时核查同一任务句柄及报告，不重复启动原层。

人工真实宿主/真实用户验收、生产发布独立列出。即使全部自动层通过，也不能视为真实用户价值、生产容量或远程在线证明。当前Node层不替代Bun或所有最低版本矩阵；未运行的平台仍需单独记录。所有数据库、密钥与业务数据均为测试专用，脚本不接受生产数据库URL。

自动日志只适用于仓库内受控检查。不要把任意处理真实凭据的外部命令塞进该runner；诊断输出应在产生处脱敏。输出限1MiB，不输出环境变量；临时服务由各层既有finally清理。关闭宿主或强制终止整个机器不能假定清理完成。
