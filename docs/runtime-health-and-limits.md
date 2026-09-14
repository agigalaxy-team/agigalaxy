<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/8a/8ab4fa6cbfd16dc1178edcdf3e83c8eb41f003b510385dcc54e316859310aa74.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 运行健康、超时与资源边界

2026-09-11后续切换：包含下述停止修复的361文件 `official-2026.09.11-drain` 已在私有integration安装，完成升级/回退/再次升级，现已选中并停止待显式启动。旧发行与数据保留。费用采集器随后修正汇总时间字段处理，属于可选运营脚本的源码更新，未混入本次已冻结发行；目标费用timer未启用。当前入口见[Linux运行说明](linux-deployment-v1.md)。

2026-09-11当前交付：修复 Worker 在 SIGTERM 后仍从目录探测/搜索队列领取新任务的问题。清理、证据验证、探测、搜索播种和刷新之间检查停止状态；当前任务仍按原有事务/重试规则结束，停止后的等待不再额外延长退出。

新增 `test/postgres/interruption.test.mjs`：实际 Worker 连接独立 PostgreSQL18.6 和带正常证书校验的 HTTPS 服务，分别检查抓取期间优雅停止、抓取期间 SIGKILL、PostgreSQL 执行 COMMIT 时 SIGKILL。两种平台均通过三种场景（测试输出含父项共4项）；另4项停止截止/依赖边界及 lint 通过。Linux 使用真实 OS SIGTERM/SIGKILL、非root UID1001；Windows 的优雅停止由测试 IPC 调用 SIGTERM 处理器，强制退出实际终止进程。HTTPS 仅在测试预加载文件内路由至可控本地服务器，没有向 GitHub 提交请求，不证明实际 GitHub 可达性。

提交中断的实测结果值得保留：Worker 被杀后，数据库仍提交成功；重启前核对记录，最终观察和观察审计各只有一条。不能以进程退出推定回滚，也不能换新 ID 重发。抓取中断后的租约由测试显式提前到期，验证现有回收分支；生产30秒租约、5次证据重试、15秒退出截止均未修改。授权被撤销后重启不会再次抓取该来源。

复现：配置已有 `GALAXY_TEST_PG_BIN` 与绝对路径 `GALAXY_TEST_OPENSSL_BIN`，设置 `GALAXY_TEST_PG_CASE=interruption` 后运行 `node packages/galaxy-official/scripts/test-postgres.mjs`。该入口新建合成集群并清理，不接受外部数据库URL；Linux目标演练使用项目工具 `05-build/tools/run-linux-interruption.py` 建立独立临时容器，校验选择的主机、输入文件和清理范围。测试预加载不属于生产服务发行。

此修复已在当前源码及Oracle临时Linux环境验证；之前安装且处于停止状态的固定integration发行仍是旧版本，切换新发行另记。正式容量/成本、公开网络提供者与真实用户验收继续保留，不能由本次受控中断测试替代。

2026-09-10更新：API readiness新增失败审计持久队列的可写/余量检查；不健康返回503并尝试记录失败。正常停机在关闭数据库前关闭交付队列，整体15秒截止不变，未确认项留待重启补写。详见[失败审计交付](failure-audit-delivery-v1.md)。下文保留此前逐批验证记录。

C01-06核对结果。/healthz只报告HTTP进程存活；/readyz还调用数据库与签名信任有效期检查。两者都不能表示业务闭环、备份可恢复或远程持续连接。

本批新增boundedReadiness：默认2秒响应期限，最长允许配置10秒；相同未完成检查只执行一次，超时后新请求立即得到不可用，直到原检查真正结束才允许新探测。期限不是取消数据库操作，因此不把超时后的未知执行结果视为已取消；原操作卡住时不会无限启动新操作。检查异常或非严格true结果统一503 unavailable，不返回后端详情。数据库自身保留连接与语句超时。

已存在的限制：API连接数据库池最多8，连接超时5秒、语句10秒、空闲30秒；HTTP请求/头部接收10秒、keepalive5秒、最多40头、body32768字节。接收超时不是所有业务处理的总时间上限。普通HTTP配额默认60/分钟，探测120/分钟，地址窗口容量10000；这是单进程配额，不是分布式全局配额。

API收到停止信号后关闭监听，最多10秒后关闭现有HTTP连接，再结束数据库池；从首次停止开始15秒为最终退出期限。Worker会停止取下一项并等待当前工作和数据库清理，使用同样的15秒截止时间。重复信号不延长截止时间，正常完成清理取消定时器，超时以状态码1退出。API启动失败后的数据库清理也受此期限约束。不能因为有SIGTERM处理器就标完整优雅停机已验收。

剩余：真实服务与OS信号下的整体停止验证、OS内存/CPU/文件描述符和数据库存储配额、持续运行与负载容量、跨实例配额。部署需进程监管器明确终止时限并保留事务恢复语义；不得在数据库写入未知时自动重试。

AI-agent验证：node --test packages/galaxy-official/test/http-policy.test.mjs packages/galaxy-official/test/http-routes.test.mjs；node scripts/check.mjs lint。新增测试同时发送8次readiness请求，确认仅一次后端执行；超时后health仍可用，后端结束后可再次检查。故障输出保持无秘密。本批未修改数据库迁移、Worker重试逻辑或主机设置。


停机机制专项：shutdown-deadline.test.mjs实际创建子进程，检查永不完成的清理及重复start最终退出1、正常finish退出0；含无效超时范围拒绝。与环境/Worker边界共7项测试及lint通过。该测试未启动真实API/Worker，也不证明信号送达或事务结果；主机监管仍需兜底，阻塞事件循环时JS定时器无法按时执行。

超时退出并不等于业务操作未提交。重启后需按现有幂等ID、撤销状态及Worker租约核对结果，不能自动以新ID重发或恢复旧授权。此批未修改任何迁移或重试规则，没有远程部署。


新增真实入口演练：test/postgres/lifecycle.test.mjs由test-postgres.mjs在新建SCRAM集群内顺序运行。实际启动server.mjs与worker.mjs，等待API readiness和两个进程的数据库连接，停止后核对退出码、pg_stat_activity无残留、迁移版本不变且空数据库未产生Case事实。临时签名键与信任材料仅保存在测试临时目录，finally清理。测试使用隔离管理员连接并以PGOPTIONS切换受限角色，不声称验证独立生产登录账号。

Windows子进程通过--import加载仅测试使用的stop-channel.mjs，经IPC派发SIGTERM处理器并断开IPC；POSIX分支发送真实SIGTERM。Windows结果只覆盖处理器与实际服务退出，不证明系统服务管理器信号。该演练当前只验证空闲Worker，不包括运行中的证据任务、事务提交瞬间或故意挂住真实服务的强制退出。

启动故障定位：API启动失败事件新增固定phase字段，仅输出environment/endpoint/signing-key/trust/listener-config/database/database-role/services/listen之一，不记录配置值。运行时加载失败发生在应用catch之前，测试启动器不得输出原始错误以免泄露继承配置。Windows预加载使用file URL，不能直接传C盘路径给--import。


运行中队列演练扩展：先通过实际Case/Attempt/Result/Consent/Evidence服务生成两项合成任务，并撤销证据授权；以独立事务锁住jobs表，等真实Worker在pg_stat_activity中显示Lock等待后触发停止，再释放表锁。预期当前任务完成并退出，另一项保持pending且attempts=0；重启Worker后处理剩余任务。核对观察数恰好为2、Evidence均revoked、Proof为0且无残留连接。这覆盖数据库领取期间的停止恢复，仍不覆盖外部HTTP抓取中断或事务提交瞬间强制杀进程。

本次执行结果：上述领取阻塞/停止/重启演练通过；PG共3项通过，lint通过，临时集群清理完成。合成任务available_at显式置于过去，避免整秒领取时间与刚入队的毫秒时间造成未到期假设。停止后completed/attempts=1与pending/attempts=0各一项，重启后观察恰好两条、Evidence均revoked且Proof为0，无残留连接。
