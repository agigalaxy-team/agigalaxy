# 备份及发布物清理工具

backup_housekeeping.py与release_housekeeping.py需放同一受保护程序目录，使用共同operations-job锁。完整保留/压力阈值、精确发布根、原子隔离与引用保护见[回收与磁盘保护](../../../../docs/operations/recovery.md#回收磁盘保护与发布物引用)。

只预演、不删除数据：

```sh
python3 -B <保护程序目录>/backup_housekeeping.py clean --config <保护housekeeping.json>
```

实际应用沿已授权安装的galaxy-backup-housekeeping.service；其Result/ExecMainStatus与备份timer的NextElapseUSecRealtime提供当前观测。不能以全盘Docker prune、手删pack/WAL或递归删发行目录替代本工具边界。
