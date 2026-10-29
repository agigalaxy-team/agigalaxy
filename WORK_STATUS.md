# 当前工作

## 当前任务与状态

2026-10-29：源码重构已同步 GitHub，`9fa17ee` 的14组件与Runner Smoke全部通过，Go核心、官网、后台及维护程序已部署。随后按用户真实反馈继续处理全站读取清屏与AI发送接续；本提交包含这批机制修复，新的CI与上线结果仍待完成后更新。

- 已上线基线：Go发行 `go-source-9fa17ee`；官网／后台运行包 `source-9fa17ee`。七个相关服务运行正常，原环境、凭据、数据库、账号、配置和在办操作保留，没有执行数据库迁移。旧网页构建仅为已打开页面保留接续资源。
- 实际复现：独立无头浏览器只发送一次原operation，页面和输入框DOM未更换，但短期读取期限使对话从4条清成0条，随后恢复并最终完成。不能把此前登录和切页通过当作AI发送稳定。
- 本批修复：共同读取层区分显示快照和当前操作资格，普通续读、短期读资格到期、暂时故障不再清正文；缓存不再被反复当作新initial触发读取。明确失权、退出、对象不可读及内容自身到期仍清对应数据。事件replay-gap只后台更新，真实access-changed保留清理。
- AI接续：轻量qualification复核同owner、固定AI和真实来源期限，不取历史也不声称历史未变；精确original operation优先，不以新编号或POST恢复未知结果。Python同步原操作读取移出ASGI事件循环；相同卡片回执读取不再写updated_at并激发事件。发送立即呈现并清编辑框；ACK、流及终态只合并对应轮次，已完成历史保留；确定未发送会保留原文字且不覆盖后续草稿。
- 页面范围：官网／论坛／私聊／账户／通知／任务材料共享读取，以及后台模型、搜索、策略、推荐、规则、文件、维护、系统设置、消息、审计与治理等显示包装同步适配。写入／确认、原回执及真正材料硬期限保持原要求。
- 阶段检查：根与Admin TypeScript、前台25项定向检查、Admin真实hook的续读／离线／补发缺口／撤权、流解析与轮次合并、Go当前AgentOS／事件定向隔离PG检查、Python10项通过。后续仅补查CI与部署后的真实发送、切出切回和相关基础路径。

## 重构后的现行结构

服务器由 `go/cmd/galaxy-api`、`galaxy-worker`、`galaxy-information-worker`、`galaxy-publisher`、`galaxy-migrate`、`galaxy-lifecycle` 承担；Native由 `go/cmd/galaxy` 的native、integration-mcp、host、integration-host承接。Next官网与Admin/Payload分别运行，共用浏览器运行机制。

`packages/galaxy-contracts` 维护共同合同，`packages/galaxy-client` 维护浏览器／Node SDK，`go/internal/databaseschema/sql` 是132份迁移与四角色SQL的唯一现行来源，保留最高133与120空号。旧Core、Node CLI、Edge及Official业务树已移出整个项目，当前源码不保留替代内核或转发壳。

源码主库为公开的 `agigalaxy-team/agigalaxy`；银河自有代码Apache-2.0，第三方保留原许可。原公开仓库已整合并删除远端，原始Git历史及替代源码归档在项目外 `source-reviews/retired/`。现行产品、架构、开发、运维和公开说明集中在docs/；原始资料在originals/。

## 已有结果与实际边界

- Native原身份恢复码包含同GUID恢复、新设备／下一代码、本人临时本机页及原操作回执，空身份入口不强制创建新GUID。最终Windows候选包SHA256 `2727a62359fdb8cc1234b6e192152b5f25a29841daacd494c2674151ecc649cb`；实际用户宿主安装仍未验收。
- 保留Next/React、Payload、Keycloak、Prosody、Agno/AgentOS、LiteLLM、搜索、推荐和分析组件及必要平台helper。没有恢复广泛模型测试、压测、模拟活跃或资料填充。
- macOS、全部第三方宿主及用户真实本机安装、PostgreSQL／Prosody／对象存储联合整站恢复未完成平台验收。R13仍限已接通且获准动作，不表示开放任意全领域自动操作。

现行机制见[架构](docs/technical/architecture.md)、[AI运行](docs/technical/agent-runtime.md)、[部署](docs/operations/deployment.md)。本轮唯一操作日志位于项目外 `ops-log/operations/2026/10/2026-10-29-galaxy-reconstruction.jsonl`，部署与独立无头证据位于 `work/galaxy-reconstruction-implementation-20261029/`。不将旧版本运行记录混作本轮结果。
