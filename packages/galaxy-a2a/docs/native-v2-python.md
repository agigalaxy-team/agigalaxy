# M21 A2A v2 事实接续与独立 Python 对端

本切片完成用户宿主可选 A2A 薄桥：选定对端与现有实际 Attempt，发送选定文本，查询、补输入或明确取消，再把选定摘要记录成独立 Result。银河不提供该 Agent 的模型推理。这里的协议互通是本机不同语言进程的合成测试，不是第三方生产参与、八宿主验收或公开 A2A 服务上线。

## 实施依据与当前范围

对应 NEW-M21-FLOW、NEW-M21-ACCEPT、NEW-J20-INTEGRATE、PREP-M21-STEP01/02、IF01、AC01/02；依据 M21 模块阅读包、卷13、C-Q-counterparty 的授权代选、历史 Core §358 与 §372–373，以及 M05/M06 关于精确来源、实际复用、验证强度的要求。CUR-35 恢复开发；本轮没有恢复备份或读取 Hermes 归档。完整来源及变更说明位于项目 `07-logs/development/a2a-python-facts-v2.md`。

旧 `host-flow.mjs`、旧 Case 载荷和旧 journal v1 文件格式保留。新 `host-flow-v2.mjs` 显式调用真实 v2 API；它不会把旧 `case.events` 拼成新 Attempt，也不会为普通聊天制造 Task。无失败史的主动任务仍可通过既有实际工作入口建立 Case/Attempt 后使用本桥。

## 固定版本与独立实现证据

| 对象 | 本次固定值 | 核验含义 |
|---|---|---|
| JavaScript SDK | `@a2a-js/sdk 1.1.0` | 现有锁定依赖，本次未升级 |
| Python SDK | `a2a-sdk 1.1.2` | 本次实际 PyPI wheel 安装与运行版本 |
| 协议 | A2A `1.0`，`JSONRPC`，非流式 | 请求固定 `A2A-Version: 1.0`；0.3 卡片明确拒绝 |
| 原 HelloWorld | commit `1bb0871294af52fdb2c7e5173e43fade0eb008ba` | `agent_executor.py` 原字节保存，Apache-2.0 许可证同存 |
| 原 executor SHA256 | `4ca9015d8a626fb141c619e6dd81027550b2d154eeeb993106c972d627e71ae6` | 测试逐字节复核 |
| SDK wheel SHA256 | `eb9a698f526dc45a9ea967d7804e7aa363ff273d2c44fbed699bc68c9399f9c9` | PyPI 1.1.2 分发包 |

核验时 GitHub 已显示 [Python SDK v1.1.4 release](https://github.com/a2aproject/a2a-python/releases)，但 [PyPI 实际分发](https://pypi.org/pypi/a2a-sdk/1.1.2/json)仍为 1.1.2；没有把未安装版本写成已验证。官方样例原依赖固定 1.1.0，本次保留 executor 原文，明确在 1.1.2 上运行独立 HTTP 包装。原样例定位见[固定提交的 HelloWorld](https://github.com/a2aproject/a2a-samples/tree/1bb0871294af52fdb2c7e5173e43fade0eb008ba/samples/python/agents/helloworld)。

`test/python/provenance.json` 保存来源、提交、摘要和核验时间；`requirements.lock` 为本次 Windows x64 / Python 3.12 的精确 wheel 哈希清单，不冒称其他操作系统已验证。Python 依赖在项目独立 runtime venv，不修改用户默认 Python 或凭据配置。

原 HelloWorld 负责真实 send/get/工件响应。`test/python/lifecycle.py` 是单独标记的银河合成扩展，使用相同官方 Python RequestHandler/TaskUpdater，验证 input-required、auth-required、同 Task/Context 续接、working/cancel、failed/rejected；这些行为不归功于原 HelloWorld 样例。两类均无模型调用、无付费请求、无远程账号。

## 用户流程与事实责任

1. 用户/用户模型通过既有事实工具选中可读的真实 Case 与本人当前 Attempt 精确版本。如果属于协助任务，显式提供 taskId；有真实 Intervention 时也可选择其精确版本。不能任选他人的 Participation 或用名字猜控制方。
2. 宿主使用已选择的对端配置和当前外部授权，展示完整目标、选定文本、事实关联与范围。用户需要新增披露范围时使用原生用户选择面板或本机批准页；普通查询、同操作对账不会重复要求授权。
3. 发送前 journal 原子保留 association 与 requestHash。出站只有选定文本、A2A message/task/context IDs；不自动上传原问题全文、Case ID、GUID、任务成员或本地摘要。
4. input-required/auth-required 明确表示对端所需后续动作；只有新选择的文本被补充，OAuth 或任何 credential discovery 不会自动执行。已知 Task 可查询；未知初次 ACK 保留原关联并禁止重发。
5. 外部完成后，由用户/用户模型明确选择摘要、reportedOutcome 和限制。`completed` 只表示协议对端完成，不自动推断原问题成功。failed/rejected/canceled 不能导入为 succeeded/partial。
6. Result 的 `origin` 指向本人真实 Attempt 或已实际影响该 Attempt 的 Intervention。Case scope 和个人参与约定版本分别检查；Result 不自动结束 Attempt，不自动提交交付、验收、Verification、Resolution 或 Capsule。
7. 导入通过原有精确 `case.teaser.publish` Consent 写入 `POST /v2/cases/events`。界面数据显式返回 `externalSource.verification: peer-reported`、peer endpoint、Task/Context IDs、responseHash，以及 `verification: not-provided`、`acceptance: not-provided`、`resolution: separate`；不会只在附件备注里隐藏状态。

外部工件仅存既有映射允许的摘要/hash，URL 仅记引用 hash 并标 `downloaded: false`。新 Result 的 deliverableRefs 为空，不把外部 URL 冒充银河 Evidence。需要二进制/证据接纳时使用现有独立受控路径；本切片没有自动抓取。

## 兼容、撤回与未知回执

同一个作用域继续使用原 journal：`subjectId + officialEndpoint + endpoint + tenant + peerPrincipal`。新关联追加 `factContext`；新导入追加 `resultImportV2`，保存固定 payloadJson、payloadHash、sourceHash、authorization 和 receipt。旧 `resultImport`、事件字节、签名和哈希不迁移、不改写。

新宿主读取旧关联时可展示本机原记录，但对其操作需旧宿主；没有偷偷转义为新事实。Attempt 更新、撤回、来源权限丢失、参与约定变更、Task 暂停/关闭、外部授权或 Card pin 过期，均阻止继续依据旧范围调用。用户可通过事实工具重新判断实际范围，系统不自行选“最新版本”替换原意图。

Result 丢 ACK 后，先读取当前授权投影，比较精确 event 和 caseVersion。若能找到同一事件则返回已确认回执。参与者看不到其他人的私有事件时，投影不完整只能表示 unavailable，不能表示 absent；显式重试仍只能发送原事件 ID、字节和 Consent 到已有幂等端点，不能制造新事件。业务版本冲突保留原请求供处理，不自动改 expectedVersion。

停止本机等待只显示 `localStopped: true, remoteCanceled: false`；必须收到实际远端取消状态才能说远端已取消。stdio 退出销毁待审页面和内存 preview，持久 journal 中的未知操作仍保留。

## 可选宿主接线

`createNativeA2aHostV2` 导出于 `src/host-flow-v2.mjs`，参数：

```js
const host = createNativeA2aHostV2({
  runtime, directory: config.dataDirectory,
  peers: selectedPeers, readPeerAuthorization,
});
```

runtime 复用原生 `api.call/snapshot/endpoint`、`status()` 和 `authorize(input,{confirmed})`，不新增后台或身份。peers 是严格的公开配置数组：`id, name?, endpoint, tenant?, peerPrincipal, agentCard, cardHash, trustExpiresAt`。Card hash 为 `SHA256(JSON.stringify(card))`；到期毫秒值来自宿主当前选定的信任策略。配置不接受 credential 字段。

`readPeerAuthorization` 接收 `{peerId,subjectId,endpoint,tenant,peerPrincipal,officialEndpoint,cardHash}`，返回 `{subjectId,peerPrincipal,credential?}`。只在已授权资源下解析所选 peer 的凭据；Official session token 从不传给该回调或对端。异常被压缩为不含凭据的授权不可用状态。

公开 Card 获取可用 `discoverA2aCard`。必须先有明确 Card URL、同 origin 的精确 endpoint、已选 cardHash 和尚未过期的信任依据；读取无凭据、限制大小、不跟随重定向和接口替换。匹配 TLS/pin 不等于能力认证。本切片不代替完整 TrustPackage、VC、DID 或公共信任根治理。

主代理可在原生 MCP server 中按条件注册：

```js
const a2a = registerNativeA2aTools(server, {
  host, runtime,
  review: async (name, input, ctx, operation) => {
    currentSubject = (await runtime.status()).identity ?? '';
    return choice.run(server, name, input, ctx, operation);
  },
});
// Add a2a.close() to the existing server shutdown chain.
```

导出文件为 `integrations/native-v2/a2a-tools.mjs`；5 个可选工具是 peers、read、prepare、execute、abort_local。`prepare` 返回 operationId 和精确预览；execute 只收 operationId，不接受模型填入 confirmed。已有 choice 对象负责 MCP 版本与 requestState，避免另一套确认协议。没有显式 peer 配置时不注册。

本次没有编辑 shared native runtime/server/entry、发行构建器或已签名候选；0.2.0 的132工具签名包不会因此自动获得这5个工具。未来新发行必须显式包含 `galaxy-a2a` 及固定 SDK 依赖，重新捕获/测试/签名，不能覆盖旧包。

## 可复现验证与范围

本轮 Node 24.13.0、Python 3.12。在仓根用实际隔离解释器设置：

```powershell
$env:GALAXY_A2A_PYTHON='<project>/05-build/runtime/a2a-python-1.1.2/Scripts/python.exe'
node --test packages/galaxy-a2a/test/facts-python-v2.test.mjs
node --test packages/galaxy-a2a/test/participation-v2.test.mjs packages/galaxy-a2a/test/native-tools-v2.test.mjs
```

结果：Python 原样例＋单列生命周期扩展和作用域拒绝2项通过；实际 Participation/Intervention/Result 及源撤回1项通过；可选 MCP 注册的真实 loopback 用户审阅与同操作不重发1项通过。受影响的旧 bridge 与 host 测试另12项通过，证明旧 Case/journal 路径保持。没有把重复运行次数累加为新增覆盖。

Python 对端与 Official HTTP 均为本机临时监听端口；Official 数据库为真实迁移后的 PGlite 合成服务。第二个参与测试直接调用真实服务，MCP 审阅测试使用业务替身隔离工具层，均未冒称正式 PostgreSQL、实际第三方账号或完整宿主测试。测试结束已关闭临时 Python/HTTP 进程并删除合成 journal；隔离 Python 运行时与可复核来源保留。

首次恢复验证环境可按 requirements.lock 安装到单独 venv；不自动升级依赖或重新抓取样例。`acquire-fixture.mjs` 是显式维护工具，会重新取得固定公开来源并生成 provenance；普通验证不调用它，不覆盖已确认来源资料。
