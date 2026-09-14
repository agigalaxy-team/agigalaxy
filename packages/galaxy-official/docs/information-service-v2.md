# M23 信息查询与明确开启的变化关注

范围：PWP-M23 / PREP-M23-STEP02、IF01/02、AC02/03。产品来源与修改前依据见项目 `07-logs/development/information-service-v2.md`。本切片复用 Search v2、History v2、Honor v2、M14 通知和现有生命周期工作器；不提供云模型，不建立另一个调度或备份系统。

## 人工与 Agent 流程

人工网页 `InformationWorkspace`：可匿名选择多个来源，查询用途和条件后分别查看事实、参与条件、证据、适用范围、原始字段及各自下一页。当前支持经历、Capsule、CI 凭据、开放任务、项目／模块／交流意愿，以及从当前来源或本人选择主体后按规则查看 Honor。无项目仍可临时查询。缺少历史不等于缺少能力；没有结果仍可继续当前 AI、查看可复用材料、开放协助或赏金／专家协助。发现、发布、参与和普通聊天入口并存。

选择具体资料或查询范围后，用户填写用途、截止时间和提醒方式。预览尚未提交；确认后才保存私有关注。暂停、明确恢复、修改范围和结束都有独立版本与操作回执。修改暂停的关注仍保持暂停，结束后不能恢复，另开使用新编号。现有浏览器原操作与新草稿分开；丢 ACK 先对账再按原编号重试。“停止本机重试”不等于服务端取消，需要真实结束动作才能结束已有关注。

网页只在组件挂载、连接当前身份且页面可见时每分钟检查到期项。服务端仍按15分钟无变化间隔和故障退避拒绝过早检查；每个独立关注的失败不会阻断其他项。网页关闭不承诺观察继续。MCP提供相同查询／配置／检查／回执／变化读取六工具，由用户宿主按明确开启的范围驱动。没有保存用户会话或冒充用户在云端查询。

## 接口与语义

所有路径为 POST：

| 路径 | 输入与结果 | 权限 |
|---|---|---|
| `/v2/information/query` | purpose、sources；可传稳定 queryId；每源返回状态、方法版本、范围、观察时点、items 和独立游标 | 可匿名；每源自己的当前 scope 与资料许可 |
| `/v2/information/watches/command` | operationId、watchId、expectedRevision、action；start/revise 带 plan | notifications；原用途所需来源 scope |
| `/v2/information/watches/stop` | 同命令但只允许 pause/end | notifications，支持停写取回窗口 |
| `/v2/information/watches/list` | watchId 或 after/limit；activeOnly 仅返回有效开启项 | 本人 |
| `/v2/information/watches/receipt` | operationId + 精确规范化 requestHash | 仅本人精确回执，不授权来源正文 |
| `/v2/information/watches/check` | watchId + expectedRevision | 本人真实当前会话；无模型 |
| `/v2/information/watches/events` | watchId | 本人回执＋逐源当前授权重读 |

来源类型：search 使用现有 Search v2 schema；reference 使用原搜索范围和准确对象摘要版本；honor 使用主体、规则版本和现有独立支持条目游标。没有新增全网总分或排名。queryId 包含端点、当前查看主体、用途和规范化来源范围，翻页不改变该ID，范围变化另得ID。查询观察时间不修改原事件或外部验证的发生时间。

available、no-visible-data、temporarily-unavailable 分开。当前没有可见资料不能公开隐藏资料是否存在；源暂不可用不清空已完成的观察基线。每次检查每个源最多5页，持久化只有ID／摘要版本／游标和覆盖状态。未完整扫描不得推断缺项；读完后“当前范围中不再出现”也不等于物理删除。确定性变化判断不作语义评价。

首次读取只是建立基线，没有新变化提醒。daily 只有用户显式选择后按固定 UTC 时刻合并实际观察变化，无变化不生成空报告。暂停、结束、到期或修订版本后，旧版本尚未发出的提醒不再展示；回执仍按保留期可查。M14 收件箱只显示本人通用变化回执，不附源正文／失效ID；打开后重新读取。读取不自动标人类已读。

## 保存、导出、删除

追加 migration70，不改1—69：

| 表 | 所有者与内容 | 生命周期 |
|---|---|---|
| information_watches_v2 | 本人；当前 plan、版本、纯引用基线、扫描游标、到期与最后检查 | 结束／到期后90天清理；本人删除可清除，不影响原资料 |
| information_watch_operations_v2 | 本人；操作摘要及结果，无重复原 plan 或正文 | 随关注清理，保留精确重试回执 |
| information_watch_changes_v2 | 本人；变化引用／状态、计划提示时点、对应关注版本 | 提示时点起最长90天；不恢复失效来源正文 |

90天与20个有效关注、一次8个查询源、每关注4源、扫描5页均是 CUR35 下依据临时通知和可退出关注的有界实现细化，不是用户逐字指定的数据表数字。当前实际资源预算计算 plan/baseline/scan/result/changes 字节与固定元数据。导出本人计划、版本和最小操作／变化回执，省略观察基线和历史变化里的源ID/摘要；来源正文仍通过当前授权查询取得。清理复用原 lifecycle worker，worker 只获三个私有元数据表 SELECT/DELETE，不能注册关注或查询模型。

## 已验证与真实边界

本地跨模块 HTTP + 实际 BrowserClient 流程，以及独立多轮分页反例2/2通过。隔离 PostgreSQL 的 API／worker 受限角色 HTTP 流程1/1通过，临时集群清理 `removed:true`。覆盖部分来源失败、私有资料不可见、失效许可过滤、初次基线不推送、暂停与在途检查竞争、无空日报、当前读、人类已读、精确 ACK 重试及清理不删 Task。

测试使用合成任务与内存本地存储；15分钟检查场景在隔离数据库显式延长测试会话时限，单独 BrowserClient 场景使用真实签名和重连。它不是真实 Account／反广告配额、浏览器 IndexedDB、用户体验、离线宿主或真实候选质量验收。页面严格 TypeScript 检查0诊断；主入口、视觉检查、发行捕获与部署由主代理负责。未在本记录中宣称70已上线。
