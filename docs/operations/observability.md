# 监控、告警与运行日志

源码入口为 [`operations-stack/manage.mjs`](../../packages/galaxy-official/deploy/operations-stack/manage.mjs)。本模块面向Linux单机，复用实际PostgreSQL、Keycloak、Prosody、Garage与ClamAV；运营后台管理业务，Grafana/Alertmanager/日志承担专业观察。通用结果层次见[开发](../technical/development.md#故障定位与未验证范围)。

## 配置与安装

以 [`configuration.example.json`](../../packages/galaxy-official/deploy/operations-stack/configuration.example.json) 创建受保护目标配置，填准确主机、工具绝对路径、镜像、端口、文件/unit/容器、PG角色/compose、接收者与Keycloak客户端引用。示例中的域名、目录、版本和null不是自动发现。`monitoring.mode=managed`生成专用指标units，existing接已有系统，不起第二套。

| 组件 | 连接与数据约束 |
|---|---|
| Grafana | loopback，经管理站点 `/monitoring/` 反代；独立持久目录 |
| Loki | loopback、本地TSDB/文件，日志保留以配置为准 |
| Alloy | loopback管理入口，持久文件/journal游标，不用Promtail、不挂Docker socket |
| 组件日志适配器 | 本机固定Docker Unix socket、私有轮转NDJSON，无监听端口 |
| Prometheus/Blackbox | loopback、API/Worker真实metrics与准确外部存活/就绪目标 |
| Alertmanager | loopback，保护receiver引用，不把无有效接收者的旧示例当已投递 |

Compose使用Linux host network访问loopback，监听仍限127.0.0.1，Loki查询frontend/ring通告地址也限loopback，避免多网卡回传错误。Loki/Prometheus/Alloy不直接公网反代。资源上限、工具/镜像固定版本由配置和构建输入维护，不在本页重复第二份版本清单。

```sh
node packages/galaxy-official/deploy/operations-stack/manage.mjs plan --config /protected/operations-input.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs prepare --config /protected/operations-input.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs install-units --config /etc/galaxy/operations/configuration.json
node packages/galaxy-official/deploy/operations-stack/manage.mjs up --config /etc/galaxy/operations/configuration.json
```

plan不读秘密值、不连接服务。prepare生成自身配置/目录/专用用户，install-units仅安装自身标记具名单位，同名无关unit停止；非空目录所有者不匹配不递归改权。up启动监控和日志，不启备份timer。将生成的caddy-monitoring.fragment合入所选管理站点catch-all前，保留 `/monitoring/`，不以handle_path剥前缀或覆盖整个Caddyfile。

`stage-linux.py tools/prepare` 是带目标配置的专用准备器：按固定输入下载/拉镜像/构建备份镜像、保留原秘密，缺失时才生成监控和仓库材料，创建未启动units；它不是新主机的通用无参数安装器。仅在目标已准确核对时采用，不因文件存在而使用其中旧主机拓扑。原秘密留root0600，专用root0700目录中的精确UID可读副本用于只读bind，Alertmanager通过systemd LoadCredential读取receiver。

## 管理认证与告警

Grafana使用独立management realm与专用confidential client，Code+S256，禁implicit/password grant/service account；唯一回调为实际root_url下 `/login/generic_oauth`。roleSource明确client或realm，限定scope/mapper把所选角色放入签名ID Token，核issuer/JWKS。无匹配角色拒绝，不降默认Viewer；Grafana organization Admin不授银河业务或server admin。生成keycloak-grafana.json是接线合同，不自动改身份。同邮箱/普通账户/本机ID不取得监控身份。

规则直接消费 [业务规则](examples/alerts/galaxy.rules.json)、[外部探测规则](examples/monitoring/external.rules.json) 及相应Blackbox配置。owner_role供路由选择，receiver连接另由目标配置确定。

`prepare-alertmanager.py --recipient <明确管理收件人>` 仅在授权目标进程读取已有realm的SMTP并写私有receiver，不改变原SMTP/普通账户。发件身份与模板由galaxy-mail生成的monitoring/mail-identity.json确定，不沿用账户发件人；供应商须允许该身份。mask不是密码，TLS沿原STARTTLS/implicit设置且核证书。`--send-test` 仅向准确授权对象发一封标明测试的邮件，已有请求不自动重发。SMTP接受只表示submitted，不表示收件箱送达或完整调度链已验证。

## 日志采集与安全投影

配置的logs/journals/dockerLogs精确列明文件、unit和本产品容器，新增/改名须同步。适配器只执行固定daemon的docker ps与指定容器 `docker logs --follow --timestamps`，不读Env/文件或执行容器命令，自身Docker配置目录为空私有。原文逐行重建安全NDJSON后交Alloy，默认每组件10MiB、3文件；按真实容器和时间游标重接，包含起点可在崩溃边界重复末尾，避免丢同时间记录。容器已删或源轮转前未读数据无法补出。

文件与journal同样白名单投影，只保有限event/code/phase/stage/action、level、方法/状态/耗时/大小、清理路由、队列次数结果、机器错误码/SQLSTATE。已清堆栈最多12帧、cause两层，仅允许源路径/文件名行列；后台statusCode/frames归一化。第三方文本只提错误类别/异常类，无法安全分类只保组件/时间/等级。Error.message、SQL/detail、正文/stanza、邮件地址、cookie/验证码/token/密码、任意headers/OAuth参数不进Loki，不用全debug补采。

标签仅component/environment/release/有限level。requestId、Caddy edgeRequestId、jobId/resourceId只接受UUID并作结构化元数据，不建高基数索引，不替第三方编造关联ID。Caddy requestId取真实上游响应；混旧版本文件只采用记录自身声明的版本，无法取得为unreported，不以镜像摘要冒充产品版。运行日志不替代业务审计。

Alloy持久游标，首次journal最多回看24小时，文件从现存开头读；Loki、Caddy与源日志按实际保留/轮转。缺ID、无事件、权限、轮转和停机影响覆盖。排障核准确来源/只读绑定/读取权限及有限log_source事件；改采集只重载相关组件，不为此重启API/认证/数据库或输出原私有日志。

## 自动运行与备份状态

Worker的autonomy-tick不能发现自身死亡；独立消费者为API loopback exporter，从PG读取真实心跳/任务。Prometheus抓取实际API端口，加载同批 `GalaxyAutonomyCollectionFailed/WorkerStale/TasksOverdue`，API/Worker离线沿TargetDown/TargetMissing。无需另建值守timer。

指标族为 `galaxy_autonomy_collection_success`、`enabled_accounts`、`worker_health_available`、`worker_tick_age_seconds`、`worker_tick_limit_seconds`、`overdue_start_tasks`、`overdue_round_tasks`（后六项同 `galaxy_autonomy_` 前缀）。无心跳用health_available=0，不伪造age=0；全停用不报岗位心跳过期。fixture覆盖规则触发/恢复，投递观察取Alertmanager及接收端。

备份短状态用 `GALAXY_BACKUP_STATUS_DIRECTORY`，`GALAXY_METRICS_BACKUP_ACTIONS` 仅填真实接通动作；statusGroupId只授读取短状态，不开放仓库/捕获回执/秘密。采集与通知验证按受影响范围集中一次，定向入口：

```sh
node --test packages/galaxy-official/deploy/operations-stack/operations-stack.test.mjs packages/galaxy-official/deploy/operations-stack/log-record.test.mjs
```

这些检查覆盖编排、生成与安全投影；OAuth检查需管理客户端，日志覆盖需准确来源和时间范围，投递需接收端记录。PG归档及离机恢复见[备份与恢复](recovery.md)。
