# 每周备份与磁盘清理

2026-10-25用户要求将银河备份改为每7天一次，并清理积压、提供自动清理及磁盘保护代码。本文件描述已实现的规则；本次没有执行新备份或恢复网站。

## 计划与保留

- `backup.calendar` 为 `Sun *-*-* 03:15:00 UTC`，北京时间每周日11:15，保留原10分钟错峰。实际下次时间以 `systemctl show galaxy-operations-backup.timer -p NextElapseUSecRealtime` 为准。
- 正式恢复点至少保留最近2份，并取最近1日、4周、1月的代表恢复点，规则取并集，不是另开日/月备份。手动备份也受同一保留策略管理。
- 额外保护最近成功回执、最近通过完整读取校验的恢复点、未结束恢复方案引用。其他项目的host/tag不在清理范围。
- pgBackRest继续原生保留2个全量及依赖WAL链，不手工删除归档、PGDATA或仓库pack。

## 清理与空间保护

`backup_housekeeping.py`使用与备份、恢复相同的`.operations-job.lock`，活动操作存在时让出执行。每小时维护一次，备份前进行清理和余量检查，备份成功后再执行保留清理。

| 对象 | 常规规则 | 磁盘有压力时 |
| --- | --- | --- |
| 失败捕获暂存 | 超过48小时，UUID与`purpose: backup`标识均匹配才清理 | 超过1小时可清理，仍须持有互斥锁 |
| 历史Next编译缓存 | 仅`turbopack/webpack/swc`，超过48小时 | 超过6小时；始终排除最近5个版本及进程正在使用的版本 |
| Docker构建缓存 | 不主动处理 | 由Docker清理48小时前的未使用构建缓存，保留10GB目标；不清理镜像或卷 |
| 系统journal | 最多512MiB、最长14天，另预留32GiB磁盘 | 轮转并按同样上限清理旧journal |
| 清理诊断摘要 | 仅保存小型元数据，30天到期 | 同左，不保留失败数据副本 |
| 完整历史发布物 | 经用户2026-10-25进一步授权，后台、官网、API/维护每类保留近2份；另保护实际现用版及其上一版、运行/配置/恢复引用、跨版本依赖，新目录留1小时缓冲 | 同左，不以空间压力绕过引用保护 |

低于64GiB可用空间或磁盘使用达到85%时采用压力规则。备份前先检查至少32GiB保留空间，实际捕获还按“来源总量×2＋32GiB”检查，覆盖临时副本和同机仓库同时增长；空间不足时拒绝备份。未知、越界、符号链接根目录、缺少标识的目录不会被猜测删除。恢复暂存、开发工作区、当前及受保护发布物、媒体、业务对象和数据库卷不属于自动删除范围。用户进一步授权后，无引用旧发布目录内的对应源码、构建物及依赖会一起回收。

完整版本回收由同目录release_housekeeping.py实现，只接管/srv/galaxy/admin/releases、/srv/galaxy/website/releases及/opt/galaxy/releases三个精确根。每次重新检查systemd实际配置、进程工作目录/参数/打开文件、Docker挂载、站点指针、现有配置和在办恢复方案，并追踪保留版本的符号链接依赖。新上传尚未生效时，额外保留现用版的真正上一版，不把待发布版本误算成已经替换现用版。

删除前先在同一根内原子转入私有隔离目录，再检查新出现的引用；出现新引用且尚未删除时恢复原位。删除已开始后如被打断，下一次根据标识接续；若此时出现引用，不把可能已部分删除的目录恢复为可用版本，而是保留并报告需要核查。未知文件、inode变化、越界、符号链接路径都停止该项删除。程序不会递归清除未登记的发布根或同机其他应用。

清理先生成restic原生`forget --dry-run --json`结果，剔除受保护点，再按完整ID调用forget，随后由restic prune回收并check仓库结构。剪枝中断留下受保护的小型待办，下次维护继续；不会因快照已经删除而永远跳过回收。`check`结构检查不等同于生产整站恢复验收。

## 主机入口与观测

- 稳定程序：`/opt/galaxy/operations/backup-housekeeping/backup_housekeeping.py`。
- 策略：`/etc/galaxy/operations/housekeeping.json`；业务备份配置仍为`/etc/galaxy/operations/configuration.json`。
- `galaxy-backup-housekeeping.timer/service`负责每小时清理；原备份service的`40-space-guard.conf`增加前后检查，原动态捕获入口保持。
- 最近结果：`/var/lib/galaxy/backup-status/operations/housekeeping.json`，包含前后磁盘量、清理对象、受保护点及错误。清理失败不写成成功。
- `GalaxyBackupStale`的create阈值改为8天，给每周备份留出执行与错峰时间；copy及独立check原阈值保持。修改后必须确认Prometheus实际载入，不能只看配置文件。

```sh
# 只预演；会短暂取得共同互斥锁，不删除数据
sudo python3 -B /opt/galaxy/operations/backup-housekeeping/backup_housekeeping.py clean --config /etc/galaxy/operations/housekeeping.json
# 执行已安装规则
sudo systemctl start galaxy-backup-housekeeping.service
sudo systemctl show galaxy-operations-backup.timer -p NextElapseUSecRealtime
sudo systemctl show galaxy-backup-housekeeping.service -p Result -p ExecMainStatus
```

## AI agent部署说明

先从已注册资产解析真实主机，用现有受保护SSH引用连接；只读取策略和凭据文件路径，restic密码由进程从受保护文件读取，不复制进仓库、参数、日志或报告。只有用户授权修改备份和清理时才能部署、应用清理。本目录的 `backup_housekeeping.py` 与 `release_housekeeping.py` 必须放在同一受保护程序目录，Python 3 标准库即可运行。按本页已登记的主机路径安装时，先复制这两份源码，再设置明确的 housekeeping JSON 和 systemd 服务；不要从业务源码包内寻找运行凭据。2026-10-25 专项安装器属于该次项目维护记录，程序运行与源码恢复均不依赖它。

安装先运行Linux删除边界测试、Node语法检查、promtool规则与样例测试，并保存私有原配置和删除前预演。监控规则文件须保持监控服务可读，凭据及清理策略仍为root私有。启用后核对：日历只有一条周计划；守护服务加载最新配置；清理service退出码；受保护快照仍在；没有遗留暂停写入者；官网、管理登录及API健康正常。

不要用`docker system prune -a --volumes`、直接删除restic pack/WAL或递归删除发布目录代替这里的规则。若新增维护发行版，必须携带`backup-space.mjs`及`backup.mjs`的空间检查；稳定systemd前置检查仍会保留。清理只能约束这些可回收项，真实业务与运行产物持续增长仍需容量管理，不能为保持空闲而自动删除业务数据。

Next编译缓存用途参考：[Next.js官方Turbopack文件系统缓存文档](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache)。
