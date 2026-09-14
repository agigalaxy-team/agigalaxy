# 用户端关注的同 ID 跨设备移交

本切片实现 M17 的 PRE-M17-IF02 与 PRE-M17-A03：在目标设备明确选择后，继续同一条关注，继承服务端最后确认的 Agent 游标，并撤销旧设备对应的这一条银河授权。它不运行用户模型、不保存模型凭据、不把旧设备进程停止状态冒充已确认。

实施依据及原文位置见项目 `07-logs/development/watch-handoff-history-search-review-2026-09-13.md` 的 WS-01。该细化属于已采用准备包，不能将具体算法冒称用户逐字指定。相关完整阅读入口为 M17 包、卷11.22及 PRE-M17-IF01/02/A03；CUR-35恢复计划内业务实施。

## 已实现的用户流程

1. 用户端使用已有的精确房间 Agent 授权创建本地关注。此时云端没有关注控制记录。
2. 用户通过原生工具 `galaxy_watch_control_enable` 明确选择同步这条关注的目的、房间、可选任务引用、期限和授权引用。原生 MCP 使用实际用户选择界面；工具输入不接受模型提交的 `confirmed` 标记。所选期限同时缩短这条 Agent 授权的期限，不修改其他授权。
3. 另一台已由当前身份控制链授权并连接的设备查询本人控制记录。它明确选择精确的关注版本及旧授权，通过 `galaxy_watch_control_takeover` 提交目标当前 binding 和新 grant ID。
4. 一个数据库事务内锁定任务、房间、关注，核对当前权限与期限，撤销旧 grant、创建范围和响应身份均不扩大的新 grant，并复制原 grant 在服务端已经确认的游标。关注 ID 保持不变，控制版本加一。
5. 目标设备将同一 ID、范围和游标保存到自己的本地关注目录，随后由真实宿主调用 check，交给用户 Agent 处理。尚未确认的消息会重新出现，不将旧设备未完成工作算作已处理。
6. 旧设备后续读取、发言或确认旧游标均被拒绝；旧设备调用 stop 只撤自己的旧 grant，不会跟随控制记录撤销新设备 grant。实际外部模型进程是否已停止仍由宿主确认。

拒绝用户选择不会提交新控制。权限被撤销、范围已不可见、任务结束或期限已过时不能接管。注册和接管并不建立账号、恢复身份或合并身份组。

## 精确 HTTP 操作

全部为 `POST /v2/watch-controls/`，使用当前 binding scope；服务端以认证所得主体为准，不能传入另一个 subjectId。

| 后缀 | 输入 | 结果及边界 |
|---|---|---|
| register | operationId、watchId、roomId、agentGrantId、purpose、expiresAt、可选taskId | 本人已有当前设备授权；明确同步最小控制。目的最多500字符 |
| takeover | operationId、watchId、expectedRevision、expectedGrantId、targetBindingId、newGrantId | 目标必须是发起请求的当前设备；不能替其他主体接管 |
| stop | operationId、watchId、expectedRevision、expectedGrantId | 只撤指定当前版本；退出房间后仍可撤销自己的这一条授权 |
| query | after、limit（1至50，默认20） | 本人已明确注册的控制，稳定 ID 分页；不包含未同步的本地关注 |
| read | watchId | 当前版本、状态、授权及安装引用、最后确认的 Agent 游标 |
| receipt | operationId、requestHash | 精确操作回执或 absent；他人操作也只返回 absent |

服务端返回 `watch`、写入回执及当前状态，包含 `runtimeLocation:user-host`、`hostRuntimeState:unverified`、`externalProcessStopped:unconfirmed`、`cloudModel:false`。这些字段明确说明授权和控制记录不是宿主正在运行的证明。

结果中的 lastCursor 是服务端已确认 Agent 处理位置，不是人的已读状态，不由客户端随意填写。空结果仍允许其他独立用途；不把一条关注的无结果解释为取消整个聊天功能。

控制状态区分 active、stopped、expired、permission-revoked、device-unavailable、scope-unavailable。身份恢复可在当前有效控制链下接管仍有效的授权范围；已经明确撤销的源 grant 不能借恢复复活。

## 丢失回执与并发

原生客户端在发出请求前持久保存解析后的精确输入、operationId 和 requestHash。散列是规范 schema 解析后 `JSON.stringify` 字节的 SHA-256，不是任意 JSON 属性顺序的哈希。发生丢 ACK 时通过 `galaxy_watch_control_pending` 与 `galaxy_watch_control_reconcile` 查询原操作。

已选定操作仅在回执 absent 时按原 ID 和原字节重试；重试不重新授权、不更换 grant、不另建关注。冲突必须重新读取并作新的明确选择，不自动追随最新版本。多个目标设备竞争同一版本只有一个成功。

本地原有同房间的另一条活动关注会导致接管前明确冲突，避免重复主响应者。接管结果已记录但本地保存失败时保留待对账操作；不把客户端失败说成服务端未执行。旧的成功回执不会复活之后已经停止的同一 grant。

原生 `galaxy_watch_stop` 的本地优先停止、远端失败后持久重试行为继续保留。它可以使控制查询显示 permission-revoked；`galaxy_watch_control_stop` 会进一步记录当前控制版本为 stopped。两者都只影响精确授权，不中断别的关注。

## 数据、保留与取回

迁移73追加 `watch_controls_v2` 和 `watch_control_operations_v2`。已有1—72迁移保持原样。控制仅保存本人选定目的、房间/任务引用、授权/设备引用、版本和期限；游标读自已有 chat_cursors。没有消息正文、完整查询上下文、个人摘要或模型配置副本。

此同步选择独立于个人摘要及信息关注（M23）的开关，不能将打开任一开关解释为上传全部关注。源房间内容仍遵循原30天及当前权限，控制历史不能复原已删除内容。

本人取回数据集为 `watch-controls`、`watch-control-operations`；全量本人删除按实际 FK 叶顺序移除，保留他人的独立控制。停止或期限结束90天后，由现有生命周期任务清除控制与精确回执，每轮最多100条。这是 CUR-35 下最小控制恢复窗口的实施选择，沿用临时操作回执处理，不是用户逐字指定的90天产品语句；读取不续期。

停写/退役只额外允许精确 stop；取回模式允许 query/read/receipt。register 和 takeover 保持普通写入限制，不放行整个路径前缀。

## AI Agent 部署与验证

此切片无需新容器、模型、密钥、定时服务或外部资源。按项目发行流程应用追加迁移73和同版 API、清理角色；API 可写控制当前状态但不可改历史回执，清理角色仅可读和删除新表。既有生命周期 worker 负责回执清理，原生宿主负责关注检查。

部署前读取 M17 完整模块包及相关身份、聊天、隐私接口。不要从本说明推导通用远程执行、云端模型服务或新增强制安装依赖。必须同时交付新 native watch-control 工具；只有 API 更新而旧客户端没有这些工具时，不宣称用户已能完成移交。

必要验证入口：

- `node --test packages/galaxy-official/test/watch-control-v2.test.mjs`
- 子进程设置 `GALAXY_TEST_PG_BIN` 和 `GALAXY_TEST_PG_CASE=watch-control-v2` 后运行 `node packages/galaxy-official/scripts/test-postgres.mjs`。该脚本只建立合成隔离集群，结束后销毁，不连接生产数据库。

2026-09-13 已通过实际 HTTP、三套独立设备密钥、受限 PostgreSQL API 与清理角色的一条完整组合流程，最终 PG 测试耗时4318.9943ms，清理回执 removed:true。涵盖并发唯一接管、原游标、旧读写/ACK拒绝、其他授权保留、丢 ACK对账、本人取回、实际删除、他人控制保留及清理。

本轮外部聊天存档使用明确标注的接口夹具，未重复测试已通过的 Prosody 底座。没有把同机测试客户端当成真实跨物理设备验收，也未声称任何宿主自动启动了后台模型。生产部署和真实宿主观察由对应发行/验收记录单列。
