# 银河整站维护原生适配

本地整合说明（2026-10-26）：本目录保留完整生产适配器候选及隔离测试，当前 `configuration.mjs` 仍只接受 `production.enabled: false`；普通服务配置不能启用真实恢复。下文安装与生产适配描述是方案和前置合同，不表示本候选已执行整站恢复、已覆盖 schema131 的全部新自主任务状态，或已获准启用。具体恢复仍由人工批准一次方案后另行接入及验收。

这是 P19 的受限原生维护适配。初次只读、统一备份与恢复方案服务已由主部署流程接线；后续生产恢复适配是独立候选源，未进入该初次发行。二者不能共用“已部署”结论。生产配置继续保持 `production.enabled:false`，本模块尚未完成整站生产恢复。

## 当前能力与范围

- 后台服务读取真实组件进程、已有 Prometheus 目标、Loki 收集范围内的错误与安全日志，以及注册业务队列的 pg-boss 状态。进程运行不等于业务健康；未被采集的组件不补为正常。
- restic 原生快照目录提供整个配置仓库范围的总数，分页仅限制本次读取。原生 processed bytes 是捕获处理量，不是仓库物理占用。
- 新备份入口在固定的现行 operations 配置基础上解析 API/worker/publisher/admin 当前 release、CMS 实际依赖、已知容器持久卷与 Agno 的 PostgreSQL 集群归属。相关 writer 暂停后再次核对同一清单；变化时中止捕获并由既有 quiesce 逻辑恢复 writer。
- pgBackRest 继续承担配置集群的在线备份与命名恢复点；新增独立 PostgreSQL/ClickHouse/Redis/Meilisearch 卷按其实际 owner 有界停写捕获。不能把旧快照中的 business 集群自动认定为后来才加入的 Agno 数据库。
- 本页人工触发的创建和完整性校验先提交业务意图，再请求原生执行；固定 operationId 与独立控制日志处理丢失 ACK。校验使用 restic `check --read-data`，不声称底层物理块完整性或容量回收。
- 恢复方案、具体批准与执行阶段有独立 PG/CAS 记录。控制日志另存于业务库之外，不能随业务 PG 恢复回滚。固定执行器只有在全部已批准模块和开放条件都满足后才调用一次 `open`；未知结果不自动重放恢复。

## 恢复 A 与候选实现

已确认的恢复含义是：业务内容、文件与引擎按具体恢复点恢复；账号、密码、当前权限与密钥保持当前。`operations-stack/restoreProductBackup` 仍是隔离准备工具，`publicActivation:false` 不代表生产切换成功。

后续候选增加固定阶段的主机适配、当前业务安全事实合并、邮件投递账本保护、OpenPanel 当前身份合并、Meilisearch 当前 key 目录合并、当前公开来源的搜索/推荐条目核对、网站指针切换与最终统一开放。原生效果尚未在真实恢复中执行；检查中的原生命令与远程存储效果是明确替身，真实 SQL、临时文件和只读主机证据另列。

Garage 当前 key/ACL 与 Grafana 当前原生身份/授权已加入候选的捕获、合并与最终资格核对，详见 [原生安全贡献](./NATIVE_AUTHORITY.md)。Garage 使用已有 RPC 的 JSON 标准输入，不开放管理端口；Grafana 使用实际原生 SQLite 表，不另造身份库。两者尚未执行真实恢复效果，不能从只读接通和测试替身推导为已完成生产恢复。

Prosody 当前原生账号、房间权限、撤回/到期和原已执行身份删除的精确 MAM 回执已加入 v4 离线候选，见 [Prosody 当前贡献](./PROSODY_CURRENT_STATE.md)。v5 新增原 API 同连接的固定服务级 metadata probe 与 Garage 已执行身份删除的精确对象贡献，见 [在线与对象贡献](./LIVE_CONTRIBUTIONS.md)；后续探针已窄修为原生 XEP-0030 `disco#info`，中央实际往返由主会话部署后核对，不以代码或替身测试认定已连接。Garage 的不可导出管理 token、点内缺少当前桶、key 身份冲突、未知对象归属，以及 Grafana 未支持的原生安全命名空间/外部访问能力等条件继续拒绝。进程运行、受保护 env 或原 SQL 删除成功不能替代安全贡献；当前不能启用整站生产恢复。

具体源模块、阻断码、依赖、部署差异及检查范围见 [PRODUCTION_ADAPTER.md](./PRODUCTION_ADAPTER.md)。这些是既定恢复含义的执行依赖，不要求用户逐模块批准。实际恢复仍需人工批准一个具体方案的点、范围、可能损失及全部开放条件。

## 私有运行合同

- 原生 Agent：`node deploy/maintenance-agent/server.mjs --config <protected agent JSON>`，只监听固定 `/run/galaxy-maintenance/<name>.sock`，没有 TCP 管理监听。
- Agent JSON 必须 root 所有、普通文件、0600；引用的 service key 必须 root 所有，最多允许 API 专用组只读，不允许组写及其他用户访问。
- API 读取另一个非秘密配置 JSON：`{version:1,socketPath,keyFile}`，环境变量由中央配置使用 `GALAXY_MAINTENANCE_NATIVE_FILE`。密钥只进内存，不进入源码、响应或日志。
- socket 目录 root/API 专用组 0750，socket 0660。`apiGroupId` 必须从现有 API 运行身份实际解析，不从示例推定。
- 双向固定请求均先验证 service key，再读取最多 64 KiB 原始 JSON，再校验请求 id、30 秒时间窗口及 HMAC。Agent 对重复 id 关闭处理；业务意图幂等使用 operationId，并非重复签名请求。
- Agent 在原生变更前调用 `http://127.0.0.1:<API port>/v1/internal/maintenance/authorize`，取得已提交的精确意图及当前人员业务授权。HTTP 公域入口必须拒绝该 private 前缀；后台 BFF 没有此路由。
- 请求只能给闭合操作与已批准 ID。命令、路径、仓库 URL、DSN、LogQL、任意脚本和开放条件表达式都不能由浏览器或模型传入。

## 配置发现与 AI-agent 部署说明

1. 由当前受保护 operations 配置定位 restic、pgBackRest、状态目录、现行时间计划与 writer。保留当前 secret 引用，禁止输出配置原文、restic 环境或 Docker Env。
2. 只读/备份侧 Agent 的安装与后续更新由主部署流程执行。对外只核对闭合状态与能力，`production.enabled` 保持 false；不要用候选源覆盖主部署流程已经捕获的稳定发行。
3. 动态定时入口使用 `node deploy/maintenance-agent/manage.mjs backup --config <agent JSON>`，中断恢复使用同一工具的 `resume-writers`，二者均根据当前受限 footprint 重建清单。主部署流程已单独接续这两个入口；本模块不启用 timer，不修改频率、retention、离机位置或容量政策。已有入口接线不是新一次备份成功的证明。
4. 正确身份读 overview/catalog；无密钥或错误密钥应拒绝；错误 HMAC 应拒绝。检查动态清单模块覆盖与快照时点覆盖分别显示。全站恢复 capability 在依赖未齐时必须为 false。
5. 本批集中检查分别覆盖真实 PGlite/角色/HTTP、Linux Unix socket/独立 journal/动态清单及签名删除重放。原生命令替身与真正只读 host 检查需分开记载，不当作生产恢复验收。

常见问题：不要复制活跃数据库卷后称在线一致；不要把 statfs 根分区占用当对象仓库使用量；不要把 restic 快照存在或旧 create 成功当完整性验证；不要让恢复后的旧会话、旧投递队列和旧读权直接对外生效；不要在中断后用新 operationId 自动重复不可逆恢复。
