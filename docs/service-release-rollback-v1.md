<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/af/afc899d40d21cd0d4ac51047f494453999aae69ff83a554766c6a21f1e493ccf.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 服务发行与应用回滚 v1

C18-03：复用现有 Caddy validate/reload 执行切换；新增服务源码冻结、发行摘要固定、配置版本匹配和数据库兼容预检。动态 Official 尚未部署。

## 冻结发行

在代码仓根运行：

```text
node packages/galaxy-official/scripts/service-release.mjs capture <新发行目录绝对路径> <release-id> <configuration-version> <新回执绝对路径>
```

生成器复制 Official/Core 的 `.mjs`/`.sql` 源码、Official `package.json`、锁文件、公开 Docs MCP 内容、11 个运营脚本、Caddy 路由、退役/配额/费用/监控模板以及 `docs/**/*.md` 说明，保留原相对导入结构。`service-release.json` 记录文件长度和 SHA-256、API/Worker 入口、逐版 SQL 摘要、Node 最低版本、发行 ID 和配置版本。回执保存 manifest SHA-256，应在发行目录之外保管。

没有复制 `.env`、生产配置、身份文件、认证目录或 `node_modules`。在冻结发行目录的 `packages/galaxy-official` 运行 `npm ci --ignore-scripts --omit=dev` 安装准确锁定的运行依赖，然后完成该发行的适用验证。摘要固定的是清单内源码及锁文件，不能证明已安装依赖或主机环境未被修改。本地切换演练现在为两个发行分别执行离线冻结安装，不共享工作区的 `node_modules`；离线运行要求 npm 缓存已有锁文件所需内容，缓存缺失时检查失败。

命名资源统一登记在 [release-resources.json](../packages/galaxy-official/release-resources.json)：`service` 用于服务运行包，`source` 补充完整源码快照的 API 目录、测试夹具及规则场景。新增运营脚本/非源码资源时更新此清单，缺少条目指向的文件会终止打包。保持现有 v1 发行清单读取兼容；新资源不会被假定存在于旧包。

监控服务、定时器和配置文件是待配置模板，打包不启用服务或安装外部工具。Node、PostgreSQL、Caddy、restic、OCI CLI 和 Prometheus/Node Exporter 由部署环境单独提供。运行包不包含 PostgreSQL 测试入口；开发/恢复源码使用 `python scripts/create-release-baseline.py` 生成的完整快照。

不要覆盖旧发行目录。代码、配置版本和数据库版本分别记录；包版本 `0.1.0` 本身不表示两个发行源码相同，也不能据此放宽签名 Manifest 的版本规则。

## 运行时关联

API 和 Worker 支持下列独立配置；仍需提供原有环境/数据库/运营者等配置：

```text
GALAXY_RELEASE_DIRECTORY=<准确发行目录>
GALAXY_RELEASE_SHA256=<capture回执的manifestSha256>
GALAXY_CONFIGURATION_VERSION=<与发行清单一致的版本标签>
```

从发行目录内的 `packages/galaxy-official/src/server.mjs`、`worker.mjs` 启动。入口必须属于被固定的发行；源码或配置版本标签不匹配即拒绝启动。API 响应增加 `X-Galaxy-Release`，仅标识已核验的本次源码发行，不代表部署通过验收。已有未配置发行清单的开发启动方式保留，不返回该头。

新清单同时固定 `src/migrate.mjs` 迁移入口。可通过 `npm run migrate -- --roles=api,worker` 显式将 Schema 和角色 SQL 合并在同一事务内；使用独立管理环境，完成后再启动 API/Worker。旧清单的 API/Worker 兼容性保留，新增迁移模式及失败处理见[数据库迁移](database-migrations-v1.md)。

配置版本是运营者对独立配置的关联标签，不是配置内容摘要；实际秘密、可信根、撤销版本、数据库角色及环境差异仍须按配置渠道核对。发行目录在验证与运行期间应保持只读；校验不是对拥有目录写权限者的隔离机制。

## 切换/回滚预检

通过进程环境 `GALAXY_RELEASE_DATABASE_URL` 提供要检查的数据库连接，不写进命令行或回执：

```text
node packages/galaxy-official/scripts/service-release.mjs compare <当前发行目录> <当前manifest摘要> <目标发行目录> <目标manifest摘要> <新回执绝对路径>
```

预检实际读取数据库迁移序列及恢复隔离标记，并核对两个发行的文件摘要。目标发行必须支持**准确的当前数据库迁移序列**；共享迁移版本的 SQL 摘要必须一致。结果明确 `applicationOnly:true`、`databaseDowngrade:false`，仍保持 `proxyReloaded:false`、`runtimeVerified:false`。

预检是某个时间点的结果，不能作为永久通行证。迁移与切换应由同一运营操作串行执行，切换前重新预检；不要在预检和切换之间另行迁移。该命令不执行数据库升级、删除、降级、备份覆盖或代理切换。

兼容性规则采用当前服务实际的严格 Schema 支持范围。Schema21 数据库不能直接切到仅支持 Schema20 的程序；即使新增表看起来不会影响旧程序，也不能越过实际启动检查。此时选择已验证的前向修复，或使用 C18-01/02 在新隔离库恢复后处理数据和撤销；不把退回旧备份伪装成无数据损失的应用回滚。

## 执行与判断

1. 冻结当前与候选发行、记录配置版本、备份及隔离恢复结果；需要迁移时单独执行并验证。破坏性迁移未提供自动降级路径。
2. 在新端口启动候选 API，核对 readiness、发行头、签名 Manifest 和业务读写；Worker 按既有停止/租约恢复流程处理。
3. 通过 compare 后，使用已有 Caddy `validate`，再对已核验的私有管理地址 `reload`。命令模板和官网隔离要求沿用 [切换运行指南](release-cutover-runbook.md)。
4. 如需回滚，交换 compare 的当前/目标发行，再恢复前一个有效 Caddy 配置；验证发行头与签名 Manifest 确实回到旧程序。
5. 核对候选期间新写的事实仍可读，撤销仍生效、主体 ID/公钥不变，然后停止候选。仅看到旧健康页不算回滚成功。

发行回执及操作记录保存准确摘要、配置标签、迁移结果、切换探测、回滚探测与未验项。恢复隔离拒绝、版本不兼容或签名错误时不切换。当前不增加新的常驻发布控制器或云端服务。

## 自动演练与范围

设置 `GALAXY_TEST_PG_BIN`、`GALAXY_TEST_CADDY_BIN`、`GALAXY_TEST_NPM_CLI=<npm-cli.js绝对路径>`、`GALAXY_TEST_PG_CASE=release`，运行 `node packages/galaxy-official/scripts/test-postgres.mjs`。可用新的绝对路径 `GALAXY_TEST_RELEASE_EVIDENCE` 保存结果。

测试创建全新合成 PostgreSQL 集群和两个冻结 Official 源码目录，为每个目录执行 `npm ci --omit=dev --offline --ignore-scripts`，核对无共享依赖目录、无测试依赖。分别启动包内 API 和 Worker，读取实际 Worker 迭代指标及发行配置记录，再正常停止 Worker；包内发行 CLI 还要能独立重新生成相同文件清单。

启动 API 前实际执行该包内的固定发行迁移命令，选择 api/worker 角色并检查完成日志中的 Schema 和角色数量；管理进程使用独立环境，不继承 API 签名材料。

候选源码修改签名 Manifest 的展示名称，证明切换的是不同程序文件；经真实本地 Caddy 切换后提交第二个 Case、撤销第一个 Case 的授权，再回滚并检查新数据和撤销仍在。另检查不兼容迁移拒绝；Schema 来自实际迁移序列，不使用历史常量。所有进程和业务数据均属于夹具。

这个演练验证实际应用和代理回滚，未执行云端部署、生产秘密注入、Linux 服务管理或公共 TLS 验收；这些范围仍由目标主机发布流程负责。
