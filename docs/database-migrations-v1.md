<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/19/19aaddb6677b61d61cf7d0677dc856f5b54ba801321794d7d6f1b01e5bed66f3.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 数据库迁移与角色准备 v1

C01-05：复用 PostgreSQL 事务及现有 41 版迁移，提供显式的同事务角色准备。API/Worker 不在启动时执行迁移或授予权限，历史 SQL 保持不变。

## 执行

选择独立环境，并通过部署进程环境提供 `GALAXY_ENVIRONMENT` 和 `DATABASE_URL`。数据库名分别为 `galaxy_local`、`galaxy_integration`、`galaxy_pilot`。不在命令行放连接串，不继承 API 签名配置。

在服务包的 `packages/galaxy-official` 中执行：

```text
npm run migrate
npm run migrate -- --roles=api,worker
```

第一条保持原行为：只应用缺失的 Schema 迁移。第二条将 Schema 和选定角色配置放在同一数据库事务内。通常二选一；原来已迁移的库也可使用第二条补齐或更新权限。需要删除请求审核角色时显式使用 `--roles=api,worker,deletion-review`。

| 参数 | PostgreSQL 角色 | 职责 |
|---|---|---|
| api | galaxy_api | API 业务读写与受限锁函数 |
| worker | galaxy_evidence_worker | 后台验证、索引和探测 |
| deletion-review | galaxy_deletion_reviewer | 记录删除政策审核 |

这些是 NOLOGIN 角色；命令不创建登录账号、设置密码或授予账号成员资格。部署账号需要所选 SQL 的实际 DDL/授予权限；创建尚不存在的角色还需对应权限。日常 API/Worker 使用独立登录身份，不能复用管理账号。主机账号及跨数据库权限仍需目标环境配置。

## 事务与失败处理

迁移持有同一数据库上的事务级 advisory lock，检查版本是已知迁移的连续前缀，按顺序应用缺失版本、插入版本记录，最后执行选定角色 SQL。全程复用同一连接。并发调用会串行；重复调用不重写旧版本及其应用时间，角色 SQL 可重复执行。

Schema 或角色 SQL 执行失败时，新 DDL、版本记录和本次权限变更一起回滚。例如 Worker 锁函数存在不兼容返回类型时，不能留下已升级的新表与半套 API 权限。保留冲突证据、修正准确原因后重试；不自动删表、改写历史 SQL 或降级。

连接中断、进程退出或日志写入失败不能单凭退出码判断提交结果。先检查实际 `schema_migrations`、所选角色与函数，再按同一发行重新执行。角色在 PostgreSQL 集群范围存在；数据库内的事务锁不协调不同数据库间首次同时创建同名角色，应串行准备共享角色。

## 发行与恢复

新服务发行清单包含 `entries.migration`。配置 `GALAXY_RELEASE_DIRECTORY`、`GALAXY_RELEASE_SHA256`、`GALAXY_CONFIGURATION_VERSION` 时，迁移入口在连接数据库前核对目录、源文件和配置标签。未配置发行清单时保留本地开发入口。

旧 v1 清单继续支持其已有 API/Worker 入口；缺少 migration 入口的旧清单不能用于新的固定发行迁移模式。应重新生成当前服务候选，不编辑旧清单冒充原发行。

应用回滚要求目标程序支持准确的当前 Schema；角色准备不是数据库降级机制。备份恢复使用新隔离库、当前删除账本及授权失效流程，见[服务发行](service-release-rollback-v1.md)和[备份恢复](backup-recovery-v1.md)。

## 开发证据与目标验收

`GALAXY_TEST_PG_CASE=concurrency` 使用全新合成 PostgreSQL 集群：旧版本 1–3 升级、Schema 冲突回滚、角色失败回滚、并发重试、实际迁移 CLI、业务事务失败、授权撤销以及 dump/restore。可用 `GALAXY_TEST_MIGRATION_EVIDENCE` 的新绝对路径保存结果。

`GALAXY_TEST_PG_CASE=release` 在两个独立安装的服务包内实际执行固定发行迁移命令，再验证 API/Worker 与 Caddy 回滚。参数沿用[发行说明](service-release-rollback-v1.md)。

这些证据验证本地自动化行为。目标 Linux 非root身份、真实账号权限、数据库隔离、业务数据量下的迁移耗时和生产恢复切换，分别保留目标环境验收；不由合成库结果推定上线。
