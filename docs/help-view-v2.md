# 用户侧帮助视图 v2

实现切片：`NEW-M04-FLOW-HELP-VIEW`。这份说明描述已写代码与待接入口，不将本地测试提升为真实宿主或完整业务上线。

## 用户获得什么

银河返回已授权的实际数据：可参考的方法与其版本、相关项目和参与主体的声明、实际协助 Task、邀请回应及 Participation。用户模型结合当前问题解释能得到什么帮助，用户选择后才进行对应操作。

帮助路径分为继续当前 AI、Capsule／历史方案、开放协助、有偿／专家协助。始终保留四条路径的可达信息，不强制按钮数量、顺序、先读历史或失败次数。主动匹配、发布和参与是同时可用的入口。没有资料时返回 `empty`，未连接返回 `unavailable`，查询失败返回 `failed`；这些状态只描述本次可见查询，不能推出全网无人可帮。

`HelpOffer` 将 path、participants、interventionKinds、basisRefs、environmentDifferences、conditions 分开。模型填写的 `helpDescription` 和 `userFacingReason` 以 `generatedBy:user-agent` 标识；引用和参与者编号必须来自实际查询。引用校验仅证明该编号曾出现在响应中，不能证明解释语义正确、主体有资格或现在愿意参与。所有这些选项的 availability 保持 unknown，真实邀请与回应由 Task 另行表达。没有成功历史的新参与者可以从已同意发现的相关项目出发获得联系机会；有偿资格仍按 M11 检查。

## 当前连接方式

```js
import { createHelpRuntimeV2 } from '../packages/galaxy-official/src/help-runtime-v2.mjs';
import { registerHelpTools } from '../packages/galaxy-edge-mcp/src/help-tools-v2.mjs';
const flow = createHelpRuntimeV2({ dataDirectory, endpoint, subjectId, sessions });
registerHelpTools(server, { flow });
```

宿主传入已经建立的进程内 `session-memory`，不传凭据文本给模型。构造函数不发网络请求；没有 sessions 时本地视图可建立，但来源与远程操作明确不可用。`help-sources-v2` 接通现行 `/v2/search/query` 和 `/v2/discovery/query`，请求种类分别为 `search-v2`、`discovery-v2`；原 `search`、`discovery` 保留旧输入及旧资料兼容，不拿旧索引空结果代表新版没有资料。`task-client-v2` 使用真实 v2 HTTP 路由。端点必须是规范 HTTPS origin，连接的主体必须与本地 HelpSession 的 GUID 相同，每次请求前后均检查既有会话租约。

个人 MCP 在 `definitions` 合并 `taskToolDefinitions(services, actor)` 即接入七个真实 M11 工具：任务查询、读取、创建、任务事件、参与提议、参与事件、操作回执。它们只调用现有持久层服务。OAuth 分类许可不产生 Galaxy 签名；写操作仍需既有精确 payload Consent，公共账号认证、额度、邀请冷却和有偿资格均留在 M11 服务里执行。

`createHelpFlowV2({store,sources,actions,now})` 也可供其他宿主使用。sources 中的 search/discovery/search-v2/discovery-v2 提供 `query(input,{signal})`；actions 提供 `createTask(submission)`、`taskReceipt(query)`、`getTask(taskId)`。这些必须由可信宿主注入真实客户端，不能把模型给出的任意 JSON 伪装成已查证来源。新版选择依据保留来源对象、内容摘要版本及公开的精确事件引用；参与者只取实际获准资料中的作者或介入主体。每条选择依据最多保留16个参与者引用，超过时明确 `participantIdsTruncated:true`，模型须继续查询所需参与者，不能当作该工作只有16人或把其他贡献抹除。分页、未加载经历及当前意愿继续由原响应表达。

## 一次完整的使用过程

1. 模型根据当前工作判断是否提出银河帮助，不依赖固定尝试次数。用户同意查询选定范围后，建立本地 session，保留原对话的稳定 localTaskRef。
2. 调用来源查询，取得原始响应和精确来源编号。原始响应只在当前调用中返回；本地选择档保留对象编号、版本定位、核对时间、性质和未知项。
3. 用户模型说明少量合适选择。例如：继续当前 AI 尝试另一诊断；参考某 Capsule 的确切版本；请相关新参与者分析环境；发布有偿协助并按规则核对资格。可继续展开其他路径。
4. 用户可以多选。`select` 只记录本地选择，不发布、不邀请、不建房间、不写成功履历。若来源在重新查询中消失，原选择记录保留，但必须刷新后才能再次选择。
5. 决定请求外部协助后，形成并审阅实际 Task 内容。默认建议为 Public 的选定摘要，但最终 visibility 以用户实际审核并签名的内容为准；客户端不会改写已经授权的内容，也不会上传整个 HelpSession。
6. 发布与查询分别更新状态。发布成功而候选超时，Task 保持已发布；候选成功而发布未知，先查询原 operationId 和 payloadHash 的回执。未查明前本地流程拒绝重复创建。真实服务也以事件编号去重，不能邀请不存在的 Task。
7. 用户确认选中的联系对象与说明后，通过真实 Task 事件工具分别邀请。每个 Invitation 的回应、到期和撤销独立。联系建议不是申请，更不是实际接受协作；Participation 还需双方确认范围。分别私聊或多人房间属于 M12／M14 的后续房间与授权流程。
8. 原对话调用 `refresh`，取得当前权限下的实际回应与参与记录。`returnToTask` 返回原任务引用、Case／Task 编号、实际操作回执及当前数据，并提示处理已有承诺；它不自动关闭远程任务、不取消参与，也不生成解决或复用成功事实。实际工作和结果由 M03／M11 后续明确记录。

## 本地状态、恢复与删除

本地路径位于配置的数据目录下 `help-v2/<endpoint+GUID摘要>/<session UUID>.json`。文件使用现有私有原子写入和本地写锁；每次读写检查当前公开 Galaxy ID 及初始化／重置状态，不读取私钥。资料按身份和端点隔离。

每个 session 包含 localTaskRef、可空 Case／Task、来源定位、帮助选项、选择编号、查询状态和最少操作回执。原始搜索内容、任务全文、签名 Consent、凭据及模型私密思考不进入这个选择档。`cloudSync:off`；房间摘要的云同步偏好不会自动打开选择记录同步。更改选择使用 revision，防止旧页面覆盖后来选择。暂停只暂停本地视图。

提交前持久记录 operationId、Task ID 与 payloadHash，状态为 submitting。网络失联或进程终止后该操作必须先查询原回执；收到 absent 才可用同一编号和完全相同 payload 明确重试，conflict 需要停止并检查。已确认回执只证明事件当时被接收，不证明当前权限。刷新依旧走完整授权读取；权限撤销后不以旧缓存冒充当前可见事实。

忘记 session 只删除该本地选择档，不删除或撤销远程 Task。用户若要停止已经发出的邀请或协作，必须对相应真实对象采取其取消／退出操作。源服务撤销、服务删除及独立选择云同步的完整保留政策仍由其对应模块承接。

## 实测边界与后续工作

`help-flow-v2.test.mjs` 使用 PGlite、实际 HTTP 服务、现有 SessionMemory、真实签名测试 Consent、Capsule 查询、项目发现和 M11 任务事件。合成参与者和结果明确只用于测试。涵盖四路径、新专家无历史、多选不记复用、成功提交丢回执、候选失败、原编号恢复、真实邀请回应、源撤销后的过期选择、端点／身份隔离、返回与本地删除不取消远程任务。测试中的公共账号额度采用明确合成替身；正式账号／OIDC／共享额度由独立集成测试证明。

尚未以此验证：所有宿主的加载、点击打开与回调；完整聊天室／分组房间及 Context 授权；跨路径实际 Intervention 的完整浏览器体验；选择档的可选独立云同步；后台持续关注；真实付费与真实专家试点。当前没有集中模型服务、自动专家推荐模型或向量推理服务。能力待实测不等于取消原目标。
