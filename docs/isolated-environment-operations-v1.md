<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d5/d58873ad93681868814bb24e116a0828e56465193315ab37c3c1858ae0d4caac.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 已安装的三套隔离环境

2026-09-11 在选定 Oracle 主机补齐 `local`、`pilot`。它们与原 `integration` 使用不同的 Linux 用户、数据库集群、命名卷、登录口令和签名根。这里的 `local` 是同机 Linux 开发环境；没有在 Windows 安装 Linux 服务，也不代表三个独立故障域。

|环境|配置与秘密目录|API 私有目录|PostgreSQL / API|实际运行结果|
|---|---|---|---|---|
|local|`/etc/galaxy/local`|`/var/lib/galaxy/api/local`|15332 / 3001|迁移、API/Worker 启动、刷新 keyring 后再次启动通过；现已停止|
|integration|`/etc/galaxy/integration`|`/var/lib/galaxy/api/integration`|15432 / 3101|本次只启动数据库核对隔离；原身份与配置保持，现已停止|
|pilot|`/etc/galaxy/pilot`|`/var/lib/galaxy/api/pilot`|15532 / 3201|独立材料与数据库迁移完成；API/Worker 未启动，现已停止|

API、指标和数据库模板均为 loopback。三套数据库实际迁移到 Schema 41、各 44 张表；9 个数据库角色可在各自集群登录，API/Worker 不是管理员。3 个实际 PostgreSQL system identifier 不同，6 次跨环境 API 登录全部拒绝。9 个口令在目标内存中比较为独立值，6 个根/服务公钥指纹不同；报告只记录数量和公钥指纹。

共 9 个 API/Worker/迁移 Linux 用户具有不同 UID。对应 API 用户能读自己的签名键，其余 42 次选定秘密文件读取被系统权限拒绝。应用用户不能直接读根私钥或角色 EnvironmentFile；systemd 按角色注入配置。Docker 管理员仍具有主机级权限，不能把这种隔离描述为多个主机。

部署候选在 `/opt/galaxy/deployments/environments-20260911-2`，共 46 个文件：原 43 个配置文件、摘要索引及两个安装/核对脚本。复用 `/opt/galaxy/releases/official-2026.09.11-cost` 的 363 个固定文件和既有锁定依赖；发行摘要为 `2f200f5a140c0c56b1455a061a0992014eda19cd50210f98a00873a820f1743b`。`GALAXY_CONFIGURATION_VERSION` 沿用该固定发行的 `integration-2026.09.11-cost` 标签，这是发行配置兼容版本；实际环境由独立的 `GALAXY_ENVIRONMENT`、目录和数据库决定，不能擅自改标签绕过发行匹配。

新环境的五份公开策略分别位于 `/var/lib/galaxy/config/local` 和 `/var/lib/galaxy/config/pilot`。旧 integration 配置未被新版模板覆盖。开发环境使用明确的技术测试名称；pilot 保留运营者字段缺项，预算仍是开发默认值。试点根/服务键是尚未公开的候选材料，尚未建立公开信任或真实用户关系。

## 启动与停止

签名清单有效期为 24 小时，根键有效期为 365 天、服务键为 90 天。新入口仅用现有键刷新清单，不生成新身份、不轮换密钥、不更新根/服务键的有效期。它核对原回执指纹、清单签名及历史序号，拒绝撤销或过期密钥。根/服务键到期时需单独处理轮换。

开发环境启动前，在选定主机执行：

```sh
sudo /opt/galaxy/runtime/node-v24.19.0-linux-x64/bin/node /opt/galaxy/operations/refresh-isolated-keyring.mjs local
sudo systemctl start galaxy-database@local.service
sudo systemctl start galaxy-api@local.service galaxy-worker@local.service
curl --fail http://127.0.0.1:3001/readyz
```

停止保留全部卷和材料：

```sh
sudo systemctl stop galaxy-worker@local.service galaxy-api@local.service
sudo systemctl stop galaxy-database@local.service
```

pilot 的刷新参数为 `pilot`，不会启动任何服务。正式运营配置、服务业务与外部 HTTP/TLS 验收属于 C00、C01-07/08 和发布门槛；完成前不按开发默认值启动公开试点。现有 integration 启动入口保持原样，见 [Linux 部署说明](linux-deployment-v1.md)。

此次 local 和 pilot 的 keyring 均从序号 1 刷新为 2，密钥指纹不变；local API 实际再次返回 200，并把序号 2 写入信任状态。检查结束后三环境 9 个数据库/API/Worker 单位均为 inactive。没有 enable 新服务、修改 Caddy/DNS 或启动 pilot 业务；官网仍返回 200。每套全部服务的内存上限约 7 GiB，三套总上限约 21 GiB，高于本机约 19.5 GiB 内存，不安排三套完整服务同时常驻。

## AI-agent 接续与恢复

- 原始入口为 [安装脚本](../../../tools/install-isolated-environments.py)，它针对本次准确目标首次执行，已经运行成功。已有目录或报告时拒绝再次安装；不能通过删报告、删用户、删卷或覆盖秘密来重试。
- 源码侧的 `.env.example` 和候选配置声明不含真实材料，也不会被改写成秘密文件。实际新材料仅保存在目标主机；不要下载、打印、索引 EnvironmentFile 或私钥。
- 需要核对独立性时先启动三套数据库，再以 root 运行候选目录内 `verify-environment-isolation.mjs`，最后停止数据库。它会实际登录并进行 6 次预期失败的跨环境认证，报告输出不含口令。
- 运行配置未齐、迁移失败、keyring 刷新失败时，保持对应业务进程停止并读取选定的无秘密结果。`keyring.next.json` 存在表示先前写入中断，应核对后继续，不自动覆盖。
- 本次首次安装已证明新环境可从空目录和新卷重建。旧 integration 的重启/撤销恢复证据继续适用其原范围；本次没有用开发环境的空数据库代替真实业务恢复验收。异地备份、公开发布与人工验收仍未完成。

证据：[安装与权限/数据库隔离](../../../GALAXY_ISOLATED_ENVIRONMENT_INSTALL_2026-09-11.json) · [刷新与再启动](../../../GALAXY_ISOLATED_KEYRING_REFRESH_2026-09-11.json)。
