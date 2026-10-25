# Node 与原生 AgentOS：当前接入合同

2026年10月24日按当前源码核对。原migration105/三个选定内容工具的首次接入记录仅保存在维护者工作区的日期归档中，不随本仓库分发。旧记录只涵盖首批工具；当前普通会话、跨模块查询、具体操作卡、AI工作账户及P13流程，以本页及仓库内链接的实现为准。与[服务README](README.md)共同使用，不从旧空配置示例推断现网模型为空。

## 两种身份与权限

| 原生身份 | 来源与权限 |
|---|---|
| `conversation:<UUID>` | 当前管理人员的普通工作台会话，不要求先创建自动执行grant；业务摘要/查询/卡片仍检查真人权限与当前AI岗位角色交集及用途/来源 |
| `execution:<UUID>` | 绑定当前真实grant、领域、对象、动作和版本的专项事项；人工参与与无人值守分别保留来源，既有HumanReview/P13等待不能被对话绕过 |

五AI岗位初始化没有业务角色或自动绑定，不借人的全站权限补权。Python service key只认证运行服务；客户端角色、prompt、模型返回的ID或Agno资源权限都不授予银河业务权。实际主导/权限定义见[账户说明](../../docs/operations-account-management-v1.md)。

## 当前源码入口

| 合同 | 当前入口 |
|---|---|
| Node组合与路由 | [server](../../packages/galaxy-official/src/server.mjs)、[HTTP dispatcher](../../packages/galaxy-official/src/adapters/http/operations-agentos-http.mjs) |
| 执行及私有网关 | [authority](../../packages/galaxy-official/src/operations-agentos-authority.mjs)、[gateway](../../packages/galaxy-official/src/operations-agentos-gateway.mjs) |
| 查询视图/过滤/对象 | [query schema](../../packages/galaxy-official/src/shared/operations-agentos-query-schema.mjs) |
| 具体操作与卡 | [action catalog](../../packages/galaxy-official/src/operations-agentos-action-catalog.mjs)、[岗位能力](../../packages/galaxy-official/src/shared/operations-ai-work-capabilities.mjs) |
| 原生会话与工具 | [conversations](src/galaxy_agentos/conversations.py)、[typed tools](src/galaxy_agentos/conversation_tools.py) |
| 运行数据与投影 | [conversation storage](src/galaxy_agentos/conversation_storage.py)、[read model](src/galaxy_agentos/read_model.py)、[tracing](src/galaxy_agentos/tracing.py) |
| 策略流程 | [P13合同及限制](P13_STRATEGIES.md) |

原三个选定内容工具仍服务于准确execution对象集合；普通会话另外使用current_summary、query_operations、read_operation_object、list_authorized_work、run_authorized_work、prepare_operation。工具可访问的模块/视图/过滤/动作始终由上表真实schema定义；推荐概览可读不代表已有推荐策略写入工具。

## 浏览器路径

所有相对路径以`/v1/operations/agentos`开头，当前实现由HTTP dispatcher定义。领域限定overview/governance/messaging/discovery/maintenance。

| 方法和相对路径 | 用途 |
|---|---|
| GET `/status`、`/options`、`/executions` | 当前运行/模型状态、可用专项授权与所属执行记录 |
| POST `/executions` | 依当前grant与准确对象创建专项事项，不是发起普通聊天的前置条件 |
| GET `/executions/:uuid` | 当前所属专项详情 |
| POST `/executions/:uuid/events`、`/runs`、`/review`、`/continue` | 原事项状态、运行及真实暂停续行 |
| GET `/conversations/:domain` | 当前人员/领域/岗位会话 |
| POST `/conversations/:domain/runs` | 沿原turn/operation发起普通会话运行 |
| GET `/conversations/:domain/operations/:uuid` | 查询原会话操作结果；丢ACK不重发新操作 |
| GET `/conversations/:domain/cards/:uuid` | 读取服务器准备的具体业务卡 |
| POST `/conversations/:domain/cards/:uuid/confirm` | 人工点击后复核当前身份/岗位/对象/版本并执行原意图 |
| GET `/runs`、`/runs/:runId` | 当前audit.read准入的全局原生运行元数据与步骤；不授予业务正文 |

一般业务卡处理已登记的治理、反馈、文件、消息计划状态、策略控制、搜索/规则已保存版本等；对象/CAS由服务器准备。不能由模型提交任意SQL、URL、文件、actor或长期授权。请求Body、查询参数、会话/CSRF和当前权限都按真实dispatcher/schema，不复制旧DTO作为另一个接口权威。

## 配置、迁移与私有边界

Node的`GALAXY_AGENTOS_CONFIG_FILE`严格使用[configuration loader](../../packages/galaxy-official/src/infrastructure/operations-agentos-configuration.mjs)接受的version/endpoint/url/signingKey/serviceKey。`allowInternalHttp`不是此JSON字段。Python的独立`GALAXY_AGENTOS_ALLOW_INTERNAL_HTTP`与Node合同分开，配置见[config.py](src/galaxy_agentos/config.py)。运行地址/凭据必须从当前受保护配置取得，不能复制历史主机值。

原生Agno使用独立PG身份/数据库，不直接取得业务表权限。Node使用选定发行完整迁移registry和SQL角色；当前源码最高124、实际序列没有120。只执行105或复制早期SQL片段不足以接通会话/卡/岗位/策略；API启动不自动迁移。

只有精确私有POST `/v1/internal/agentos/authorize`与`/v1/internal/agentos/tools/execute`接收运行服务身份，必须在解析/委派前验服务凭据，公网Caddy和admin BFF拒绝该前缀。Node依据当前PG真源做授权；正常浏览器不能直接持有这些密钥或原生数据库凭据。

## 模型、持久化与实际结果

源码允许没有模型的部署，但当前服务器已有人工模型及真实调用记录。模型/场景/上下文/输出/思考/协议由人工配置，[LiteLLM网关](../galaxy-model-gateway/README.md)负责原生转换；没有备用授权不偷偷换模型，无温度或银河预算产品。

原生会话保存用户输入/最终回复，Node绑定受控来源并在失效时轮换/停止返回相关历史。工具参数/结果、事件body和additional_input按真实存储适配投影；只设置store_tool_messages=False不足以覆盖所有持久写入。Trace仅导出获准元数据，缺失token/输入输出保持未知或withheld，不编造重试数、内部思考或全量材料留存。

原生queue runId、Node turn/operationId和业务效果operationId各自保留。未知结果查询原账本和原生运行；业务效果回读原receipt，不用再次模型调用猜结果。暂停/停止限制后续推进，不声明撤销已提交副作用。

## AI部署与核对

读取选定冻结源、运行元数据、受保护配置引用、完整迁移/SQL角色和当前用户目标后再接线。先确认服务与模型状态，再按当前人/AI角色与具体业务路径核对；健康200或一次问答不替代所有工具真实效果。无权、未配、服务失败、对象冲突各自保留，不改写为假成功。只对改动跑必要检查；本次文档没有修改模型、权限或运行服务。
