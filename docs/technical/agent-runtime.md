# AgentOS、模型网关与固定策略

Python Agno AgentOS负责原生会话、run、持久队列与HumanReview；Go负责业务计划、当前权威、命令和回执。通用授权及未知操作处理见[接口](interfaces.md#管理身份与原操作)，部署发行见[部署](../operations/deployment.md)。本页只保存原生协议、存储和配置合同。

## 工作台上下文与会话压缩

工作台首次显示最近五个逻辑轮，顶部“更多历史记录”每次再加载五轮并保持可见位置。历史按现有会话归属读取已保存的消息、时间、卡片及结果，刷新前后的内容和操作保持一致。卡片列表直接呈现保存状态，不恢复执行、不逐卡核对业务来源、不续证或自动重试。实际点击确认或取消仍由原业务接口核对条件。加载与翻页不触发模型反馈；本页新点击确认后，原连续任务仍按既定流程接续。已完成消息不因后续事件重新读取原运行。显示分页不删除历史、业务记录或审计，也不裁剪模型上下文。程序固定要求和本轮岗位要求进入 system，当前提问为 user；历史和摘要只作资料引用。

模型的可选 `contextCompression` 配置贯通银河表单、Go 版本与变更记录、维护程序编译、AgentOS 及网关。字段为 `enabled`、`triggerPercent`、`recentTokens`、`summaryTokens`；缺省有效值为 true、80、8192、2048，不回写或迁移旧版本。近期原文和摘要设置是上限，按主模型及直接备用模型的最小可输入容量缩小；已有最大输出仍预留，摘要不会另选供应商或凭据。缺少有效 runtimeProfile 的旧接入不猜测模型容量。

实现按能力择优：复用 Agno 3.1.7 的消息配对边界、压缩记录/重建和工具循环接口；参考 [DeepSeek Harness 的预算与提交机制](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction/compaction-basic/src)及 [OpenCode 的上下文接续](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts)，不引入它们的 TypeScript 运行时，也不采用静默遗漏旧记录或新增后台预计算。银河适配负责完整输入估算、当前运行计量、历史资料角色、摘要完成检查及保存成功后采用。估算包含系统要求、工具定义和本轮文本，并保留余量；tiktoken 在镜像构建时预缓存常用编码，运行时不为取编码下载数据。该估算不是供应商实际用量，网关仍执行最终容量准入。

历史归并保留近期原文并将较早消息按角色和标识作为 JSON 资料分批摘要；批次按完整摘要请求预算合并，不每条消息都调用一次。摘要与本轮工具结果压缩分别使用 Agno 的 Compaction 和 CompressionManager 接点，调用沿当前模型、身份与原运行计数，工具压缩只设置 `compressed_content`，不改变原工具正文或配对。空摘要、上游截断、超出目标或明确保存失败均不切换历史视图；长度不符至多再尝试一次，不靠截断摘要制造成功。原生规划器的 500-run 窗口前增加短轮归并保护，无法保存时停止继续滑出历史，不静默忽略早期轮次。

不会将压缩归档变为绕过当前权限的搜索工具。历史和摘要保留原会话归属；后台任务、私聊及业务回执的存储边界不因本功能改变。超大单次输入、多模态计数差异及不可缩小的当前请求仍可能被网关拒绝，不保证任意输入都能放入窗口。实际 PostgreSQL durable queue 的首次摘要行、attempt CAS 和归档已在隔离 schema 验证；正式工作台真实供应商沟通已通过，仍不等于供应商摘要保真效果已全面验证。数据库提交成功却返回异常的不确定状态继续保留恢复边界。

模型配置服务在启动时读取 `control.json` 的固定 Compose 引用。运行发行必须同步更新该引用中的引擎镜像和维护服务采用结果，不能只替换正在运行的容器；否则下一次应用模型设置会从旧描述重建旧镜像。本批合并原有 AgentOS/Gateway 服务描述、保留受保护环境文件引用和挂载，配置内容与程序发行分别管理。

## 连续业务处理与聊天确认

会话沿用 Agno 原生工具循环，银河在模型响应边界驱动同一原任务。`plan_turn` 只声明当前准备数量等子约束，不限定整个任务只有答复或制卡。`assess_turn` 根据当前工具事实、原目标和剩余工作判断继续、完成、等待确认、等待结果、缺少信息、受阻或中断；新活动使旧评估失效。Go 在原 commands.result 中持久 taskProgress，原操作、重试和确认反馈归属同一根任务；native COMPLETED 只说明本次模型运行结束，不代表业务目标完成。剩余工作非空、当前仍有待确认卡或未知业务结果时不得标任务完成；历史失败和取消保留，但不永久阻止后续有效评估。

没有固定接续轮数。相同事实和相同待处理步骤形成的实际循环可判受阻；既有运行时间上限只产生中断，不冒充完成。程序固定边界和新撤权继续生效，未知写入仅核原操作，不重发。卡实际准备齐后等待人工；确认回执作为中间结果，同owner精确读取的原目标及剩余工作交回模型，允许继续查询、准备下一步或最终完成，不将短反馈消息替换成新的全部目标。原目标取不到时明确停止接续，不猜测，也不增加私有全文的第二份持久存储。

参考的是 [OpenCode 的流事件、工具状态与 stop/continue 分流](https://github.com/anomalyco/opencode/blob/fe8cd6596f997aba13a0fcab6baf1e2b5a0178bc/packages/core/src/session/runner/step.ts)和 [DeepSeek Harness 的 agent 循环](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/agent-loop/src/agent.ts)中的分层方式：分别处理步骤结果、是否继续、工具待决及停止原因；未移植其运行时。Agno 的 followup 建议不当成业务执行接续；模型答复完成、卡已准备和业务完成继续分别记录。

确认卡归属原 `turnId`；`presentation` 提供业务摘要、变更、影响与限制，不把原始命令 JSON 当正文。完整配置按冻结前后源比较，只展开相关差异；缺块或重要变化无法翻译时不可确认。岗位要求仍用专用全文审阅。`choice` 仅表示明确的互斥备选，服务端按原轮事务控制数量和选择；选择一项即关闭其他项。操作侧栏仅摘要和只读详情。普通回复使用业务名称，不复述内部命令或编号；执行反馈只向模型提供业务化差异、真实状态与摘要，原卡和原操作关联仍由服务端保留，不把展示省略当作删除审计。

保存记录读取与实际执行分开：原操作记录按当前会话归属及精确原号读取，内网使用仅限该 GET 的 conversation-record 签名；不为展示反复核对整段聊天的业务来源。新模型调用、工具、确认及取消仍使用正式执行权限和对象条件。显式重试确认后的回复时，沿同主体、同卡及原反馈链承接原回执，不重复确认业务。沟通状态续期只核当前身份和会话，不回读旧业务资料。同一任务的有序保存卡和结果作为工作进展进入模型上下文，防止只见最后一卡而重复已经完成的步骤；记录不提供新授权，未记录的原始基线不能猜测。

新确认的终态卡经 `/cards/{id}/feedback` 自动接续结果说明；固定操作号派生自原卡，GET/POST 始终关联同一原操作和当前人/固定 AI。反馈是原回执资料，不是新的用户授权；未知业务结果只读恢复。旧已执行卡不因升级或浏览历史自动补发模型请求。历史展示保存的消息和卡片；原执行记录继续用于当前任务和审计，不为展示恢复旧运行。

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

conversation工具源为 `conversation_tools.py`、共享 `galaxy-contracts/src/operations-agentos-query-schema.mjs` / action catalog：current_summary、query_operations、read_operation_object、list_authorized_work、run_authorized_work、prepare_operation分别对应当前摘要、闭合查询、精确对象、获准事项、原事项接续和操作卡准备；read_task_operation读取原AI业务操作的闭合历史回执。Go收到 `{conversationId,sessionId,turnId,runId,callId,tool,arguments}`，这些可信坐标不是模型参数。字段/动作随代码维护，不复制固定工具数；通用查询不接受任意SQL/HTTP或整项command。

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

读取覆盖由原工具账本核对，不能用模型的`goalSatisfied`覆盖尚未取得的结果。跨Go的不可用/非法请求，以及Duty本地Pydantic拒绝的读取，都记录在同一任务账本；本地记录只保合法route/scope与歧义状态，不保非法正文或产生业务效果。同callId只能确认同工具、同可证范围的原失败记录，不能吞掉冲突。参数修复提示由既有发布schema生成，完整策略kind及唯一类名别名也从实际SDK schema提取。补续的进展按已取得事实、范围及真实回执去重，重复错误、新callId或新assessment编号不算进展。有界巡检已通过真实读取与自然结束，仍须把读取完成、业务效果与最终解释准确性分别验收。

读取限制的处置沿原`readResolutions`合同进入实际SDK及程序裁决：`superseded`只认同任务、同范围的后续完整成功读取；`not-applicable`须明确引用同任务已核选定对象的精确读取或原领域回执，才能将范围外的附带读取保留为旁读失败，不将它改为成功或全量覆盖。原call编号及有界成功依据随补续事实提供，不要求模型猜编号。显式固定巡检、选定目标自身未取得的结果、未知写入及未决人决仍独立约束结束。23be的选定文件已读取且最后评估有效，但额外全站巡检长期部分拒权及未被同scope后续读取覆盖的jobs失败被当作必需读取，最终为completion_incomplete；这份原失败不回写成功。该修复已通过原账形状和实际SDK的隔离检查。后续唯一受控新attempt确已提交5项not-applicable，但统一引用过早成功读取，仅一项满足后续证据时序；已有更晚成功依据未被选用，又追加巡检使评估失效，未完成自然结束验收。该attempt最终为operations_autonomy_model_failed，最后一次非流式模型请求被Gateway以no-final-answer-or-tool/502拒绝，不能沿用首轮completion_incomplete解释最终退出；原账保留且不再新Run。

空参数`inspect-operations`固定以`current-operations-v1`组合现有获准工作台聚合、维护组件与已接入Galaxy River业务队列、7天搜索与分析、30天推荐、有限分页的当前消息计划、当前在办任务及这些任务的原业务回执、当前委派实际目标的岗位要求。机械参数、目标枚举及必要分页由代码处理，首尾核当前权威；岗位要求只是配置数据。`inspectionChecked/profileComplete`只证明这个明确口径取得，不代表全库或全部历史已穷尽。工作台未授权附带项保null及排除清单；关键来源缺数据、未获准或受控来源扣留保持partial。合法榜单/最近页已取得可作为有界事实，样本及供给快照是否完整另列，不能迫使例行巡检扫描全站。真正全量目标仍需相应完整集合。后续读失败按真实规范化scope、窗口和分页坐标或固定inspect承诺的同范围自动关联；模型不再靠编写callId证明完成，未知writer、精确对象未读及范围歧义仍不能被聚合覆盖。

工作台真实Duty使用原聚合主体及同事务只读身份屏障，避免将`workbench.read`误送入业务写授权；维护保持真实`adopted-galaxy-river-transport`和`includesAllPlatformQueues=false`，按这个范围的可用性、完整计数及组件集合核查，不承诺其它原生队列全集；自治元数据逐条核当前Duty的搜索配置读取权，或反馈/公开内容的真实来源，事件及其它未接来源仍扣留。该机制已上线并通过新任务八段完整读取及自然结束。观察到unhealthy或原操作unknown应如实报告，不要求先把业务修绿才能完成读取；未取得的必需信息仍不能声称已核。历史失败原目标和原记录保留，不回写为成功。

源码允许纯读取计划显式冻结`inspectionProfile=current-operations-v1`，限`ai/ai-human`且actions、grantIds、strategyIds、resourceIds、eventTypes五数组为空。136在原工具账本增加有界`read_outcome`，只保存固定八段的覆盖状态和闭合缺因，不存材料正文；旧记录缺此字段保持未知，不回填历史缺段。补续把实际completion裁决、必需未决范围与附带读取失败分别回给同run，不能只给reasonCode让模型反复宣称全部正常。明确profile之外的可证失败如实保留，但不自动扩大原巡检目标；未知写入和范围歧义仍独立阻止假完成。业务异常是巡检发现，读取其状态不等于要求模型先修复它。此前760842a7原两次inspect均partial且最终未完成，现存账本不足以倒推具体缺段，这些旧任务不回写成功。精确反馈小目标7c1d0b9d已取得完整对象读取和随后有效评估，独立回读一致，无业务写。

后续真实profile任务ca2632d9已取得八段完整结果，最后有效评估后自然完成，四次实际模型调用、无业务写，证明有界读取与结束主链可完成；原模型摘要仍把River范围误称全平台，不能把这一摘要当作准确巡检报告。139源码因此把程序事实与AI分析分别交付：inspect的固定范围、窗口、覆盖、授权内安全计数及闭合异常保存到原call的`read_outcome.inspectionReport`，不存检索词、岗位正文、对象材料或受众；原目标评估摘要保留。

Duty原生存储主动清除最终content，因此native内容为空不证明模型没生成回答。生产者在原persist成功且同run/task/user/session及版本核准后，从本次未过滤COMPLETED纯文本提取最终分析，经原Report送Go；native仍不留正文。139只在原任务表增加有界`result`保存这个独立结果，原summary和assess历史不改。文本超过12000 UTF-8字节或结果包络超16KiB时只记超限事实，不截断冒充完整分析；迟到仅同原run的允许状态可首次补入，相同重报幂等、冲突不覆盖，不把失败/未知任务改绿。没有原文字段的旧记录保持缺失，不自动重跑模型补写历史。程序事实、原目标评估与AI分析由任务详情及工作台绑定任务的同一组件分列显示；当前读取权限和原来源仍复核，无法证明用途来源的AI正文保持不可读。139的真实新任务已验证八段事实、独立最终分析以及两处页面实际交付；来源由原任务绑定、生产代码及隔离检查共同核定，不另存已主动清除的原生正文。AI文字曾误称全平台、误读汇总与日序列或把结果已知数当有结果数，原文保留，交付通过不能替代这些解释质量项。后续只围绕受影响查询核真实行为，不为措辞形式反复扫描全部来源。

API能够连接AgentOS不证明Worker已加载相同运行配置。原health记录Worker实际加载的native配置事实和观察时间，缺观察或观察过期保持未知，不能以ready=true表示已经可以派发；配置就绪、Worker派发资格、原生服务和模型可用分别核对。程序规则也沿Worker的原任务transport回调API执行，免模型不等于免native transport。受保护配置可通过systemd `LoadCredential`提供给Worker自己的运行凭据目录，`GALAXY_AGENTOS_CONFIG_FILE`只指向该只读文件，不需要把Worker加入API账户组或复制原密钥到源码。

仅`operations_agentos_not_configured`这一明确发生于HTTP构建前的本地失败，可在修复配置后通过正式原任务reconcile恢复首次派发：先读原号得到`NOT_RECORDED`，再核原控制命令保存的故障前像、相同任务/配置版本、当前授权、无工具/业务回执/人工决定及并发资格，以CAS进入dispatch-recovering后仍用原taskId和原幂等键提交。保留dispatch_started_at及旧control回执；进入恢复提交后结果未知只核原号，不把网络未知扩大为重新派发资格。

## 持久化、调用与有限恢复

工作台发送先建立同一原操作的本地发送状态并清空编辑框，确认失败才退回文字，不覆盖后续草稿；结果未知只核对原操作。ACK、流式片段与精确原operation结果合并到对应轮次，保留已完成历史；初始进入及真实事件缺口仍可读取当前快照。读取资格使用`/qualification`单独续证，身份/来源真实失效仍执行原边界。 历史`/history`、操作卡`/cards`、沟通条件`/context`和总控管理能力`/management-capabilities`分别读取与呈现，任一慢源不阻塞其他区域。context只用原账本定位最新操作，不冒充模型终态；完成内容由原operation回执合并；同一轮次的并发读取合并，终态后首次取回失败继续核对该原操作，不重发消息。卡片按自身来源期限检查，不缩短整段历史资格。 已完成处理的摘要复用严格匹配的已落账终态回执；旧回执缺字段时按同owner、固定AI精确恢复，最多4路并行。单条不可用标明部分覆盖，不让缺少专项回调阻断整个摘要，也不把原对象引用当作当前读取授权。模型摘要反馈依据systemSupport、permissionAllowed、delegated分别给出功能接通、权限与委派事实，不从未授权推断未开发；后台接口与回执保留原始结构，模型只接收业务能力事实视图，不同时重复提供底层授权标志；时间仅转换本轮checkedAt，不从历史补造。管理能力的query/prepare投影各计算一次，摘要的处理记录、业务概览和管理能力并行读取，最终统一复核当前身份与来源。 固定动作和权限目录启动时解析并建索引，不能在每条权限核验时重复解码整份JSON；该索引只保存代码定义，实际人员、AI角色、委派及来源资格仍实时读取。纯读工具使用独立只读资格投影，保留首尾新鲜复核；角色目录读不持有角色更新锁，准备及修改操作保留原锁。自动运行概览按候选任务批量取来源引用，再执行原逐对象检查，不改变统计范围。定向轮次、工具和卡片事件只更新对应资源；补发缺口才重取历史快照。

`store_tool_messages=False`不清除RunOutput.tools或event body。`conversation_storage.py`对普通save、atomic error与attempt-fenced worker写共同投影，移除工具参数/结果、event body/additional_input，保闭合ID/错误/时间/metrics。用户输入/最终回答是会话历史，Go绑定来源失效时轮换/withhold会话；不宣称物理擦除旧行或新增保留期。Duty存元数据与真实usage，目的材料/卡/命令仍归Go账本。trace不含prompt/completion/tool正文或异常原文。

普通沟通的制卡、确认与结果接续采用本页通用任务循环；操作卡准备完进入等待确认，程序交接通知与本轮持久文本一致。工具后仍可继续修正参数或处理剩余事项，不能用强制 stop_after_tool_call 代替整个任务的完成判断。原卡人工确认和业务回执保持独立；模型native结束不表示业务已经生效。

普通会话的多prepare批次在执行前统一返回对应callId的纠正反馈，避免Agno并发批次在首卡成功停步前继续生成其它卡；同批只读仍可正常运行。原会话角色轮04619614实际provider顺序和当前user均正确，模型仍沿旧搜索目标推进，不能归因Gateway或输入丢失。后续provider副本投影仅将`from_history`记录封装为明确的只读引用数据，保其原文、角色、次序及非文本引用，当前system/user和当前工具配对不动；数据库与用户可见历史不改，也不把历史准备表述判成当前未决队列。当前原生retry的问题仍按原请求续接，只有更晚轮次中的旧请求按历史引用读取，不新增一份用户消息。修后同原会话已成功准备并确认AI专用角色及分配，完整回收及各边界验收按实际回执分别记录，不宣称模型从此不会偏离目标。

操作参数纠正反馈从实际SDK schema生成有界字段约束，包含required、const/enum、format及可表达的嵌套结构；分支冲突、预算不足或未支持的验证条件明确标为不完整，不把省略约束当作完整合同。重复校验失败仍允许按原目标纠参，不通过猜测业务别名、删除未知字段或改换目标绕过。该反馈已上线，真实消息激活的后续行为仍须按实际卡kind及原业务回执验收；准备了其它合法卡不能算原目标完成。精确读取的版本比较用规范化数组承载标量及复合值，缺版本不猜、真实变化仍拒绝，避免字符串或数字版本同值被误报source_changed。完整策略configuration的模型侧结构从现共享Zod合同生成并打包给实际SDK，递归条件按现Go有效深度展开；跨字段、自定义refine、当前权限和CAS仍由Go最终校验，不把模型参数说明当作已验证的策略。

后端请求校验的安全反馈只保真实400/422及源码固定白名单参数code，供模型在同一轮按实际schema纠正；无typed字段路径时不臆造路径，未知错误、矛盾包络和任意错误正文不回模型。原领域权限、版本及发布门槛不改，候选在隔离库可制卡不能反推未保存参数的旧失败。后续bd8478原轮已在首次真实invalid_p13_strategy_request后同run修参并生成strategy-draft卡，证明安全反馈实际可用；该卡后发现候选文字失真而取消，不能把纠参成功当作完整配置准确或已保存。

普通会话的终态落账另由Worker现有Tick内的有界ReconcileWorkbench承担，不依赖网页GET触发。原native metadata读取器在正式Worker装配，按原endpoint、task、turn、run、会话、session、固定AI与人员绑定核验，再沿现UpdateWorkbenchWithin持久化真实完成、失败或等待人工；网络读取在事务外，写前锁原task并重核绑定，不能把旧结果落到新的retry轮。140只向Worker暴露已绑定候选的必要标识元数据并授受限函数EXECUTE，不开放会话命令表或正文。已有卡及原业务回执仍独立判断，未知、失配和读取失败只延期，不重发模型或业务；缺native ACK号的旧记录不靠泛化列表猜测。该正式Worker角色链已通过隔离检查；生产d965轮在ACK后关闭页面，原native自然COMPLETED，原workbench task未经会话GET同步即自动落为completed、revision17，已证明后台终态采用。该轮发布准备仍返回p13_rehearsal_required、无卡且business未开始，不能把沟通终态当作策略发布完成。

手动暂停将请求与实际检查点分开：未派发任务可暂停排队；已派发AI任务先持久化control_state请求，仍显示正在暂停，并从同task事务围住新写。已持原任务共享锁的业务事务先完成，未知结果仅原号核查；只有真实已结算工具与Go原账的交集能成为Agno原生外部执行requirement，持久PAUSED后才记已暂停，不通过Cancel或伪工具制造检查点。原人决优先，已决业务失败仍保持失败。继续沿同task/session/run及原pause、resume操作耐久受理；实际requirement消费确认才解除resuming，丢ACK由原标记及既有对账恢复，不发新run或重执行原工具。重复、迟到或错代标记不覆盖当前控制状态；无后续工具而原native自然结束时，以真实终态收束请求，不造暂停。停用与接管仍保各自原取消语义。这条链已通过真实SDK同run双暂停续接及数据库并发检查，不能替代生产完整结束及自然HumanReview后实际业务效果的验收。

消息计划精确读新增有界生命周期合同，区分仅保存草稿和确认后派发、暂停、停止、撤回。普通会话沿同人及固定AI的既有只读准备资格投影，领域Get继续只读；query自身的读权限集合不冒充准备权限，也不把query proof变成writer。领域能力、卡的原状态门槛与具体配置复核分别表达：领域canSave不代表非draft对象可准备草稿卡，实际共用原卡门槛；缺资格保持unknown，Duty不借人类身份。原草稿正文purpose只说明读取用途，不被解释为全局禁止人工发布审阅。静态SDK说明与动态动作选项都不选择用户意图、不自动确认，原消息激活选成保存卡的失败保留。同一准备只读上下文也用于文件扫描重试、公开案件和具体策略run的资格投影：仍由原领域核来源、重试次数、当事人独立性及真实native暂停/原execution资格，准备资格不等于执行授权，当前写权被query过滤后不能输出为已核否定。文件访问将legacy真人直达、只读准备、实际人工确认和opaque Duty分开：模型使用原领域状态派生的准备资格，query不冒writer；stored proof只读，写确认须当前同人及固定AI的真实portal proof并在原事务首尾复核。Duty仍绑定原task、plan、策略、grant和精确文件版本，按锁住的访问head原operation及审计核同AI、同grant，不能覆盖真人或其它来源决定。恢复仍受原扫描状态、作者与引用来源、撤回、清理和到期条件限制，不续期缓存；永久清理仍逐具体计划人工批准。新formal入口和任务来源只接受可证同endpoint的账户来源，旧非账户设备文件保原元数据读取且准备资格未知。策略预演另复用同一文件来源及真实处理版本，不把当前尚未隔离等同不能配置恢复，也不把来源可用当作恢复或安全扫描已获准。普通每阶段新消息制卡不构成真实PAUSED事项接续。此补丁已完成受影响资格、状态及实际SDK检查，发布后仍须以自然请求、真实激活卡和投递回执分别验收。

独立notice与消息计划在实际SDK说明及精确读、列表中分别给出对象类型与操作机制：notice沿notice-state发布或撤回，计划沿messaging-state激活、暂停、恢复、停止或撤回；计划使用inapp渠道不改变对象类型，合法但选错对象的卡仍不符合当前目标。计划生成的notice读取由原领域在同一事务核同endpoint的原run、冻结计划版本、inapp渠道及完整内容一致性，再投影只读内容与原来源；不扩大独立notice写入解析器，也不把计划受众属性改写成独立通知受众。原始来源失配不猜测或静默过滤。该真实生成到查询消费链及SDK检查已通过隔离验证，独立notice自然制卡与实际送达仍待现场验收。

消息时间优先取原Go命令的created_at，重试沿已核父链复用原问题的发送时间；回复完成时间只取同run的真实RunCompleted事件，缺失保持null。投影复用已读run并批量查原命令，不逐条远程重取历史，也不以updatedAt推造完成时间。聊天和管理记录以Asia/Shanghai完整YYYY/MM/DD HH:mm显示；用户消息时间在正文下方，AI回复完成时间在复制操作旁，原无时间记录保持未知。聊天仅展示最近五个已合并重试的问答轮次，新增未落run的问题占一个展示位置；未发送队列独立，不裁减模型输入、保存历史、业务审计或任务回执。显示源码及定向检查已完成，实际页面采用按对应发行验收。

新增待发队列与已发原操作分开：未发消息按人员、岗位、会话及绑定任务保存于同标签页sessionStorage，在编辑区上方独立展示，支持原位编辑和取消。已尝试发送先保原号，刷新或断线只核原GET；明确未入账的busy响应才可等待指定原阻塞项结束后，以冻结的同号同正文再次提交。已知沟通失败暂停FIFO，原消息显式重试成功或用户选择继续发送后再推进；未知结果不能跳过。业务卡等待人工确认不自动确认，也不阻止已完成沟通后的下一条提问。后端同会话事务围栏以严格绑定的原模型终态判断在途请求，跨标签页同样适用。队列及围栏已完成定向数据库并发和隔离浏览器完整组件、双页面检查，生产同会话双标签页也已验证未入账busy、指定原阻塞项GET至终态、同号同正文再提交、消息各一次、真实完成时间及队列清空。首条模型请求的独立502失败不冒充成功，也不否认已核队列串行事实；它不替代后台任务或其它业务能力验收。

准备读、确认写与Duty写使用不同的可信入口。卡读取保留query-purpose固定AI proof；确认时原回调先复核真实人员、原卡和固定AI，再在实际业务事务内重建同账户的prepare-purpose proof。共同`ExecutePrepared`必须把这个写回调传给各领域`WithAuthorize`，不能用原query回调覆盖首次取得的prepare actor；Duty继续使用原operation绑定授权，管理角色/提示词沿独立消费者。真实完整策略卡曾因该混用确认失败，原操作未落账；共同修复已覆盖真实query回调的定向PG正反例，仍须新卡实际写入验收，不能靠加角色掩盖接线错误。

卡片与任务状态由原记录联动。135仅在现有账本上增加安全状态聚合函数，固定search_path、撤销PUBLIC权限，API/Worker仅获EXECUTE；按endpoint、人员、conversation、固定AI和最新实际turn绑定，只返回状态布尔，不返回卡正文。未知写/处理中及原unknown回执优先，真实外部人决或仍可待确认的卡保留等待；模型沟通已结束且卡确认明确失败则任务failed，保持真实业务状态与旧卡/回执，多卡部分成功不冒充全部完成。明确取消另按原停止语义。Worker可用已持久原run状态重算派生等待，不发业务操作；动态视图失效不能由数据库猜测终态。

错误解释依据同owner/conversation/固定AI的原轮次与当轮工具事实。摘要区分历史读回执、当轮已落账读结果和有精确run绑定的轮次终态；模型请求502只证明该次模型请求失败，不能推断岗位缺权或直接认定供应商故障。认证/授权校验拒绝、来源不可用、对象不可读、参数错误与状态变化分别投影，未知细因保持未知。内部码留原账与安全诊断，模型只接收闭合事实和简短说明，不递归改写业务正文。原生历史没有保存的工具参数或SSE终态不能事后补造；新增诊断只保绑定ID、枚举、计数及布尔。

随机新建业务对象不能以operationId冒充对象ID。137沿原安全回执函数，把已验证卡的标签创建/更新、清理计划创建/取消回执关联到实际tagId/planId；只补当前任务原unknown且目标双空的可证定位，再沿原回执推进，不能改已有非空或终结记录。它不增加事件订阅、Duty授权或自动grant。标签修改与清理计划仍是完整人工卡；创建清理计划仅进入awaiting-approval，取消不恢复已移除文件。该源码批已完成定向检查，实际业务验收另记。

原AI业务操作的人工追查入口为`GET /v1/operations/autonomy/tasks/:taskId/operations/:operationId`，从原任务、工具调用和冻结命令构造描述符，在同事务核当前人员的来源及业务读取权限，再由原领域核AI审计身份、完整selection和回执。仅返回闭合元数据；不要求旧任务仍running，不借人类业务操作GET冒充AI操作，也不改任务终态或重发writer。无原记录、证据不足和有效原回执分别表达，当前对象状态不能代替原操作结果。该精确GET路径在Admin代理按双UUID、只读及无query接线，真实selected任务的隐藏和恢复原操作均已通过当前人正式读取为recorded；原任务已结束、临时配置停用及策略暂停不要求借原writer身份或重新执行。普通会话还已取得原隐藏操作的真实recorded结果，两种消费者按各自实际覆盖记录；不把读取回执冒作恢复旧任务终态或已测生产未知写场景。

普通会话消费者`read_task_operation(task_id,operation_id)`已上线，已用真实selected任务原隐藏操作取得本轮recorded回执，未制卡或写业务；该普通会话现场证据仅覆盖隐藏操作，人类GET另已覆盖隐藏与恢复；138只把该工具名加入原会话工具账本CHECK。它沿当前conversation/session/turn/run/call绑定，在同事务把当前人×固定会话AI转换为query-purpose proof，首尾核`autonomy.read`和原业务对应的读取权限，复用现QueryReader及ScopedPrincipalAuthority进入同领域原回执读取。当前会话AI可读取其它岗位的原任务，但必须通过当前双方权限及原任务全部来源，不能借原执行AI身份或伪造portal人员。owner已接反馈更新、公开post/reply可见性及文件access停止/恢复；账户限制和公开case解决的续批复用同一原任务描述符及人类/query两消费者，已通过真实Duty和生产装配隔离检查，生产采用另验。账户仅apply/release，不开放身份、登录或权限操作；原决定按锁住账户revision定位唯一原审计及实际task/call，核同AI、grant和完整head，不能覆盖人类或其它来源。公开case基础元数据不以仍可处置为前提，resolved后仍可读；它不授权举报叙述或私聊材料，原事件保留期已过仅报unknown。文件续批复用同task、原工具调用、完整冻结request/command与原AI审计绑定，再核精确文件事件及完整selection/result，仅返回原access revision与处理时间。审计和事件双缺为not-recorded、单缺或历史证据不足为unknown、矛盾拒绝；文件当前不可取件或原写授权停用不等于原回执不存在，当前读取权限与同endpoint来源仍须首尾核验。该文件只读链已通过真实Duty工具写入、同号reconcile、人类及固定AI query读取的隔离PG，生产自然消费者仍待受控场景。历史回执版本不冒充当前对象版本，无正文结果不新增version-pinned材料引用；需要正文仍另走当前精确对象读取。工具记录及摘要只保原task/op坐标和闭合回执态，unknown不变成业务成功，GET或该工具都不自动恢复旧任务终态。

provider工具ID/UUID5配对规则见[接口](interfaces.md#管理身份与原操作)。调用计数在实际provider入口、current authority后、attempt fence内记账，包含follow-up；metrics.details分组不是次数，token取SDK累计值，旧无计数行未知。暂停续接duration累计活动时段，排除等待。23be原native已持久29次调用，但任务详情仍为7次，确认终态回调未带计量且failed任务不再被常规Worker刷新。当前修复将同原run的闭合最终快照随原回调同步，Report与Worker在同task/attempt/run锁下共用更新，不让旧快照回退或把不同快照的维度拼成新数值。业务任务重试保留每次原native独立primary快照，再与当前attempt及工作台轮次聚合；不重复累加旧聚合值，缺原快照保持未知。该补丁的隔离检查与实际现场采用分别记录，不以数据库观测意图冒充投影已更新。async admission/history/model授权以threads卸载阻塞IO且保ContextVars，同步模型入口沿原线程；调用前后均查当前session/source。模型版本在provider调用前与attempt/owner/status CAS共同保存，缺版本不以当前配置回填。

会话失败重试由Go核同person/岗位/原失败operation且尚无业务处理，沿固定SDK的原checkpoint先建独立重试run，再走公开continue；后台保存、事件和工具上下文均绑定新ID，原失败记录不变，不追加用户消息或清未发送草稿。已知native runId时精确按主键读取并核owner/session/operation及重试父链；未ACK时先查原ticket；detached无ticket则按同owner/session/agent/operation精确定位唯一ID，再查主键和父链，歧义或不符拒绝，不扫描整段历史。临时授权服务故障只有当前资格恢复且原业务账本明确未执行时，才允许人工显式重试；真实撤权与未知业务结果不适用。工具只修复当前schema支持的表示格式，临时只读失败有限重取；慢读或连接池超时不立即整次重做，写入不自动重发。请求取消仍结束实际业务，另用短期上下文保存已观察工具结果，迟到失败不能覆盖已完成账本。人工配置的备用模型仅在单次模型请求边界使用，保已完成工具结果，流式失败片段不拼接备用回答。Gateway单alias路由本身无fallback/retry；AgentOS只使用明确批准且场景兼容的fallbacks，两层不能混同。

AgentOS在单次provider调用内，对可信provider的408、429或5xx最多追加一次同模型请求，间隔0.25秒；不重跑Agent/tool循环、不改变模型配置或备用列表。每次请求重新核当前权威并按实际provider入口记账，同模型SDK嵌套调用只由最外层决定重试，计数不因包装重复。两次请求各用独立messages快照，重试前仅原地恢复SDK本次assistant消息的局部状态，不回退run、实际usage或首个失败账本；第二次错误保留原错误。流式一旦交付任何chunk便禁止重试，异步取消直接传播。此为第二批源码实现，不能把有限重试解释为上游故障已消失或原失败任务自动重新运行。

真实消息准备轮08ad1f68在两次正常读取后收到第三次模型请求的error对象帧，原run关联已核，无卡无业务写。该call的SDK回调记录503，但provider来源未获证明；固定LiteLLM可用字符串HTTP code构造SSE错误，旧guard只认整数而折为unknown。后续小批源码仅把400–599整数或严格三位ASCII十进制字符串规范化为安全状态元数据，不解析错误正文、不把error放行为成功流。只有明确503、同帧类型/状态及现存回调无矛盾、尚无可用输出且未向SDK发出工具内容，才由Gateway生成独立`model_gateway_transient_failure`封闭错误；AgentOS沿原同模型最多一次重试机制处理，来源记为model-gateway，不伪造providerConfirmed、不触发新增fallback。普通残缺流、未确认503、已交付chunk或工具内容仍拒绝。该机制已上线且通过定向检查；后续真实路径仍可能出现其它类别的模型故障，不能把发布当作原失败恢复，原失败历史不重写。

## Gateway原生准入与模型配置

ASGI wrapper监听loopback（默认127.0.0.1:3351），强制独立至少32字符service key；每路由恰好一个Bearer头，原生custom_auth再次准入。允许GET `/galaxy/status`、`/galaxy/usage?days=7|30`、`/v1/models` 和POST `/v1/chat/completions`、`/v1/responses`，拒绝其他query/路由、provider override、管理端点和调用者logging metadata。请求≤2MiB；已配置调用还须五domain之一 `X-Galaxy-Model-Scenario` 及匹配 `X-Galaxy-Model-Config-Version`，模型仅注册 `galaxy-*` alias。

operator挂载的model_list含model_name、litellm_params(model/api_base/api_key)和闭合model_info；provider前缀/HTTPS或loopback地址显式给定，key只能引用 `os.environ/GALAXY_MODEL_PROVIDER_<NAME>_KEY`。空models/bindings是源码默认，不推断现网。AgentOS scene映射overview/governance/messaging/discovery/maintenance至alias、dataPolicyApproved、runtimeProfile；拒绝非空旧直连provider变量，ambient OPENAI_API_KEY/LITELLM_API_KEY不启用场景。Chat/Anthropic/Gemini走OpenAILike，Responses走OpenAIResponses；调用前后核scene/authority/catalog版本。

人工model-settings应用通过独立读/configure/apply权限及版本/CAS，root控制器编译保护文件、重启固定服务对，回读双方版本；不可变credential refs不覆写旧已采用版本。私有 `/galaxy/model-settings` 返回绑定元数据，gatewayAvailability=not-checked。配置归属的共同说明见[接口](interfaces.md#权威边界)。

galaxy_profiles约束协议、context/output、reasoning、timeout及tools/structured output；LiteLLM做协议转换，本地native counting估计输入并预留output，不可计数/超窗拒绝，不截断。裸root推导OpenAI `/v1`、Gemini `/v1beta`，保自定义prefix，完整inference endpoint归一至协议base，原人工输入与host/credential绑定不改。response guard拒HTML、非法JSON、空completion和不完整SSE，承认真工具调用/refusal；headers后失败发闭合stream error，可修正本次ledger终态但保实际token，不改历史。

明确空终止与残缺流分别处理：Chat SSE只有stop与DONE、实际响应体结束且无残帧、未输出文字或工具/拒绝/error时，新增闭合`model_gateway_empty_completion`失败，仍是502而非成功或已确认的供应商503。AgentOS仅在尚未交付任何chunk时，沿原同模型、同messages及当前权威入口最多追加一次请求，与既有503恢复共用这一次机会；不重跑工具循环、业务writer或整个用户消息。Responses、缺终态、截断及矛盾状态不因此放宽。对响应头阶段实际收到的408、429及5xx，尚无输出且没有已知非瞬时原因冲突时，另按原HTTP状态生成Gateway来源的闭合短时失败；不必先伪造供应商认领，认证、参数和上下文拒绝不因此重试。它与空终止及明确503共用原同请求最多一次恢复，不增加fallback或重跑工具。该补丁已完成受影响定向检查，实际采用与恢复另按发行及真实运行核对。

遥测import前关闭，cost map本地模式，服务entry抑制库stdout/stderr/logging。唯一callback/SQLite ledger保callId、scene、alias、configVersion、outcome、duration、实际token及coverage；重复callback更新原call。无正文/URL/供应商错误/成本预算，不是计费账本或exactly-once保证。

原生模型每次调用按当前run上下文复制request params，注入可选`X-Galaxy-Native-Run-Id`；Gateway完成私有认证后校验并剥离，关联信息只进入本地accepted/completed/rejected诊断，不转发供应商，也不充当授权。guard保留原流终态判定，诊断仅增帧/choice/tool-delta计数、useful/DONE/finish及闭合错误形状。旧策略流缺终态的记录不能凭token或后来的成功重建原因；新增关联须以真实run/call对应证据分析，不能只凭时间窗口当作精确绑定。

## 定向检查与诊断

持久化测试须全部显式设置 `GALAXY_AGENTOS_TEST_DATABASE_URL/NAME/ROLE/SCHEMA`，名称 `galaxy_agentos_test_`、loopback显式端口、专用受限owning role；只读预查实际库/用户、危险权限、成员与所有权后才交Agno，无runtime fallback。SQLite夹具不覆盖durable PG queue。纯拒绝入口：`python -m unittest discover -s services/galaxy-operations-agentos/tests -p test_database_contract.py -v`。

provider reference和analysis语义测试分别用 `test_provider_call_references.py`、`test_analysis_semantics.py`，安装锁定Python/根Node依赖，将service src/tests加PYTHONPATH，Node从PATH发现，默认消费本仓实际源码。Gateway各native test_gateway/test_model_profiles/test_provider_failure_native模块须独立Python进程，LiteLLM的app/config/callback为进程全局。

`deploy/duty_probe.py`默认只读原task；dispatch-once是已授权task的真实模型动作，continue-once消费已解决人决，不用作连接测试。初装空配置检查认证status/catalog、无认证401、completion在读prompt前503；缺service key启动失败、scene未配保agentos_model_not_configured、目录版本不匹配拒绝。具体检查层次见[开发](development.md#故障定位与未验证范围)。

## P13固定Workflow与普通维护

固定 `galaxy-p13-selected-content-v1` version1复用Agno3.1.7 Workflow，注册ComponentType.WORKFLOW并去连接配置；发布定义漂移拒绝，改模板需新ID/version，旧在办版本仍可加载。Go存目标/策略/样本/演练/执行绑定，原生存workflow/ticket/run/steps/pause。只连接已准备的单个公开post/reply content-visibility命令，经execute-prepared-command及原领域回执；数值判定复用P14三值计算，P14引用仅new-writes-only，不能提供可见性授权。

四种主导路由为固定代码、复杂语义adviser、普通人工、显式pause。semantic无模型不入queue，code/human可无模型，adviser无effect工具且只存闭合决定，公开正文瞬时使用、不进workflow input/memory。Agno3.1.7的Condition内Step不执行自身pre-step human review，所以采用顶层dynamic output-review Step，续接读原native requirement。native retry attempts=1、step retries=0。

普通工具read-selected-strategy、save-selected-strategy-draft、publish-selected-strategy只处理P10 grant/P105 attested execution选中的strategy UUID；权限为strategies.read/ordinary.configure/ordinary.publish。ordinaryBounds:null不给范围。允许人给定范围内textLength/linkCount/attachmentCount原rule-index数值、获准mode/日常启停，不改field/operator/结构、目标边界、重要人工策略、待决人工草稿或模型。发布使用人工选择的样本完成当前program qualification，只影响新事项，保同一不可变样本祖先。

Duty另通过`execute-operation`的ordinary草稿/发布typed命令，在原角色、计划、策略与grant交集中维护已存在策略；不能把上述P13选定事项工具限制误称全部Duty入口。日常新增R01补入最小来源合同：只有人类完整配置中显式`ordinaryBounds.canCreate=true`的原策略可作模板，缺失视为不允许；AI只提交精确来源版本、名称和原bounds内的数值、mode或启停，代码复制原目标、结构、触发、动作与授权边界，产生随机新strategyId，新产物不能递归开启canCreate。原来源与新产物身份分别保留，同task/AI/grant核原创建回执及草稿，程序预演后才发布。此新增typed入口仅Duty消费，普通人审新增仍走完整配置卡。创建使用策略head的policyRevision，不使用自治task的configRevision；ordinary发布使用已授权source strategyId及本task原创建回执的draft versionId，由原服务在发布事务内完成当前程序预演，不另调用generic strategy-rehearsal。发布不改在办task冻结计划；已批准的非manual触发方案由现调度器为真实新ID建立新事项并重新核资格，manual不能称自动派发。隔离PG已用真实opaque Duty、API及Worker不同数据库角色验证创建、预演发布、同原号恢复、调度新ID/版本和原content.hide业务回执，不能替代生产模型验收。原task详情另以已验域命令和不可变版本投影`strategyArtifacts`，原授权来源target不冒充新产物；任务详情及绑定工作台复用组件显示原模板、新策略及版本。800首个native原轮真实创建新策略草稿v7而未发布；同轮错误revision及两次generic预演拒绝、旧native ERROR和task unknown均保留，最后只读失败为jobs/list，不能据此断言策略产物不可读。142已补显式同task新执行尝试、当前attempt围栏、原号只读核查及可证未派发拒绝的核定，并通过真实队列双attempt和受影响数据库检查；旧native ERROR及原草稿回执保留。生产首次重试被正式队列的旧payload校验拒绝，原事务全回滚、无新attempt；Task校验和adoption已复用同一闭合attempt/session配对合同，legacy载荷保留，半对、错型及未知字段拒绝。正式Control重试经真实River、受限Worker和NativeClient提交的隔离链已通过，不能以该测试替代生产原任务实际接续；此前模拟Enqueue的检查未覆盖正式队列入口，原失败记录保留。正式修复后800已沿同业务任务的新attempt自然completed，旧native ERROR和原创建记录保留；未来调度已停，不能用任务终态代替30分钟真实派发与业务消费的验收。

部署按完整registry包含对应P13结构/API grants，不给Worker新增P13写或Python业务表权。Go与新native image同批，私有p13/context、p13/step先验service key，native核execution JWT、matter、workflow、session与最新context。health必须回读固定workflow ID/version；启用前由人提供目标、策略、样本与成功分类演练，初始空/停用。它不接消息发送、文件purge、整站恢复、任意参数维护或自动全领域事项发现。

AI查询和准备卡使用持久绑定的人员与AI上下文，由共同主体接口核对当前身份并锁定主体行，不冒充浏览器会话。query只读；stored prepare可读目标并准备卡，不能直接执行业务写入；人工确认、Duty及Execution仍使用各自正式入口。服务未接通、读取失败、对象变化与真实失权分别反馈，内部错误码进入诊断记录；普通对话不因无关状态预读失败而改成重试。

分析时间投影区分带offset的窗口瞬时点与原日桶日期标签：窗口可换算上海时间，日桶不重分成上海自然日。真实68208d85仍把2026-10-25误称周六；核查发现已可见来源的series.date使用ISO时间字符串，旧helper只接受纯日期而跳过，不能据date-only单测断言模型已看到正确星期。后续小批已补严格ISO源标签兼容，保原series字符串与数值，只由其原日期部分计算星期，源时区未报告则保持null；真实Go输出经Agno工具到provider格式化的同形隔离检查通过；上线后的受影响只读轮已正确回答10月25日为周日，并区分UTC窗口、上海换算和来源日桶，不据稍后滑窗回读宣称原轮全部数值精确同窗。搜索另补同窗口结果状态语义：resultKnownSearches包含已知零结果，非零结果只在已知、零结果、实测及scan-limited计数一致时派生，缺失不猜；健康投影明确运行状态与已观察健康分开，未配置原因未报告时不能臆称环境有意如此。上述源字段交给实际查询及inspect消费者，不替换历史AI答复。system-settings配置采用与maintenance真实健康读取另有闭合evidenceMeaning及路由说明：段可读、配置存在或consumer-ack不证明连通、存活或健康，未观察保持not-observed；此投影和定向检查已完成，真实健康解释仍待相应实际查询验收。

## 总控跨模块覆盖与验收边界

岗位名称组织职责，实际能力由当前AI角色、工具接通、委派、计划、策略、自动授权和具体来源共同决定。下面区分当前源码链与本轮真实验收，不能用一个岗位的模型回答或单项通过替代全表；未变范围的既有有效证据可以复用，不为补表恢复压测或批量填充数据。

| 能力 | 当前模型工具与真实业务入口 | 本轮证据及剩余边界 |
|---|---|---|
| 工作台沟通与恢复 | 当前摘要、独立history/cards/context读取、待发队列与原operation恢复 | 原“你好”即agentos_current_authority_denied及普通工具拒权的失败保留；业务源拒权或暂不可用不能被解释为整轮不能沟通。历史与旁卡独立加载、前台内容保留、原号GET及明确未入账busy恢复沿用既有证据；真实双标签串行和时间已核，不为新consumer重复已通过场景。 |
| 其他AI角色与岗位要求 | `read-ai-delegation`、角色/提示词专用工具；人工卡与Duty委派分别办理 | 岗位要求已通过真实卡修改及原文恢复；历史103772e8参数拒绝、223fbcaf/04619614偏旧目标保留，历史引用投影后同会话已真实创建、分配、撤回并停用角色，独立观察治理analytics.read从无到有再恢复无，旧分配及委派不变。独立Duty任务e76fcba3已完成创建/分配/读取/撤回/停用/读取/评估，13次实际调用、四原回执与最终权限恢复已独立核对。治理岗位在人审赋权窗口真实成功读取analytics概况，证明按新权限跨域使用；不以稍后滑窗数字推断原轮同窗准确，原回答星期错误另保留。岗位要求的存储与恢复不能代替下一真实轮采用新提示词版本，该采用证据仍需补齐。不得修改自身上限、共享/人员角色或模型。 |
| 完整策略与普通日常维护 | 精确策略版本读取、完整草稿/预演/发布卡；ordinary专用工具仍按原bounds | 生产完整草稿已保存到v5；预演曾将普通对话turn编号误作execution样本，原卡未执行。SDK明确样本身份及无外部样本的含义，制卡前复用真实owner及当前execution资格检查，确认仍完整复核；新卡完整展示所选样本。enabled的business-action配置从现有选定来源、角色、授权及处理器取得程序预演事实，不能借无样本跳过消费者检查。v5的原c5a预演已真实通过、无副作用；发布轮d965仍返回p13_rehearsal_required且无卡，原入参未持久，不能据已有同版本有效预演断言该轮引用了它。原预演摘要已补原ID、版本及历史valid，并另补精确版本的同owner域预演分页发现，不以最近20张卡限制领域真实依据；历史有效不等于当前发布许可。v5后续正式发布已取得recorded原回执，head rev14解除总暂停，两个原策略仍disabled且配置与已审候选一致。800后续同任务接续已自然completed，真实30分钟原调度及业务消费未验且未来派发已停；原误选卡与未留参数的失败不被事后归因或改写。完整目标、结构和授权变更保持人工确认，不能由ordinary权限扩大。 |
| 自动任务与结束判断 | 原task/Agno durable run、assess、同run补续、原操作reconcile、固定inspect及Worker健康 | 精确反馈小目标7c1d0b9d已通过真实读取、评估及独立回读，无业务写；原失败历史保留。profile ca2632d9已完成八段读取及有效评估，读取/结束主链通过；139上线后d009a700的事实报告、原评估与独立AI分析在详情及工作台真实交付，AI正文仍有范围和日序列错误，质量项未通过。没有机械8次调用上限，不计只读巡检为自动处理业务量。手动pause旧路径会Cancel原native，不能称可恢复暂停；141已补持久请求、真实工具检查点及同原run续接并通过受影响隔离检查；生产首次只读任务自然完成且暂停遇revision冲突，后续23be也曾遇同类冲突，之后已真实进入PAUSED并沿同native续为RUNNING，但最终native ERROR、task failed且无业务写，不能称整体目标完成。142另以独立控制版本和原native/attempt校验控制并发，普通进度不改控制版本；该修复已通过隔离检查，生产采用另验，不以反复刷新抢时机代替修复；原失败码为operations_autonomy_completion_incomplete；同run的Gateway请求均正常完成，必需读取与旁读的程序结束判据正在按原账核修，不能归因为空响应。自然HumanReview的人决暂停与手动按钮是两项独立能力。 |
| 用户账户业务限制 | 当前账户读取、`account-restriction`及原限制/解除回执 | 同AI/grant原决定围栏、原工具调用与审计完整绑定、TaskGet及两种原AI回执读取已通过隔离检查；本轮总控真实限制与恢复未验收，受控附件作者账户须待附件场景完成再处理。账户密码、登录、会话及管理人员权限不因该业务动作获得自动处理权。 |
| 公开治理、举报申诉 | 选定post/reply与公开案件材料、visibility/curation/batch/case-resolve | 受控公开帖子已用原已发布策略、原selected grant和单一对象的冻结Duty计划，真实完成隐藏与原可见性恢复；两个原业务操作及中间隐藏、最终可见状态均已独立核对，临时岗位配置和策略暂停状态已恢复。它不替代反馈、其它治理动作或eligible范围验收；原人类/其他授权处置不能被新AI决定覆盖。 |
| 线索触发的私聊审查 | 精确chat-report引用、用途限定材料及已选消息处理 | 源码有专门用途支路，本轮真实线索/材料/消息回执尚未覆盖；普通目录或workbench.read不能扩大为任意私聊读取。 |
| 使用反馈 | 目录、完整单项正文、CAS更新与原回执 | 本轮已正常创建受控反馈，原state/category/module及note前像已保存，待总控实际处理后恢复；不擅自写备注。 |
| 文件与具体任务 | 文件元数据、scan retry、access stop/restore、清理计划创建/取消与独立批准及受限job操作 | 文件access已按真实人审与原Duty授权分别接到同一领域状态、CAS及原决定来源，实际opaque Duty隔离/原号恢复/解除、真实人工卡、撤权、其它主体决定与过期拒绝的隔离PG通过；任务详情、正式策略预演和原AI业务回执的人类及普通只读消费者均已上线；受控附件已真实上传并扫描可用，最小岗位角色与单文件selected grant已正式设置，匹配文件策略已随人工完整v6正式发布，现场Duty往返仍待完成。清理候选精确处理版本、完整计划人工卡、随机planId原回执与任务来源关联已有定向检查，真实卡链待验收。创建仅等待批准，取消不恢复已移除文件；重排扫描不等于扫描成功，整站恢复仍沿人工方案。 |
| 内容标签维护 | 精确标签读取、人工创建/更名/启停卡及原命令回执 | 已补现有词表业务的typed入口、完整影响审阅和实际随机tagId关联，定向检查通过，真实业务卡链待验收。模型候选须由人确认，不授予自主改变正式词表或分类政策的权限。 |
| 消息与实际投递 | 消息计划草稿、完整发布审阅与原命令恢复；独立notice精确读、草稿及发布/撤回卡 | 消息计划与独立notice是不同对象及账本。受控单账户计划已沿自然激活卡与原作业正式重试卡完成实际送达：原job保持同号，真实run为completed、唯一recipient为delivered，受控账户已实际收到同一notice且标题正文匹配；随后正式stop记录保留run与recipient历史。停止后账户读取取样已近到期，未据空列表断言停止撤回或未过期保留。Worker行锁及重试次数同值误判修复有隔离证据，原generic失败不被事后伪改为已知根因。独立notice仍是另一对象与账本，后续自然卡已完成真实发布并在受控账户看到同一notice；撤回以其原操作及账户回读另核，不把消息计划结果代替它。SMTP既有证据不要求重复外发。 |
| 分析、画像与推荐 | 固定分析视图、真实窗口/覆盖、推荐soft direction，以及已有policy控制与theme精确修改卡 | 只依据实际收集与允许用途，保unknown及分母口径；已有策略启停/防重防集中、现有主题label/enabled/mapping已补人工卡、精确读和原hash恢复，实际跨模块修改与恢复待验收。不开放AI自行建立正式主题分类，不把供给样本口径冒作全站覆盖。 |
| 搜索 | 当前统计与配置、草稿保存及精确版本设置读取、apply/restore完整审阅 | 已真实保存v7、应用并核native采用，再沿原操作恢复原active语义；来源版本与新产物ID误比的回执修复后，原卡同号恢复，未重复业务restore。当前active/native等原v2设置，draft为新ID但内容等原v6，旧v6历史保留，配置闭环通过。没有把草稿指针变化说成原ID还原，也未以配置采用证明召回效果提升。 |
| 运维、告警与来源 | 当前组件信号、任务、获准日志/备份方案等安全投影 | 可用范围以每次返回coverage/basis为准；本轮总控跨模块读取及实际告警路由待覆盖。Worker自检不是独立监测，标签不证明已送达；不自动改变模型、凭据或生产恢复方案。 |

selected只证明明确对象范围。`eligible`必须显式批准，并由当前来源、策略条件、CAS及原人工决定等固定资格检查约束，才包含以后出现的新合格对象；现有scope并不支持任意账户/状态谓词，不能只写在prompt里就声称程序强制。持续全对象能力的验收须保持原授权/策略版本，新增来源后取得新task与真实业务回执，并保不合格来源无写入的对照；本轮尚未取得这组真实证据。
