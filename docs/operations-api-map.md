# 后台接口与权限权威地图

2026年10月24日按当前源码定位。这里是模块导航，具体路径、方法、DTO、错误和当前授权以各dispatcher及其shared schema为准，不另建第二份路由注册表。已登记的[开发API目录](development-api-reference-v1.md)只涵盖其显式子集。

| 领域 | 真实dispatcher | 含义与边界 |
|---|---|---|
| 网站用户与参与 | [operations-registered-users-http.mjs](../packages/galaxy-official/src/adapters/http/operations-registered-users-http.mjs) | 常用用户目录和认证操作；网站账户自身入口另在official-account-http.mjs |
| 管理账户 | [operations-management-accounts-http.mjs](../packages/galaxy-official/src/adapters/http/operations-management-accounts-http.mjs) | 独立管理域、根/管理员资格、临时密码、资料/状态及会话 |
| AI工作账户 | [operations-ai-work-accounts-http.mjs](../packages/galaxy-official/src/adapters/http/operations-ai-work-accounts-http.mjs) | 五稳定岗位、零默认权限、业务角色及自动执行绑定 |
| 角色与自动授权 | [operations-permissions-http.mjs](../packages/galaxy-official/src/adapters/http/operations-permissions-http.mjs) | 当前PG权限、角色/人员关系、动作与对象条件；不采用客户端权限快照 |
| 业务审计/概况 | [business-admin-http.mjs](../packages/galaxy-official/src/adapters/http/business-admin-http.mjs) | 业务记录的分页、筛选、详情；运行日志另在维护 |
| 公开帖子/回复 | [operations-forum-content-http.mjs](../packages/galaxy-official/src/adapters/http/operations-forum-content-http.mjs) | 来源/版本/受众、单项/逐项批量治理、编排 |
| 一般治理/资源/文件 | [operations-business-http.mjs](../packages/galaxy-official/src/adapters/http/operations-business-http.mjs) | 当前业务对象读取与受控操作，不能用表元数据代替源资格 |
| 私聊案件 | [account-chat-governance-http.mjs](../packages/galaxy-official/src/adapters/http/account-chat-governance-http.mjs) | 本人提交与独立管理取材；不等于全站私聊检索 |
| 消息级处置 | [operations-chat-message-http.mjs](../packages/galaxy-official/src/adapters/http/operations-chat-message-http.mjs) | 可逆运营屏蔽，当前读取及他案贡献独立 |
| 普通反馈 | [operations-feedback-http.mjs](../packages/galaxy-official/src/adapters/http/operations-feedback-http.mjs) | 私有使用反馈与状态；不混入画像或案件取证 |
| 文件访问/清理 | [operations-file-access-http.mjs](../packages/galaxy-official/src/adapters/http/operations-file-access-http.mjs) | 另见operations-file-cleanup-http.mjs；具体清理计划每次人工确认 |
| 公告/站内信/邮件 | [operations-messaging-http.mjs](../packages/galaxy-official/src/adapters/http/operations-messaging-http.mjs) | 计划/受众/运行/收件人账本；SMTP另有operations-smtp-http.mjs |
| 使用分析 | [discovery-runtime/http.mjs](../packages/galaxy-official/src/discovery-runtime/http.mjs) | GET /v1/operations/discovery/analytics；当前analytics.read，kind/days/scope/accountId按该层校验；不是推荐dispatcher |
| 推荐/搜索运营 | [operations-recommendation-http.mjs](../packages/galaxy-official/src/adapters/http/operations-recommendation-http.mjs) | 搜索配置另见operations-search-quality-http.mjs；公开事件/搜索/推荐读取另在discovery-runtime/http.mjs，当前资格分别核对 |
| 策略/规则 | [operations-strategies-http.mjs](../packages/galaxy-official/src/adapters/http/operations-strategies-http.mjs) | 另见operations-rules-http.mjs；实际消费者/发布/采用分别记录 |
| 工作台AI与运行 | [operations-agentos-http.mjs](../packages/galaxy-official/src/adapters/http/operations-agentos-http.mjs) | 普通conversation、具体卡、专项execution及全局元数据分别准入 |
| 人工模型设置 | [operations-model-settings-http.mjs](../packages/galaxy-official/src/adapters/http/operations-model-settings-http.mjs) | 人工专有配置/应用，不从AI角色或普通规则得到修改权 |
| 系统设置 | [operations-system-settings-http.mjs](../packages/galaxy-official/src/adapters/http/operations-system-settings-http.mjs) | 常规/邮件/业务服务/高级四固定页签；原CMS独立 |
| 运行/备份/恢复 | [operations-maintenance-http.mjs](../packages/galaxy-official/src/adapters/http/operations-maintenance-http.mjs) | 只在获准具体计划/原生贡献范围；生产恢复仍关闭 |

## 入口与执行身份

浏览器从独立管理登录到Next BFF，经精确路径、当前Cookie/CSRF与服务授权进入领域服务。业务角色分配给不可变管理ID；AI岗位有自己的角色，受托查询/卡/执行以人的当前权限和岗位角色取交集。自动执行grant另核当前岗位、动作、对象条件和原版本，不因人可以聊天而自动获得无人值守写权。

[当前AgentOS合同](../services/galaxy-operations-agentos/AGENTOS_INTEGRATION.md)区分普通会话与专项事项。`/v1/internal/agentos/`只供受保护服务调用，不经公网/BFF；运行service key也不是管理员业务角色。

普通聊天具体业务动作必须先准备对象/动作/影响卡并由人点击。未知结果查询原操作；暂停不撤销已提交效果。权限、源状态、版本变化时重核，模型输出或旧preview不能授予新权限。

## 版本与数据说明

源码包的0.1.0不是部署发行API71，Native19亦独立发布。[版本合同](version-contract.json)保留协议/本机格式的比较值，迁移表按当前登记序列列明，未登记120；[数据清单](data-inventory-v0.1.json)是源码声明索引，包含当前owner-export集合和独立存储差额，不等于全站恢复或逐表生命周期验收。

## AI Agent 部署与核查

先定位当前发行/冻结源、管理realm、受保护配置引用及所需业务权限；只读取必要元数据，不打印凭据/会话/原文。按同一发行迁移及SQL角色处理，不从本图推断可执行全部动作。选择实际用户目的核对正常/无权/冲突/未知结果接续；源码有dispatcher不等于真实非空数据和外部依赖已验收。部署入口见[部署指南](deployment.md)、[账户说明](operations-account-management-v1.md)、[系统设置](operations-system-settings-v1.md)与[运行栈](operations-stack.md)。
