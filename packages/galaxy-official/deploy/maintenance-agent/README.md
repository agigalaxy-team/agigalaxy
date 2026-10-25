# 银河整站维护原生适配

这是 P19 本批新增源代码。尚未部署，不代表生产恢复已接通。

## 当前能力与范围

- 后台服务读取真实组件进程、已有 Prometheus 目标、Loki 收集范围内的错误与安全日志，以及注册业务队列的 pg-boss 状态。进程运行不等于业务健康；未被采集的组件不补为正常。
- restic 原生快照目录提供整个配置仓库范围的总数，分页仅限制本次读取。原生 processed bytes 是捕获处理量，不是仓库物理占用。
- 新备份入口在固定的现行 operations 配置基础上解析 API/worker/publisher/admin 当前 release、CMS 实际依赖、已知容器持久卷与 Agno 的 PostgreSQL 集群归属。相关 writer 暂停后再次核对同一清单；变化时中止捕获并由既有 quiesce 逻辑恢复 writer。
- pgBackRest 继续承担配置集群的在线备份与命名恢复点；新增独立 PostgreSQL/ClickHouse/Redis/Meilisearch 卷按其实际 owner 有界停写捕获。不能把旧快照中的 business 集群自动认定为后来才加入的 Agno 数据库。
- 本页人工触发的创建和完整性校验先提交业务意图，再请求原生执行；固定 operationId 与独立控制日志处理丢失 ACK。校验使用 restic `check --read-data`，不声称底层物理块完整性或容量回收。
- 恢复方案、具体批准与执行阶段有独立 PG/CAS 记录。控制日志另存于业务库之外，不能随业务 PG 恢复回滚。固定执行器只有在全部已批准模块和开放条件都满足后才调用一次 `open`；未知结果不自动重放恢复。

## 生产恢复尚未连接的贡献

现有 `operations-stack/restoreProductBackup` 只提供新目录、无网络隔离 PostgreSQL 与文件副本，不会激活生产。默认 `host-restore.mjs` 如实保留这一能力边界，生产能力为 false：

1. 已实现当前签名删除账本的独立捕获与校验、向精确 quarantined 副本重放的薄适配。重放仍使用原业务删除代码，不新增删除策略，也不会开放副本。
2. 当前来源撤回、过期与授权状态，需要相应领域的最新事实贡献；不能从旧副本恢复出的正文或旧同意推断仍然有效。
3. 邮件等已发出的外部效果与 DATA 后未知结果，需要保留当前投递账本；恢复旧队列不能自动重发。
4. 当前管理授权与恢复执行授权回调依赖业务控制面。更换业务 PG 前须保持这一控制面的可用与当前性；不能用恢复出的旧权限取代它。
5. 还需固定主机的生产切换、全部计划模块校验与统一开放适配。目前不接受 `production.enabled:true`，不提供假批准/执行能力。

这些是执行依赖，不是新的产品选择，也不是要求操作者逐模块批准。用户仍只批准一个具体方案：点、范围、可能损失及全部开放条件。接齐贡献代码之后，实际恢复仍必须单独批准具体方案。

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
2. 先启动只读/备份侧原生 Agent；安装或改 systemd 必须由主部署流程执行。对外只核对闭合状态与能力，`production.enabled` 保持 false。
3. 若将现行定时备份接入动态清单，使用同一日程的固定入口 `node deploy/maintenance-agent/manage.mjs backup --config <agent JSON>`。本模块不启用 timer，不修改频率、retention、离机位置或容量政策。旧直接 backup 入口不会自动获得新增动态捕获能力。
4. 正确身份读 overview/catalog；无密钥或错误密钥应拒绝；错误 HMAC 应拒绝。检查动态清单模块覆盖与快照时点覆盖分别显示。全站恢复 capability 在依赖未齐时必须为 false。
5. 本批集中检查分别覆盖真实 PGlite/角色/HTTP、Linux Unix socket/独立 journal/动态清单及签名删除重放。原生命令替身与真正只读 host 检查需分开记载，不当作生产恢复验收。

常见问题：不要复制活跃数据库卷后称在线一致；不要把 statfs 根分区占用当对象仓库使用量；不要把 restic 快照存在或旧 create 成功当完整性验证；不要让恢复后的旧会话、旧投递队列和旧读权直接对外生效；不要在中断后用新 operationId 自动重复不可逆恢复。
