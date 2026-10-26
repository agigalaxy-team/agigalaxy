# P19 初次部署合同

本文件描述新增源码的接线；它不是已部署或已执行恢复的证明。当前支持先部署真实只读、统一备份和具体恢复计划。生产恢复适配仍需完整冻结与单独就绪核对，`production.enabled` 必须保持 `false`。任何布局选择都不是某个具体恢复方案的批准。

1. 使用本次已捕获的同一 API release 源及其固定依赖。主机已有 Node 为 `/opt/galaxy/runtime/node-v24.19.0-linux-x64/bin/node`，不安装另一套运行时。在 root 私有 `/etc/galaxy/maintenance/service.env` 写入唯一非秘密路径 `GALAXY_MAINTENANCE_RELEASE=<实际完整 release 根>`；示例 service 从这个根读取 `packages/galaxy-official/deploy/maintenance-agent/server.mjs`。不要让 service 指向可写开发目录。
2. 从实际 `galaxy-api@pilot.service` 的 User/Group 解析 API GID。Agent 配置使用 `configuration.example.json` 形状，保存为 root:root `0600` 的 `/etc/galaxy/maintenance/agent.json`，将 `apiGroupId:null` 换成实测 GID。既有 operations 配置仍引用 `/etc/galaxy/operations/configuration.json`，不在此复制 secret。
3. 在 root 受保护路径新建专用随机 service key，由 Agent 与 API 通过文件引用读取；不要写源码、终端输出或部署记录。建议 key 文件 root:API 专用组 `0640`，父目录允许该专用组穿越、其他用户无权。API 的 `api-native.example.json` 只存 socket/key 路径，权限遵循现有 loader；`GALAXY_MAINTENANCE_NATIVE_FILE` 指向这个配置文件。
4. Agent 日志、控制 journal 和恢复贡献在 `/var/lib/galaxy/maintenance`，root `0700`，文件 `0600`，独立于业务 PG 与恢复副本。不得把这部分复制进业务恢复点后再覆盖当前控制日志。模型控制模块已有可选初始化：仅当 `/etc/galaxy/model-settings/control.json` 存在才接 `/v1/model-settings`，必须保留它及当前模型保护文件；没有该文件不自动创建配置或模型。
5. 安装示例 systemd 单元时先替换实际 release 路径引用并保持 `production.enabled:false`。它的写路径只适用于初次只读/备份阶段；没有生产原生适配和所需具体文件写入范围时，不扩大单元权限。启动后 socket 为 `/run/galaxy-maintenance/agent.sock`，root:API 专用组 `0660`，目录 `0750`。该 Agent 不监听任何 TCP 管理端口。
6. 中央已接精确公开 `/v1/operations/maintenance/*` 与仅 loopback 的 `/v1/internal/maintenance/authorize`。公域 Caddy 应继续拒绝 `/v1/internal/*`；BFF 无内部入口。Agent 每个有副作用阶段调用当前 API 私有授权，带独立 service identity/HMAC，不借用户 Cookie。
7. 初次只读核对只调用真实 overview、backups、point、logs：进程与健康分开；根文件系统空间不等于对象仓库占用；旧 point 不回填新引擎覆盖；timer 的 active/enabled/原日程与最近 create 记录分别展示。不要通过创建备份、校验整个仓库或恢复来冒充一次只读健康检查。

已有日程继续使用当前 timer 的日历。若主部署流程要使后续定时备份也采用动态清单，只替换其固定执行命令为同一 release 的 `deploy/maintenance-agent/manage.mjs backup --config /etc/galaxy/maintenance/agent.json`，不修改 timer 日程、retention、仓库位置或旧历史。没有替换时，旧定时入口仍是原覆盖，不能称新增卷已由旧 timer 自动捕获。

新 footprint 已按当前 `galaxy-model-runtime` 的 `galaxy-model-gateway` / `galaxy-operations-agentos` 实际容器名识别；旧 gateway 名只作仍在运行时的兼容发现。`/var/lib/galaxy/model-gateway/usage.sqlite3` 属于非正文 token 账本，随点备份；`/etc/galaxy/model-settings` 的 keys、provider/active env、bindings/models、独立控制账本，以及 PG 中关联模型版本和 credential refs 保留当前。初批空模型样例不是当前状态；现有人工模型已非空，保留检查必须针对本次实际配置、版本和凭据引用，不能沿旧样例跳过。

AI-agent 部署注意：只读取 secret 引用与闭合元数据；不打印 `docker inspect .Config.Env`、完整 Caddy config、restic 环境、当前安全贡献或原生 `/keys` 响应。实际恢复仍必须绑定某个 point、范围、损失窗口、批准/CAS 与全部开放条件。中断或丢失 ACK 后查询原 operation，不换 operationId 重做；已发 SMTP 不撤回，DATA 后 unknown 不自动重发。
