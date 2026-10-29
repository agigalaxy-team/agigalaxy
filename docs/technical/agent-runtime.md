# AgentOS、模型网关与固定策略

Python Agno AgentOS负责原生会话、run、持久队列与HumanReview；Go负责业务计划、当前权威、命令和回执。通用授权及未知操作处理见[接口](interfaces.md#管理身份与原操作)，部署发行见[部署](../operations/deployment.md)。本页只保存原生协议、存储和配置合同。

## 构建与配置入口

AgentOS依赖以 [`requirements.lock`](../../services/galaxy-operations-agentos/requirements.lock) / `pyproject.toml` 固定Agno3.1.7，入口 `python -m galaxy_agentos.app`，从仓库根构建：

```sh
docker build -f services/galaxy-operations-agentos/Dockerfile .
```

Gateway从 [`SOURCE.json`](../../services/galaxy-model-gateway/SOURCE.json) 固定LiteLLM源提交、原uv.lock、Rust扩展与proxy extras，不替换同名PyPI版本、不安装enterprise。原文和许可证范围见[源码与许可](source-and-licensing.md)。

```sh
python services/galaxy-model-gateway/prepare-source-context.py --output <新context> --archive <固定提交.tar.gz>
# --download 只获取SOURCE.json的准确公开提交。
docker build -f <新context>/services/galaxy-model-gateway/Dockerfile <新context>
```

Go通过 `GALAXY_AGENTOS_CONFIG_FILE` 读取严格 `{version:1,endpoint,url,signingKey,serviceKey}`，加载器归 `go/internal/runtimeconfig`。endpoint匹配业务地址，url为无路径/query/凭据的HTTPS或允许loopback HTTP origin；`allowInternalHttp`不是该JSON字段。Python `config.py`独立读取 `GALAXY_AGENTOS_DATABASE_URL`、authority URL/verification/service keys、Gateway origin/key和模型bindings引用，Python的 `GALAXY_AGENTOS_ALLOW_INTERNAL_HTTP` 不能复制到Go业务配置 JSON。签名/验签与双方service key须匹配；Agno用独立PG身份/库/schema，不访问业务表。Go按同发行完整registry/SQL角色部署，初始迁移105不代表完整接线。

原生监听限选定私网/loopback。`/v1/internal/agentos/`先验服务身份再解析闭合请求，公网/BFF拒绝；Python `/galaxy/`元数据走外层service key，业务/run另核原生JWT，不误送service key到JWT parser。

## 会话、专项与后台任务

| 原生subject | 可信坐标/消费者 |
|---|---|
| `conversation:<UUID>` | 当前person/session/domain/AI账户的普通会话，无需创建automation grant；原生RunContext提供session/run，原操作提供turn |
| `execution:<UUID>` | 已准备的grant、领域、对象、revision和intent，沿专项事项及真实HumanReview等待 |
| `autonomy:<UUID>` | Go的稳定AI账户、计划、task、purpose/versions；不携带管理浏览器会话，River调度原任务 |

conversation工具源为 `conversation_tools.py`、共享 `galaxy-contracts/src/operations-agentos-query-schema.mjs` / action catalog：current_summary、query_operations、read_operation_object、list_authorized_work、run_authorized_work、prepare_operation分别对应当前摘要、闭合查询、精确对象、获准事项、原事项接续和操作卡准备。Go收到 `{conversationId,sessionId,turnId,runId,callId,tool,arguments}`，这些可信坐标不是模型参数。字段/动作随代码维护，不复制固定工具数；通用查询不接受任意SQL/HTTP或整项command。

浏览器 `/v1/operations/agentos` dispatcher提供status/options/executions；原execution的events/runs/review/continue；按domain的conversations/runs、operations/:uuid、cards/:uuid及confirm；全局runs仅audit元数据。实际方法/DTO由dispatcher/schema定义。准备卡必须同时有 `state=prepared`、`card.state=prepared`、真实cardId，preparationFeedback只扩充原结果说明。一般查询仅返回显式安全投影；公开帖子/回复仍带受控来源，私聊/案件/反馈/邮件正文不因模块名或workbench.read进入通用对话。选定内容工具从execution当前选集取引用，不把空集合扩大为全站，不产生画像事件。

`duties.py` 注册AgentFactory `galaxy-duty`，accept与durable claim时按task取冻结策略/提示词，读取当前人工模型文件构造Agent；活动leg绑定实际模型版本，人类暂停续接保留前后版本。私有task路由同时要求 `X-Galaxy-Service-Key` 与匹配task/plan/account/delegation的 `autonomy:<taskId>` JWT：

| `/galaxy/autonomy/tasks/:taskId` | 输入/效果 |
|---|---|
| POST `/runs` | 空 `{}`、Idempotency-Key=taskId；原生queue去重，不接prompt/model/tool列表 |
| GET 基础路径 | 读原owned run；无记录为NOT_RECORDED |
| POST `/cancel` | 同空body/key；Go先fence，原生停止旧run |
| POST `/continue` | 同空body/key；仅真实PAUSED、原pending tools与Go原结果/人决匹配时原run原ticket续行 |

callbacks为固定private prefix的autonomy/authorize、tools/execute、report。waiting-human在post-tool barrier建立external-execution requirement，续接只注入原操作结果，不再运行writer。人类会话可带taskId进入原卡路径，不把cancelled run重启成后台工作。queue并发2、max_attempts=1、SDK外层3600秒；task冻结roundSeconds为30..3600（默认600），旧任务缺值才用 `GALAXY_AGENTOS_WORK_TIMEOUT_SECONDS`。timeout先写原生cancel cause再取消，Go代码动作也查deadline；事项重叠/事件合并由Go处理。

值守结束由模型目标评估、原生模型状态、真实业务回执分别表达。`assess-task`只声明冻结目标是否满足以及剩余读取、动作或人工事项，不能证明业务效果；评估落在原任务工具账本，其他工具开始或完成后使旧评估失效。Go汇总全部原业务回执和未决写调用：未知写入不能被一次成功读取或模型的完成声明覆盖，失败回执不能变成成功。普通剩余工作在同一个原生run内继续模型与工具步骤，复用原messages、checkpoint和实际调用计数，期限仍是本轮roundSeconds；真实人决暂停优先于补续。连续结束却没有进展时记录技术失败，不编造人工决定。`reconcile-task-operations`只按本任务已经落账的callId、参数和operation核查未知写入，不接受模型提供新操作编号，也不重发原writer。

读取覆盖由原工具账本核对，不能用模型的`goalSatisfied`覆盖尚未取得的结果。跨Go的不可用/非法请求，以及Duty本地Pydantic拒绝的读取，都记录在同一任务账本；本地记录只保合法route/scope与歧义状态，不保非法正文或产生业务效果。同callId只能确认同工具、同可证范围的原失败记录，不能吞掉冲突。参数修复提示由既有发布schema生成，完整策略kind及唯一类名别名也从实际SDK schema提取。补续的进展按已取得事实、范围及真实回执去重，重复错误、新callId或新assessment编号不算进展。第二批已部署；真实巡检保住了未完成终态，但暴露出将所有有界分页都当作未完成读取的过严问题，不能据此宣称巡检已经可完成。

第三批源码增加空参数`inspect-operations`，固定`current-operations-v1`组合现有获准工作台聚合、维护组件/全平台队列、7天搜索与分析、30天推荐、有限分页的当前消息计划、当前在办任务及这些任务的原业务回执、当前委派实际目标的岗位要求。机械参数、目标枚举及必要分页由代码处理，首尾核当前权威；岗位要求只是配置数据。`inspectionChecked/profileComplete`只证明这个明确口径取得，不代表全库或全部历史已穷尽。工作台未授权附带项保null及排除清单；关键来源缺数据、未获准或受控来源扣留保持partial。合法榜单/最近页已取得可作为有界事实，样本及供给快照是否完整另列，不能迫使例行巡检扫描全站。真正全量目标仍需相应完整集合。后续读失败按真实规范化scope、窗口和分页坐标或固定inspect承诺的同范围自动关联；模型不再靠编写callId证明完成，未知writer、精确对象未读及范围歧义仍不能被聚合覆盖。此批实现待统一发布及新任务验收，原失败任务不改写为成功。

API能够连接AgentOS不证明Worker已加载相同运行配置。原health记录Worker实际加载的native配置事实和观察时间，缺观察或观察过期保持未知，不能以ready=true表示已经可以派发；配置就绪、Worker派发资格、原生服务和模型可用分别核对。程序规则也沿Worker的原任务transport回调API执行，免模型不等于免native transport。受保护配置可通过systemd `LoadCredential`提供给Worker自己的运行凭据目录，`GALAXY_AGENTOS_CONFIG_FILE`只指向该只读文件，不需要把Worker加入API账户组或复制原密钥到源码。

仅`operations_agentos_not_configured`这一明确发生于HTTP构建前的本地失败，可在修复配置后通过正式原任务reconcile恢复首次派发：先读原号得到`NOT_RECORDED`，再核原控制命令保存的故障前像、相同任务/配置版本、当前授权、无工具/业务回执/人工决定及并发资格，以CAS进入dispatch-recovering后仍用原taskId和原幂等键提交。保留dispatch_started_at及旧control回执；进入恢复提交后结果未知只核原号，不把网络未知扩大为重新派发资格。

## 持久化、调用与有限恢复

工作台发送先建立同一原操作的本地发送状态并清空编辑框，确认失败才退回文字，不覆盖后续草稿；结果未知只核对原操作。ACK、流式片段与精确原operation结果合并到对应轮次，保留已完成历史；初始进入及真实事件缺口仍可读取当前快照。读取资格使用`/qualification`单独续证，身份/来源真实失效仍执行原边界。 历史`/history`、操作卡`/cards`、沟通条件`/context`和总控管理能力`/management-capabilities`分别读取与呈现，任一慢源不阻塞其他区域。context只用原账本定位最新操作，不冒充模型终态；完成内容由原operation回执合并；同一轮次的并发读取合并，终态后首次取回失败继续核对该原操作，不重发消息。卡片按自身来源期限检查，不缩短整段历史资格。 已完成处理的摘要复用严格匹配的已落账终态回执；旧回执缺字段时按同owner、固定AI精确恢复，最多4路并行。单条不可用标明部分覆盖，不让缺少专项回调阻断整个摘要，也不把原对象引用当作当前读取授权。模型摘要反馈依据systemSupport、permissionAllowed、delegated分别给出功能接通、权限与委派事实，不从未授权推断未开发；后台接口与回执保留原始结构，模型只接收业务能力事实视图，不同时重复提供底层授权标志；时间仅转换本轮checkedAt，不从历史补造。管理能力的query/prepare投影各计算一次，摘要的处理记录、业务概览和管理能力并行读取，最终统一复核当前身份与来源。 固定动作和权限目录启动时解析并建索引，不能在每条权限核验时重复解码整份JSON；该索引只保存代码定义，实际人员、AI角色、委派及来源资格仍实时读取。纯读工具使用独立只读资格投影，保留首尾新鲜复核；角色目录读不持有角色更新锁，准备及修改操作保留原锁。自动运行概览按候选任务批量取来源引用，再执行原逐对象检查，不改变统计范围。定向轮次、工具和卡片事件只更新对应资源；补发缺口才重取历史快照。

`store_tool_messages=False`不清除RunOutput.tools或event body。`conversation_storage.py`对普通save、atomic error与attempt-fenced worker写共同投影，移除工具参数/结果、event body/additional_input，保闭合ID/错误/时间/metrics。用户输入/最终回答是会话历史，Go绑定来源失效时轮换/withhold会话；不宣称物理擦除旧行或新增保留期。Duty存元数据与真实usage，目的材料/卡/命令仍归Go账本。trace不含prompt/completion/tool正文或异常原文。

普通沟通成功准备操作卡后，以真实`state=prepared`、`card.state=prepared`和cardId为依据，只克隆本次FunctionCall的Function并启用Agno原生`stop_after_tool_call/show_result`，停止后续模型续答。流中工具前的临时文字沿原ToolCallStarted reset清除，工具显示及post-hook保存的最终沟通内容统一为程序的确认提示；失败制卡仍允许按原schema修参，不以停止异常伪造成功。该轮普通沟通的COMPLETED只表示制卡沟通已经结束，业务仍等待原卡人工确认，以后续真实业务operation回执判断效果；不把它改成无人能续接的原生PAUSED，也不将旧卡标记带入新重试轮次。这是当前源码实现，生产采用及真实卡流结果另按发布证据验收。

provider工具ID/UUID5配对规则见[接口](interfaces.md#管理身份与原操作)。调用计数在实际provider入口、current authority后、attempt fence内记账，包含follow-up；metrics.details分组不是次数，token取SDK累计值，旧无计数行未知。暂停续接duration累计活动时段，排除等待。async admission/history/model授权以threads卸载阻塞IO且保ContextVars，同步模型入口沿原线程；调用前后均查当前session/source。模型版本在provider调用前与attempt/owner/status CAS共同保存，缺版本不以当前配置回填。

会话失败重试由Go核同person/岗位/原失败operation且尚无业务处理，沿固定SDK的原checkpoint先建独立重试run，再走公开continue；后台保存、事件和工具上下文均绑定新ID，原失败记录不变，不追加用户消息或清未发送草稿。已知native runId时精确按主键读取并核owner/session/operation及重试父链；未ACK时先查原ticket；detached无ticket则按同owner/session/agent/operation精确定位唯一ID，再查主键和父链，歧义或不符拒绝，不扫描整段历史。临时授权服务故障只有当前资格恢复且原业务账本明确未执行时，才允许人工显式重试；真实撤权与未知业务结果不适用。工具只修复当前schema支持的表示格式，临时只读失败有限重取；慢读或连接池超时不立即整次重做，写入不自动重发。请求取消仍结束实际业务，另用短期上下文保存已观察工具结果，迟到失败不能覆盖已完成账本。人工配置的备用模型仅在单次模型请求边界使用，保已完成工具结果，流式失败片段不拼接备用回答。Gateway单alias路由本身无fallback/retry；AgentOS只使用明确批准且场景兼容的fallbacks，两层不能混同。

AgentOS在单次provider调用内，对可信provider的408、429或5xx最多追加一次同模型请求，间隔0.25秒；不重跑Agent/tool循环、不改变模型配置或备用列表。每次请求重新核当前权威并按实际provider入口记账，同模型SDK嵌套调用只由最外层决定重试，计数不因包装重复。两次请求各用独立messages快照，重试前仅原地恢复SDK本次assistant消息的局部状态，不回退run、实际usage或首个失败账本；第二次错误保留原错误。流式一旦交付任何chunk便禁止重试，异步取消直接传播。此为第二批源码实现，不能把有限重试解释为上游故障已消失或原失败任务自动重新运行。

## Gateway原生准入与模型配置

ASGI wrapper监听loopback（默认127.0.0.1:3351），强制独立至少32字符service key；每路由恰好一个Bearer头，原生custom_auth再次准入。允许GET `/galaxy/status`、`/galaxy/usage?days=7|30`、`/v1/models` 和POST `/v1/chat/completions`、`/v1/responses`，拒绝其他query/路由、provider override、管理端点和调用者logging metadata。请求≤2MiB；已配置调用还须五domain之一 `X-Galaxy-Model-Scenario` 及匹配 `X-Galaxy-Model-Config-Version`，模型仅注册 `galaxy-*` alias。

operator挂载的model_list含model_name、litellm_params(model/api_base/api_key)和闭合model_info；provider前缀/HTTPS或loopback地址显式给定，key只能引用 `os.environ/GALAXY_MODEL_PROVIDER_<NAME>_KEY`。空models/bindings是源码默认，不推断现网。AgentOS scene映射overview/governance/messaging/discovery/maintenance至alias、dataPolicyApproved、runtimeProfile；拒绝非空旧直连provider变量，ambient OPENAI_API_KEY/LITELLM_API_KEY不启用场景。Chat/Anthropic/Gemini走OpenAILike，Responses走OpenAIResponses；调用前后核scene/authority/catalog版本。

人工model-settings应用通过独立读/configure/apply权限及版本/CAS，root控制器编译保护文件、重启固定服务对，回读双方版本；不可变credential refs不覆写旧已采用版本。私有 `/galaxy/model-settings` 返回绑定元数据，gatewayAvailability=not-checked。配置归属的共同说明见[接口](interfaces.md#权威边界)。

galaxy_profiles约束协议、context/output、reasoning、timeout及tools/structured output；LiteLLM做协议转换，本地native counting估计输入并预留output，不可计数/超窗拒绝，不截断。裸root推导OpenAI `/v1`、Gemini `/v1beta`，保自定义prefix，完整inference endpoint归一至协议base，原人工输入与host/credential绑定不改。response guard拒HTML、非法JSON、空completion和不完整SSE，承认真工具调用/refusal；headers后失败发闭合stream error，可修正本次ledger终态但保实际token，不改历史。

遥测import前关闭，cost map本地模式，服务entry抑制库stdout/stderr/logging。唯一callback/SQLite ledger保callId、scene、alias、configVersion、outcome、duration、实际token及coverage；重复callback更新原call。无正文/URL/供应商错误/成本预算，不是计费账本或exactly-once保证。

## 定向检查与诊断

持久化测试须全部显式设置 `GALAXY_AGENTOS_TEST_DATABASE_URL/NAME/ROLE/SCHEMA`，名称 `galaxy_agentos_test_`、loopback显式端口、专用受限owning role；只读预查实际库/用户、危险权限、成员与所有权后才交Agno，无runtime fallback。SQLite夹具不覆盖durable PG queue。纯拒绝入口：`python -m unittest discover -s services/galaxy-operations-agentos/tests -p test_database_contract.py -v`。

provider reference和analysis语义测试分别用 `test_provider_call_references.py`、`test_analysis_semantics.py`，安装锁定Python/根Node依赖，将service src/tests加PYTHONPATH，Node从PATH发现，默认消费本仓实际源码。Gateway各native test_gateway/test_model_profiles/test_provider_failure_native模块须独立Python进程，LiteLLM的app/config/callback为进程全局。

`deploy/duty_probe.py`默认只读原task；dispatch-once是已授权task的真实模型动作，continue-once消费已解决人决，不用作连接测试。初装空配置检查认证status/catalog、无认证401、completion在读prompt前503；缺service key启动失败、scene未配保agentos_model_not_configured、目录版本不匹配拒绝。具体检查层次见[开发](development.md#故障定位与未验证范围)。

## P13固定Workflow与普通维护

固定 `galaxy-p13-selected-content-v1` version1复用Agno3.1.7 Workflow，注册ComponentType.WORKFLOW并去连接配置；发布定义漂移拒绝，改模板需新ID/version，旧在办版本仍可加载。Go存目标/策略/样本/演练/执行绑定，原生存workflow/ticket/run/steps/pause。只连接已准备的单个公开post/reply content-visibility命令，经execute-prepared-command及原领域回执；数值判定复用P14三值计算，P14引用仅new-writes-only，不能提供可见性授权。

四种主导路由为固定代码、复杂语义adviser、普通人工、显式pause。semantic无模型不入queue，code/human可无模型，adviser无effect工具且只存闭合决定，公开正文瞬时使用、不进workflow input/memory。Agno3.1.7的Condition内Step不执行自身pre-step human review，所以采用顶层dynamic output-review Step，续接读原native requirement。native retry attempts=1、step retries=0。

普通工具read-selected-strategy、save-selected-strategy-draft、publish-selected-strategy只处理P10 grant/P105 attested execution选中的strategy UUID；权限为strategies.read/ordinary.configure/ordinary.publish。ordinaryBounds:null不给范围。允许人给定范围内textLength/linkCount/attachmentCount原rule-index数值、获准mode/日常启停，不改field/operator/结构、目标边界、重要人工策略、待决人工草稿或模型。发布使用人工选择的样本完成当前program qualification，只影响新事项，保同一不可变样本祖先。

部署按完整registry包含对应P13结构/API grants，不给Worker新增P13写或Python业务表权。Go与新native image同批，私有p13/context、p13/step先验service key，native核execution JWT、matter、workflow、session与最新context。health必须回读固定workflow ID/version；启用前由人提供目标、策略、样本与成功分类演练，初始空/停用。它不接消息发送、文件purge、整站恢复、任意参数维护或自动全领域事项发现。

AI查询和准备卡使用持久绑定的人员与AI上下文，由共同主体接口核对当前身份并锁定主体行，不冒充浏览器会话。query只读；stored prepare可读目标并准备卡，不能直接执行业务写入；人工确认、Duty及Execution仍使用各自正式入口。服务未接通、读取失败、对象变化与真实失权分别反馈，内部错误码进入诊断记录；普通对话不因无关状态预读失败而改成重试。

## 总控跨模块覆盖与验收边界

岗位名称组织职责，实际能力由当前AI角色、工具接通、委派、计划、策略、自动授权和具体来源共同决定。下面区分当前源码链与本轮真实验收，不能用一个岗位的模型回答或单项通过替代全表；未变范围的既有有效证据可以复用，不为补表恢复压测或批量填充数据。

| 能力 | 当前模型工具与真实业务入口 | 本轮证据及剩余边界 |
|---|---|---|
| 其他AI角色与岗位要求 | `read-ai-delegation`、角色/提示词专用工具；人工卡与Duty委派分别办理 | 当前总控正式权限/四目标委派已配置；岗位要求已通过真实卡修改及新操作恢复。成功制卡后的原生停步已在源码实现，生产卡流尚待采用验收。不得修改自身上限、共享/人员角色或模型。 |
| 完整策略与普通日常维护 | 精确策略版本读取、完整草稿/预演/发布卡；ordinary专用工具仍按原bounds | 完整链源码及定向PG检查已完成，生产模型卡链待验收；完整目标、结构和授权变更仍人工确认，不能由ordinary权限扩大。 |
| 自动任务与结束判断 | 原task/Agno durable run、assess、同run补续、原操作reconcile、Worker健康 | 总控首任务已沿原号恢复并产生6次真实provider调用；无业务写入。模型虽结束，读取账本仍有未补齐的消息/任务读取，不能接受其“全部核实”声明；第二批已实现读取覆盖与参数修复闭环，待部署后新任务验收，旧任务历史保持原样。 |
| 用户账户业务限制 | 当前账户读取、`account-restriction`及原限制/解除回执 | 源码接通；本轮总控真实限制与恢复未验收。账户密码、登录、会话及管理人员权限不因该业务动作获得自动处理权。 |
| 公开治理、举报申诉 | 选定post/reply与公开案件材料、visibility/curation/batch/case-resolve | 本轮已正常创建一个受控公开对象，selected自动处理及原状态恢复待执行；原人类/其他授权处置不能被新AI决定覆盖。 |
| 线索触发的私聊审查 | 精确chat-report引用、用途限定材料及已选消息处理 | 源码有专门用途支路，本轮真实线索/材料/消息回执尚未覆盖；普通目录或workbench.read不能扩大为任意私聊读取。 |
| 使用反馈 | 目录、完整单项正文、CAS更新与原回执 | 本轮已正常创建受控反馈，原state/category/module及note前像已保存，待总控实际处理后恢复；不擅自写备注。 |
| 文件与具体任务 | 文件元数据、scan retry、access stop/restore及受限job操作 | 源码接通，本轮实际对象回执待覆盖；重排扫描不等于扫描成功。具体清理批准及整站恢复仍沿人工方案，不开放任意文件/命令操作。 |
| 消息与实际投递 | 草稿精确完整读取、create/save、原计划操作、run/recipient回执 | 草稿读写入口已存在；第二批已实现完整发布审阅与原命令精确恢复，待部署。受控单账户inapp实际投递待验收，卡prepared不证明发送，SMTP既有证据不要求重复外发。 |
| 分析、画像与推荐 | 固定分析视图、真实窗口/覆盖、推荐soft direction及原回执 | 只依据实际收集与允许用途，保unknown及分母口径；本轮总控跨模块模型调用/方向恢复待覆盖。通用工具当前只接软方向，不因此宣称主题目录/映射的全部管理已接入。 |
| 搜索 | 当前统计与配置、草稿保存及精确版本设置读取、apply/restore完整审阅 | 第二批已接 typed草稿、Duty范围核验和完整审阅；eligible创建、selected拒绝创建及旧revision拒绝已有隔离PG结果。模型完整创建→审阅→应用→恢复链仍待部署及真实验收，不用摘要或版本号代替完整设置。 |
| 运维、告警与来源 | 当前组件信号、任务、获准日志/备份方案等安全投影 | 可用范围以每次返回coverage/basis为准；本轮总控跨模块读取及实际告警路由待覆盖。Worker自检不是独立监测，标签不证明已送达；不自动改变模型、凭据或生产恢复方案。 |

selected只证明明确对象范围。`eligible`必须显式批准，并由当前来源、策略条件、CAS及原人工决定等固定资格检查约束，才包含以后出现的新合格对象；现有scope并不支持任意账户/状态谓词，不能只写在prompt里就声称程序强制。持续全对象能力的验收须保持原授权/策略版本，新增来源后取得新task与真实业务回执，并保不合格来源无写入的对照；本轮尚未取得这组真实证据。
