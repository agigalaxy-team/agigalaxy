<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/b5/b558c709814b573ee32f6e9112b59dc2f3fb203937f8b2e474b7545df697f173.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 运行日志与保留 v1

API、Evidence Worker 和迁移入口统一使用Pino 10.3.1输出JSONL；可选文件落盘复用rotating-file-stream 3.2.10。时间、级别、组件、固定事件与必要数值字段供人和采集器共同阅读，不为人工日志另存业务原文。

## 配置

| 环境变量 | 默认 | 用途 |
|---|---|---|
| GALAXY_RUNTIME_LOG_DIRECTORY | 未设置 | 未设置时输出到控制台；设置绝对目录后启用文件轮转 |
| GALAXY_RUNTIME_LOG_INSTANCE | primary | 同组件实例的稳定名称，1至32个小写字母/数字/下划线/短横线 |
| GALAXY_RUNTIME_LOG_ROTATE_BYTES | 10485760 | 单活动文件达到10MiB时轮转，可配置1024至1GiB |
| GALAXY_RUNTIME_LOG_MAX_FILES | 14 | 最多保留14个压缩归档，可配置1至90个 |

每个组件/实例使用独立子目录，例如api-primary、worker-primary、migration-primary。活动文件为runtime.jsonl；固定编号归档为runtime.1.jsonl.gz至runtime.14.jsonl.gz。同一组件/实例只支持一个写入进程；并行实例应分别命名。稳定名称使重启后继续沿用同一组归档。

达到大小阈值或每日轮转时，由现成库完成内置gzip压缩和编号替换。保留策略按归档数量执行，繁忙时可能只覆盖较短时间；不能把14个归档解释为14天。一个完整JSON记录不会被拆到两个文件中。修改大小阈值后，既有较大归档会随后续轮转逐步替换；压缩期间可能临时多占空间。

配置示例见[runtime-logging.example.conf](runtime-logging.example.conf)。它只提供部署参数，没有改动当前主机或服务器。首次启用文件模式会创建组件/实例子目录。

## 内容与权限

日志字段在进入Pino之前按固定集合选择：event、requestId、status、有限错误分类、启动phase、作业state、审计投递状态和计数/端口/版本。不输出完整Request、正文、Authorization、Cookie、Token、私钥、原始Error/stack、文件路径或自由文本。未知错误代码归类为other_error，未知事件为runtime_event_rejected。

部署时采用专用服务账号。新建子目录请求0700，活动/压缩文件请求0600；Unix拒绝组或其他用户可访问的已有组件子目录。Windows需要部署方为选定目录配置适当ACL，不能把POSIX mode测试当作Windows ACL验证。

文件日志不等于业务审计。PostgreSQL audit_events和SQLite失败投递队列沿用各自事务、恢复和删除期限；日志轮转不删除这些记录。非文件模式的控制台副本由宿主journald/容器日志驱动负责保留；文件模式默认不再复制完整记录到stdout，早期启动错误及日志输出故障仍可能进入stderr。

## 写入故障与指标

单日志输出缓冲约1MiB。缓冲耗尽或输出已失败时不继续堆积内存，丢弃的诊断记录累计计数，并向stderr输出一次固定故障标记。它不代表业务审计已成功，业务审计仍由原独立机制处理。

接入[运行指标](operational-metrics-v1.md)：

- galaxy_runtime_log_ready：输出是否仍可接收日志。
- galaxy_runtime_log_events{kind="writeFailures"}：本进程写入故障次数。
- kind="droppedRecords"：本进程未接受的诊断记录数。
- kind="rotationWarnings"、kind="rotations"：轮转警告与完成次数。

这些聚合值用于后续C17-06告警。stdout若由宿主丢弃、远程采集器停服或外部保留失败，当前进程不能证明最终投递结果。

正常停机等待文件流结束，轮转库排空其已接受的记录。强杀或断电仍可能丢失尚未写入的诊断记录；恢复/审计要求以独立持久存储为准。

## AI-agent部署与验证

先核对目标环境、专用账号、稳定实例名与日志绝对目录。只为目标服务设置以上变量，重启后查看对应组件目录，确认有启动/作业或错误事件，并检查日志指标为可写。改变实例名会产生另一组文件，旧实例目录需要单独归档和保留安排，不会自动跨目录删除。

回退可恢复先前轮转参数，或取消目录配置交由宿主日志收集；没有Schema迁移。运行中的文件应由同一个写入进程管理，避免同时使用另一套logrotate搬动这些文件。

自动化覆盖实际大小轮转、gzip解压、最多归档数、重启续写、相邻文件保留、缓冲上限、写入失败指标，以及真实API/Worker的启动失败和停机落盘。每日时钟边界来自库配置，本轮未等待自然日切换；Linux服务账号/ACL、生产保留期和告警接收方仍待部署核对。

实现依据：[Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)、[rotating-file-stream](https://github.com/iccicci/rotating-file-stream)。依赖精确版本记录在Official自身锁文件中。
