# 原生 v2 CI 观测与 Proof

本切片打通本人新版 Result、精确 M06 Evidence 版本、真实公共 GitHub CI 观测和单独授权的 Proof。旧 v1 Evidence/Proof 仍保留原载荷和含义，不要求新用户伪造旧 Case 或失败 Attempt。迁移为追加 60，未修改历史迁移 SQL。

## 依据与位置

- [M06 工作包](../../../../../../02-architecture/redesign-v1/predevelopment/work-packages/M06.md)：Evidence 是可追踪来源，Verification 明确目标和范围；CI 标签、交付接受、独立验证分别记录。
- [M08 工作包](../../../../../../02-architecture/redesign-v1/predevelopment/work-packages/M08.md)：同一案例不能因多次重复导入变成多个贡献；诊断、失败和复核保留其实际价值，不统一改成成功。
- [原始架构](../../../../../../01-intake/source-documents/GALAXY_CORE_ARCHITECTURE_v3.1_COMPLETE_CORRECTED.md) §17—22、27—28、171—181：来源、验证与权限边界。详细历史索引继续通过完整模块阅读包读取。
- [产品基线](../../../../../../02-architecture/redesign-v1/PRODUCT_BASELINE.md)：模型工作由用户端承担；公开贡献与原始私有内容不是同一授权。

以下格式和队列细节是本轮技术细化，不伪称用户曾逐字段决定。

## 来源绑定与职责

`ci.observe` 签署请求包含 `schemaVersion:2`、`kind:observe`、`purpose:observe-selected-ci-source-and-prepare-bounded-proof`、唯一 `id`、`caseId`、`evidenceRef:{id,version}`、`resultRef:{id,version}` 和 `source`。Evidence 的报告者及 Result 作者都必须是请求本人；多方协作者分别为自己的真实结果生成请求，不能据此占用其他人的贡献。

GitHub source 复用现有严格结构：`provider:github-actions`、`owner`、`repository`、整数 `runId`、整数 `attempt`、40位小写十六进制 `commit`。M06 记录 `evidenceType:ci-result`，元信息用 `ciSourceMetadata(source)` 生成：

```json
{
  "originSystem": "github-actions",
  "externalStableId": "github-actions:owner/repository:run:123:attempt:1",
  "contentVersion": "0123456789abcdef0123456789abcdef01234567"
}
```

其他历史合法 Evidence 不被重写。如果它们尚未提供可核对的运行标识，先追加来源纠正；不能凭摘要猜测运行或静默改为最新版。

提交只排队。后台使用原有 GitHub 固定 API 检查器，限制 5 秒、128 KiB，只读公开 run-attempt 元数据，不访问任意提交 URL，不启动 CI、不执行用户代码、不调用用户模型。实际仓库数字 ID、run、attempt、commit、公开性和运行状态逐项匹配；仓库控制方仍可能是提交者。来源授权在外部读取前和提交观测前各重新检查。恢复租约、撤权、删除及至多五次有界尝试沿当前队列处理；尚在运行的 CI 可在该范围内再次观测，之后用户可提交新的明确请求。

请求授权表达后台观测的有限委托。Worker 不持用户登录凭据，不签 Proof；读取器只在该已签请求所关联的 Case 范围取得锁，原资料的每份当前授权仍有效。普通 API 继续经过当前身份、绑定和权限检查。

## Proof 与失效

Proof 先预览，再单独以 `proof.publish` 签署精确字节。预览最长五分钟，观测按现有 GitHub profile 一小时新鲜度。数据是 `version:2`、`sourceProfile:facts-v2`、`type:ci-execution-observation`。公开载荷包含 CI 来源、结果、采集和到期时间、限制、提交主体和独立生成的绑定标识；不包含私有 Case/Task/Evidence/Result ID 或原文。私有为网页默认值，公开是独立选择。

每次读取重查原始源版本、Result及其起源、Case状态、来源与发布授权、绑定、删除请求、Proof撤销和新鲜度。签名有效不等于当前可用。M06 Evidence纠正、Result或起源改版、撤权、停止请求、来源正文删除、到期，均可使旧证明不可继续使用。历史已签字符串的存在不恢复当前权限。外部记录在两次采集之间是否发生新变化仍受采集时点限制。

Result接受、CI结论、Case解决和能力认证分开。Proof始终明确 `repository-controlled`、`submitter-asserted`、`capabilityVerified:false` 和 `independentExecutionVerified:false`。演示资料沿来源传播，不能授予真实 Honor。

## 当前接口与客户端

| 入口 | 作用 |
|---|---|
| POST `/v2/ci/requests` | `{consentId,payloadJson}` 排队精确请求，evidence scope |
| POST `/v2/ci/requests/read` | `{id}` 本人请求和当前观测 |
| POST `/v2/ci/requests/revoke` | `{id}` 本人停止请求，依赖证明失效 |
| POST `/v2/ci/proofs/preview` | `{id,requestId}` 本人精确预览，proof scope |
| POST `/v2/ci/proofs/publish` | `{consentId,payloadJson}` 签署独立披露 |
| POST `/v2/ci/proofs/read` | `{id}` 当前允许读取的证明，允许公开匿名读取 |
| POST `/v2/ci/proofs/revoke` | `{id}` 本人撤销 |
| POST `/v2/ci/receipts` | `{type:request或proof,id}` 本人操作哈希回执；recorded不等于当前有效 |
| GET `/v2/ci/proofs/{id}/status` | 当前公开状态/允许读取的证明 |

无效凭据不会退化成匿名成功。M06 status 另加显式 `type:ci-proof-v2`；旧 `proof` 继续表示 v1，避免 UUID 命名空间混淆。个人 MCP 的八个 `galaxy_ci_v2_*` 工具复用上述实际服务；回执按类型额外要求 evidence/proof scope。

`CiWorkspace` 嵌入事实页面，使用同一 Case 的本人 Result 和已读 M06 Evidence。`ci-client.mjs` 在签名和发送前保存原操作，重开连接后可通过精确 Consent/业务回执恢复；丢失响应不创建另一个随机操作。来源选择、排队、刷新、预览、私有/公开、取消和撤销分别表现。未完成观测不能预览成成功证明。真实浏览器自动测试不代替用户体验验收。

## Honor、删除和资源

新版 Honor 通过 accepted Delivery 的精确 Evidence/Result引用找当前许可的原生 Proof。公开的有限 CI Proof 可提供该来源的有界结论，不能打开私有 Evidence报告；Case/Task等其他必要作者的贡献投影仍分别需要当前授权。来源按数字仓库/run/attempt分组，同源不同commit或结论传入冲突判定；不能先扔掉失败观测再把剩下的成功计数。默认榜单关闭，无全球能力评分。

三表 `ci_requests_v2`、`ci_observations_v2`、`ci_proofs_v2` 和对应队列项按请求/签署主体纳入 M19。本人导出保留提交、来源关联、观测和独立Proof；删除沿叶到父处理，不用CASCADE删除其他作者。其他作者保留的关联遇到原 Case源删除时失效，不恢复原正文。每请求预留五次有界观测空间，API只写请求/Proof，Worker只写观测及状态；跨旧CI、Builder和新CI同时遵循总体和本人任务限额。

## 验证范围

- 原生CI、旧CI、Builder及资源预算针对性回归：4/4通过。
- 实际 PostgreSQL `galaxy_api` 和 `galaxy_evidence_worker`、签名HTTP：1/1通过；包含精确版本失效、工作途中撤权、停止、私有正文不公开、公开最小贡献组合、同源成功/失败冲突、M19四项队列归属。隔离实例已清理。
- 真实浏览器运行时身份/签名及丢失回执恢复：1/1通过，无重复请求或Proof。

GitHub响应为明确合成的测试数据，证明适配器和授权流程，不作为真实项目CI成功或生产贡献。真实部署状态由主代理的对应发布记录说明，本文件不凭代码存在宣称整个银河业务上线。
