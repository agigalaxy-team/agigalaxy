# 后台自动运行：任务、身份与界面合同

本轮依据项目已批准的《银河后台 AI 自动运行与全界面适配计划》增量建设。Agno/AgentOS 负责模型与工具运行；PostgreSQL/pg-boss 负责业务计划、任务领取、版本、回执与恢复。本文描述实现合同，正式发布与实际验收结果以项目当前 runtime-status 和本轮交付记录为准。

## 页面归属

“策略与AI”统一为自动运行、目标与策略、业务规则、任务与运行、模型与用量。工作台提供摘要、处理中事项、AI处理日志及沟通；完整自动运行页查看计划、健康、效果、用量和异常。AI 工作账户保留岗位概览、角色与权限、值守与提示词、变更记录。模型由人工设置。

消息内容、受众、计划和执行账本在消息计划；连接、身份及发信测试在系统设置的邮件页。旧 SMTP 链接兼容跳转，不再维护第二套配置表单。业务审计保持独立。业务对象详情只在确有相关任务时显示关联处理，不增加聊天入口。

## 公开接口

全部沿用当前管理会话、CSRF 与逐动作业务权限检查；路径本身不提供授权。

- GET /v1/operations/autonomy/overview、options、settings：运行汇总、可用选项及工程运行参数。
- GET /v1/operations/autonomy/tasks 和 tasks/:id：分页任务及过程；对象过滤支持真实业务回执关联，并再次核验查看者的来源访问资格。
- POST /v1/operations/autonomy/tasks：从已发布策略创建一项人工工作；不会借用无人值守权限直接写入。
- POST /v1/operations/autonomy/tasks/:id/control：暂停、停止、接管、可用的同任务接续及原结果核对。
- POST /v1/operations/autonomy/tasks/:id/decisions：对原待决调用明确拒绝、取消或不办理，不构造批准。
- GET/POST /v1/operations/autonomy/accounts/:domain/config：持久值守计划及提示词版本。
- POST /v1/operations/autonomy/enable：同页选择岗位并启用。运维必须由人选择每日时刻。
- GET /v1/operations/autonomy/operations/:operationId：只读取原命令结果，结果未知不重新 POST。
- GET/POST /v1/operations/permissions/ai-delegation：人工维护总控可管理的目标 AI、权限上限及动作。

工作台沿用原 conversation/runs 接口，可附 taskId 接续原事项；仍使用当前人和所选 AI 的权限交集，写入由一张具体操作卡确认。任务链接不会自动发送提问。

工作台既有概览工具只有在当前权限交集含 `autonomy.read` 时才附自动运行摘要，数据取自同一任务账本；没有该权限不返回岗位、计划或任务元数据。给权限目录增加这项能力不会给现有角色自动加权。

## 稳定身份与权限

五个岗位使用稳定 AI 工作账户，不借用管理员 cookie、密码或会话。服务端用进程内证明确认 AI 身份；模型生成或从 JSON 复制同名字段均不能取得权限。岗位名称只说明分工，不能构成隐藏的领域 ACL。

动作目录分开表示当前权限、人工条件、处理器接通情况和实际就绪。保存授权不等于执行就绪；无角色的账户没有业务权限。共同任务在每次业务写入时重新检查当前角色、原授权与版本、策略停用状态、对象资格和人工接管。总控只能在人工委派的范围内维护其他 AI 的专用角色，不能修改共享角色或给人员授权。

岗位工作要求、日常策略、授权边界和模型配置分别判断。`ai.prompts.read/update` 加上人工显式委派的 `prompt-read/prompt-update`，只允许维护已列目标 AI 的工作要求字段；不能改模型、固定安全边界、值守启停、计划或目标。旧角色与旧委派不会自动增加新动作。工作台通过 `read-ai-delegation` 读取实际配置，再准备 `ai-work-prompt-save` 具体确认卡；完整前后正文均可审阅，原操作回执绑定目标、配置和版本。角色命令复用 `ai-role-command` 确认卡及同一受限服务。后台任务的写工具仍须原计划、自主范围与当下委派，不以工作台卡代替授权。

每次新的工作台轮次从服务端加载自身已保存的岗位提示词，运行中冻结该轮实际采用的版本；目标 AI 的提示词只作为配置数据读取，不能成为当前 AI 的指令。`managementCapabilities` 分开返回系统接通、当前权限、委派及真实处理入口；未知不能解释成系统不支持。模型配置及授权边界保持人工专有。

消息的延迟执行保存精确的 AI 批准来源，再核验当前权限及原策略；不能把 AI 伪装成人类管理员。普通消息的事实、用途及收件范围需已获准；重要正式说明仍交人工。SMTP 接受、最终送达与未知结果分别记录。

## 计划与运行

新增值守默认停用。预填频率为总控30分钟、治理20分钟、消息30分钟、数据与发现60分钟，运维每天一次且时刻留空。旧角色、账户、策略和授权启停原样保留。

工程默认并发2、健康间隔30秒、启动宽限120秒、单轮600秒、事件合并30秒，由系统设置高级页人工调整。新任务绑定运行参数、岗位提示词和策略版本；在办事项不会因发新版被自动重放。

程序处理明确规则；复杂语义才用模型；重要或异常事项交人工。Agno PAUSED 可按同一原运行与待决调用接续；CANCELLED 与已完成的原运行不能伪称恢复，也不能默默换新运行。未知业务结果只核对原操作。模型完成不代表业务已完成。

业务事件在原业务提交事务内进入持久事件表，领取后合并处理。独立 API 指标与现有监控检查 worker 心跳和过期事项，不能以 worker 自己的存活检查证明 worker 正常。

## 统计口径

网站使用指标沿用分析服务，自动运行指标来自共同任务、真实模型元数据和业务回执。自动完成量排除普通工作台人工卡；批次保留实际应用、拒绝及逐项结果，不把部分应用称为整批成功。

调用次数由真实模型请求计数，token 使用模型 SDK 的累计数据。运行开始但用量未取得时，总量保持未知并给出已观察部分；不按工具数、聊天数或 metrics.details 条数推算调用量。无权限、未知、真零和无样本比例分别显示，不补造历史轮次或成功曲线。

按时完成率只以已持久记账的应完成巡检为分母，完成时限取该任务冻结的计划与宽限参数。离线期间只合并补查，不用当前日历反推并虚构历史巡检；页面同时说明这一覆盖范围。

业务审计单列发起人、判断主体、执行账户及相关任务。Schema 130 的封闭 `actor_context` 由服务端原任务、原工具调用和稳定 AI 身份证明产生，不接受模型或 HTTP 自报；程序与 AI 的来源须有实际调用证据，历史缺项继续未知。该上下文与原操作输入、结果分开保存，不改变旧回执的精确对账合同。

## 调度与独立健康监测

Schema 129 建立持久计划、任务、原操作回执、提交后事件与工作台关联；后续迁移继续沿本页部署说明，不把 129 当作当前全部结构。升级只创建结构和停用默认配置，不启用岗位、旧授权或策略，也不改变人工模型配置。

现有 PostgreSQL/pg-boss Worker 负责 `autonomy-tick` 心跳、到期事件合并、当期或一轮恢复任务，以及 `autonomy-task` 领取、全局并发限制和同岗位不重叠。受保护的 Native 原任务接口处理运行，结果未知只读取同 taskId/operationId。Native 程序分支回调 API 固定程序，不创建模型运行；业务完成数只取实际业务回执。

`/v1/operations/autonomy/settings` 保存版本化工程参数，新任务冻结当时的 roundSeconds 等版本；当前停止、撤权和人工接管仍每次重核。总并发支持 1 或 2，与 Native 上限一致；每日岗位没有人工选定时刻时只能保存停用草稿。API/Worker 使用同一 endpoint、完整当前 schema 和各自最小角色 SQL；Worker 沿已有受保护 `GALAXY_AGENTOS_CONFIG_FILE` 只请求 Native 固定路径，私有桥继续核验服务身份和配额。

Worker 的 `autonomy-tick` 与自身恢复循环不能发现自身死亡。独立消费者是 API loopback metrics exporter，从数据库读取心跳和真实持久任务，不依赖总控模型。既有 Prometheus `galaxy-api` scrape 示例为 `127.0.0.1:9464/metrics`、30 秒；实际加载 `docs/alerts/galaxy.rules.json` 后，`GalaxyAutonomyCollectionFailed`、`GalaxyAutonomyWorkerStale`、`GalaxyAutonomyTasksOverdue` 由既有 Alertmanager 路由接收，保留 `owner_role=operations`。标签不代表新接收器已配置；原运行说明记录当时沿 management 路由，实际端口与接收器从部署环境确认，不从源码示例推定已投递。无需另建值守 timer。

Exporter 提供 `galaxy_autonomy_collection_success`、`galaxy_autonomy_enabled_accounts`、`galaxy_autonomy_worker_health_available`、`galaxy_autonomy_worker_tick_age_seconds`、`galaxy_autonomy_worker_tick_limit_seconds`、`galaxy_autonomy_overdue_start_tasks`、`galaxy_autonomy_overdue_round_tasks`。无心跳时不补零 age，用 health_available=0 表示；所有岗位停用时不报值守心跳过期。API/Worker 自身掉线由原 TargetDown/TargetMissing 发现。

必要检查采用既有 promtool fixture 核对触发和恢复；真实接收器投递按实际部署另证。程序模式已有 P14 条件读取、固定规则未命中的 no-action 回执，以及已接参数的文件扫描重试/内容恢复路径；其他动作缺明确参数或当前资格时进入人工处理，不据此宣称全部业务写已程序化。AI 动作仍取当前角色、计划、grant、策略、处理器和原对象资格的交集。

## AI agent 部署与排查

1. 先读取实际生效的 API、Admin、Native 版本与数据库迁移；从已发布冻结源码增量构建，保留其他未发布改动。迁移129追加运行结构，130追加审计来源，131追加受限岗位提示词管理及审计关联，继续排除原暂缓迁移120。
2. 后台 AgentOS 继续使用已有受保护服务连接与人工模型配置；模型凭据不得进入任务、提示词、源码、构建日志或报告。
3. 发布 API/worker 的对应迁移与代码、原生运行模块和 Admin；现有独立监控加载同批规则。不得用启用值守代替部署验证。
4. 验证会话、任务分页、权限投影、原操作恢复、接管、配置版本以及独立监测。界面用独立无头浏览器检查，禁止复用用户浏览器。
5. 页面显示权限有效而执行未就绪时，先查处理器、模型绑定、源资格和计划条件；不要扩大角色或借用管理员会话。若调用已发出而回执未知，按同 owner、同 operationId 查询，不换 UUID 重发。
6. 生产整站恢复仍由人工批准具体方案，程序统一执行和校验；AI 仅准备诊断和建议。文件清理的具体计划批准及原人工决定的改变同样保留人工要求。
