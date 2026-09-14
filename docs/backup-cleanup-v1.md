<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/40/40eb9b7fab609c23b8de755d6d2c204f7ab95fa89c29f85b8a400789108a918b.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# restic 快照到期清理 v1

沿用restic标准仓库、forget/prune/check命令，新增准确快照清理计划、重试和逐仓库结果。Schema仍为26、数据库36表；本批没有修改服务API、客户端或宿主交互。真实本地合成仓库已测试，生产仓库和定时任务未配置。

## 生成计划

在[备份配置](backup-recovery-v1.md)的primary仓库配置中使用：

```text
node packages/galaxy-official/scripts/backup.mjs prepare-cleanup <绝对路径config.json> <新的绝对路径plan.json>
```

增加cleanupRequest：

```json
{
  "version": 1,
  "repositoryRef": "primary-backup",
  "snapshotIds": ["准确的64位快照ID"],
  "requestIds": [],
  "policy": {
    "id": "实际批准的保留政策引用",
    "version": "实际版本",
    "notBefore": 2000000000,
    "basis": "该批快照清理的实际依据"
  },
  "prune": true
}
```

以上ID和时间是字段示意，须填入实际值。id可提供操作UUID，也可由程序生成。snapshotIds必须为完整ID，最多1000个且不重复；只接受当前仓库内hostname为galaxy-official的快照。requestIds可关联删除申请，但只是运营提供的关联，不证明已覆盖某个主体的全部备份。

省略snapshotIds时，必须明确配置已有retention规则，例如keepDaily/keepWeekly/keepMonthly。程序调用restic的保留预览，过滤galaxy-official组，把实际remove候选固定成完整ID计划；不会直接执行保留预览。没有候选时输出no-candidates，不产生可执行删除计划。

计划绑定restic仓库ID、仓库位置摘要、每个快照的树哈希和元数据摘要、最早执行时间及政策引用。程序输出计划SHA-256，不输出仓库密码、认证环境或原始路径。生成计划不删除数据。

## 执行与重试

在配置中填写approvedPlanPath和approvedPlanSha256，指向上述准确计划和输出的摘要，然后运行：

```text
node packages/galaxy-official/scripts/backup.mjs cleanup <绝对路径config.json> <新的绝对路径receipt.json>
```

执行先核对计划摘要、notBefore、准确仓库及仍存在的目标快照；然后仅forget所选完整ID。prune为true时执行仓库级未引用数据回收，使用max-unused=0，之后check --read-data并确认目标快照不存在、操作开始时的其他快照仍存在且元数据一致。prune为false时只移除快照引用并检查仓库，不能声称其底层数据包已回收。

forget或prune失败可能已有部分提交，文件回执失败也不代表仓库未变更。保持原计划和摘要重试：程序只forget仍存在的目标，随后继续prune/check；执行前已不存在的数量单独记录，不推测它们由谁或哪次操作删除。每次结果描述本次观察，因此重复执行的计数不保证与第一次逐字相同。

结果包括准确仓库/快照、已不存在和本次移除数量、prune是否执行、完整性检查、其他快照保留数，以及关联的申请与政策引用。副本仓库应单独生成和执行计划；主仓库计划不能直接用于另一仓库。

## 结果边界

删除快照引用以及回收未引用数据，不等于该主体的所有副本都已擦除。被保留快照引用的去重数据、其他仓库、对象存储历史版本、磁盘/SQLite WAL和第三方副本必须另行处理。因此backupSubjectErasureComplete、otherRepositoriesChecked和storageMediaErasureVerified均保持false。

此工具不按主体扫描或解包全部历史数据库，不自动把删除请求的backup状态改为全部完成。可将每个仓库的实际回执关联到申请；完整范围及真实异地仓库仍需运营配置和证据。完整删除账本/回执的最小化是下一项开发，不在本批变更中。

## 验证

使用三个真实合成快照，验证保留候选过滤、未到期拒绝、准确仓库匹配、计划摘要、完整ID删除、丢失回执后续跑、prune/check、CLI环境引用和另一宿主快照仍可恢复。仅重跑了本次相关的restic用例和lint，没有重复全部PostgreSQL或客户端检查。
