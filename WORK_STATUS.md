# 当前工作

## 当前任务与状态

2026-10-29：工作台显示接续、真实业务查询和摘要成本已改善；当前收尾真实重试及公开活动统计，不恢复广泛测试。

- 当前线上：Go/AgentOS为`9f7b9ae`，Admin为`0c99eac`，官网保持`8e919ac`；两批CI全过。模型、权限和配置保留，未执行数据库迁移。
- 真实结果：正常问候及账户/反馈查询完成，注册3006、待处理反馈0；工具读取约1.5秒/3.1秒。新版本workbench延后公开活动的摘要源200、约2.3秒，所有源available。发送即清空、旧历史保留。
- 已定位重试：Agno后台regenerate不进普通job，旧原操作读取查不到新run；SDK在fork前保存父ID并写新metadata，实际污染父失败记录。新源码先建立独立尝试，再执行公开continue；读取按已落账native主键与严格父链定位。真实SDK回归含重试工具新身份、原失败全字段不变及再次失败，已通过。生产已知父行74的污染前像及精确绑定恢复待收尾，不放宽reader。
- 已定位首页统计503：公开回复的治理检查遗漏父postId，传空UUID；已补并通过真实PG公开帖/回复计数与父帖隐藏检查。缺失权限引用仍保守排除，不改治理含义。
- 待完成：本批最终上传、CI、部署；原失败的真实GET接续和浏览器重试/摘要核对。此前两次模型请求502保留，不在无证据时归因外部provider，也不把局部源200称为AI全流程完成。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
