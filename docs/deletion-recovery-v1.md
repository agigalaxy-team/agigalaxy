<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/54/548920a2633d9ae63c682cc3ee3a02864493d5d1811a9391e2d4402ef37eb997.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 删除账本恢复与迟到审计 v1

当前Schema39共43张public表（含schema_migrations）；本人导出31类。deletion_replays在Schema26引入，现有捕获/重放覆盖当前结构。当前可独立捕获删除账本、向隔离恢复库补齐快照后的记录、重放已执行删除，并让迟到的审计队列按保留期限出队。没有配置生产定时复制、异地存储或公开重新激活。

## 两份恢复资料

普通备份继续使用PostgreSQL导出快照和restic加密仓库。删除账本另外捕获为一个有界JSON文件，包含deletion_requests、deletion_events、deletion_executions的完整记录及捕获时间、端点、Schema版本；不包含Bearer凭据、私钥或业务正文。申请人身份、公钥、签名和运营意见属于受限记录，应选择独立保护的位置保存。

捕获先对三张账本表及迁移表取得SHARE锁，阻止账本写入，再读取内容并确定截止时间。这样不会把读取开始后的未见事件误标成已覆盖。捕获窗口会短暂等待/阻塞账本写入，不承诺无停顿复制。数据库估算内容总量上限10MiB，最终文件上限20MiB、单表10万行；超限明确失败，不输出截断账本。大规模增量捕获仍需后续实现。

文件和输出的SHA-256必须一起可靠保存，并通过现有restic选定文件备份/第二仓库复制流程保护。摘要用于核对明确选定的运营资料，不提供独立的来源身份签名，也不能证明它是最新一份。若事故后只能取得旧账本，不能调低截止时间然后宣称丢失区间已恢复。本实现没有自动部署捕获定时器或异地副本。

## 捕获命令

```text
node packages/galaxy-official/scripts/deletion-ledger.mjs capture <绝对路径capture.json> <新的绝对路径ledger.json>
```

capture.json仅包含endpoint，例如`{"endpoint":"https://official.example.org"}`。沿用migration环境配置，连接明确的源数据库；脚本只输出摘要、捕获时间、字节数和申请数。需使用该专用数据库的维护角色。模板端点不是已上线地址。

## 恢复重放命令

先按[备份恢复流程](backup-recovery-v1.md)恢复到新的隔离数据库，然后运行：

```text
node packages/galaxy-official/scripts/deletion-ledger.mjs replay <绝对路径replay.json> <新的绝对路径receipt.json>
```

replay.json包括以下明确值：

| 字段 | 含义 |
|---|---|
| version | 1 |
| id | 本次恢复重放的UUID |
| targetDatabase | 准确的galaxy_restore_前缀目标库名 |
| ledgerPath | 捕获文件的绝对路径 |
| recoveryId | restoreBackup生成的本次隔离恢复ID |
| endpoint | 与账本一致的准确端点 |
| ledgerSha256 | 已保存的文件SHA-256 |
| capturedNotBefore | 要求覆盖的最早截止时间，Unix秒 |
| executorRef | 运维操作引用，不代表自然人身份签名 |

CLI沿用显式migration连接配置中的主机和凭据，仅把数据库改为准确的galaxy_restore_目标，并核对current_database()。模块再次核对当前Schema、准确隔离标记、端点、摘要及截止时间。不得把恢复操作指向在用源库。

随后逐一核对原始Ed25519申请/取消签名、连续版本、审核状态变化、执行结果与事件摘要，要求旧备份中已有的记录均包含在来源账本中且一致；缺失、冲突、无关联事件和不匹配的状态会中止。更新旧申请的取消状态后再插入新申请，避免把已取消的旧申请继续当作当前申请。

只有来源中已有实际执行记录的申请才重放删除；requested、review-needed、approved、rejected和cancelled仅补齐记录，不自动执行。复用主库执行器处理34张本人目标表（另9张共享运营/迁移/独立删除账本明确保留）、当前保留期限及真实跨作者引用。多个主体互相阻碍时重复检查，直到不再有可删除记录；仍有引用或保留要求的行继续明确列出。

来源计数保存在原事件中；恢复库第一次执行从自己的计数开始，避免把两个数据库副本的删除数量相加。新执行事件附有recoveryId、来源摘要和截止时间。导入、删除、事件及deletion_replays回执在同一事务提交，任一步失败全部回滚。

同一恢复仅接收一份来源账本；同ID和同命令返回原回执，不重复执行。输入错误后可修正并重试未提交的操作；已提交后若要换来源截止时间，应重新建立隔离恢复库。文件回执写入失败不等于事务失败，先检查原操作ID。

重放不会把recovery_state改为ready，publicActivationReady仍为false。保留期和外部引用、备份到期处理、运营重新启用、真实宿主人工验收仍分别处理。Schema27已支持运营原文和执行明细最小化，原主体签名保留。

## 迟到的失败审计

SQLite待交付队列沿用现有事务提交、至少一次交付及PostgreSQL去重。写入器按维护执行器的表锁顺序串行，并显式使用READ COMMITTED，确保等待删除事务之后能看到最新状态。

删除已执行且审核计划的audit.until已到时，对该主体的迟到记录返回suppressed-by-deletion；队列确认后删除pending项，不再重建PG审计行。保留期内的迟到审计仍正常入库，之后由删除续跑清理。恢复的旧队列在服务恢复交付时应用同一规则。

这保证业务表和队列逻辑记录的处理，不等于SQLite WAL、磁盘空闲页、备份包或第三方副本的介质擦除。整套服务删除完成仍为false。

## 本批验证

PGlite真实目录快照覆盖取消/新审批导入、未执行申请不误删、事务失败回滚、重复重放及保持隔离。真实PostgreSQL/restic恢复覆盖快照后删除的Case、Proof和主体再次移除；受限API角色覆盖迟到审计抑制与队列清空。临时数据均为合成数据，动态服务未部署。

Schema27的保留字段、到期命令、摘要校验及恢复边界见[回执最小化](deletion-minimization-v1.md)。
