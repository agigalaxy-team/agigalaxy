# 建设者支持范围、Pack 清单与分项报告 v2

2026-09-13。这是 Schema 64 源码接口说明。本切片已完成本地 HTTP、实际 `galaxy_api` 数据库角色、网页签名与回执恢复验证；服务发布与真实宿主验收以单独发布记录为准。

## 用户获得什么

建设者可以把当前 Worker、Bridge 或 Hub 登记的支持范围写成有版本的对象动作清单。使用者可以分开查看作者声明、配置评估者提交的分项报告、节点批准、有限可达性及旧版兼容报告。Worker 作者还可以发布可导出的 Pack 元数据清单，交由原宿主和用户模型安装、运行及判断。

这次实现保留旧登记 ID、原声明、旧报告、旧签名和维护事件。新增事件不启动 Worker、安装依赖、连接 Hub，也不把登记、下载或报告通过记成真实任务完成。专业能力认证、真实工作事实与兼容检查分别成立。

## 需求依据与当前范围

现行依据是完整产品方案 M20 阅读包和工作包、卷 13，以及 `C-Q-builder_scope`、`C-Q-worker_pack` 的现行采用。历史 Core §221–225、§238、§342–344、§406–407、§555–556、§622、开放架构历史 §6.2 与 §8.1–8.2 保留为需求演变证据；不是新造的用户原话。对应阅读和变更记录见项目 `07-logs/development/builders-v2.md`。

本切片覆盖支持声明、Pack 元数据、分范围报告和网页/MCP操作。Pack 和真正 Configuration、Attempt、Result、Evidence 的精确关联仍是后续独立切片。当前旧 `work-evidence` 继续保留其 v1 Case/CI 范围，不能用新清单反向扩大旧事实能力。M21 的独立实现互通、M22 的自治 Hub 与 Direct Peering 没有因此取消。

## 版本与写入规则

三个新事件都追加到原 `builder_events`。共同字段是 `id`、`builderId`、`expectedRevision`、`declarationId`、`declarationHash`、`kind`。ID 使用真实 UUID；hash 是所引用原事件原始载荷的 SHA-256，不能取展示文本或临时编辑内容。`expectedRevision` 是当前登记流 revision，服务端锁定后检查。扩展必须绑定当前声明的精确 ID/hash。

- `support-profile`：`support.profile = galaxy-builder-support/2`。记录实现版本、Galaxy schema、协议和 SDK 各自版本、对象动作、缺失能力、授权及限制。Bridge 另列映射版本、字段来源含义、来源标识、去重、观察时间、强度上限、撤销和排除数据。声明支持和声明缺失的动作不能重叠。
- `pack-manifest`：`manifest.profile = galaxy-worker-pack/1`，仅 Worker 可用。清单版本、源码/制品 HTTPS 引用及 SHA-256 必须与当前声明的 release 对应。包括许可证、依赖版本、模型/环境要求、所需权限及用途、配置要求、升级和回滚。固定 `runtimeLocation:user-controlled`、`automaticActivation:false`。Pack ID 是当前 Worker 登记下的有类型引用，当前值等于 Builder ID；不是另一个独立市场对象。
- `scope-report`：`profile = galaxy-builder-scope-report/1`。仅配置评估者可提交，登记所有者不能为自己提交。精确绑定支持清单 ID/hash，并记录套件版本/来源/hash、运行 ID、源码/report hash、runner 版本、环境、测试类别、逐动作结果及限制。

扩展沿用 `builder.publish` 的精确载荷 Consent。所有者扩展必须保持原声明可见范围；私有评估报告必须包含登记所有者，且不能扩大声明接收者。表结构、签名授权、API 身份及当前删除/撤销门禁共同生效。自由文本的结构校验不能识别所有私密信息，作者仍需只填写明确选择的元数据。

## 真实接口与返回

下列路径均为 POST，使用现有 `builders` scope。读请求可匿名读取当前公开内容；私有内容必须按当前请求者身份判断。无效凭据不会被当成匿名跳过。

| 路径 | 输入 | 主要返回 |
|---|---|---|
| `/v2/builders/support/read` | `{builderId}` | 当前声明引用、release、support、Pack、分项报告、维护状态及核对时间 |
| `/v2/builders/support/events` | 严格 `{consentId,payloadJson}` | `{builderId,eventId,revision}`；写入前已有精确签名 Consent |
| `/v2/builders/pack/export` | `{builderId,manifestId}` | 当前精确清单引用、作者、声明/清单 hash、元数据、核对时间及声明性质 |

`payloadJson` 必须是签署时的同一个字符串，UTF-8 不超过 28000 字节。写入不是重新序列化后的任意等价对象。原 `id`、Consent、主体和载荷完全相同时返回原回执；同 ID 不同载荷拒绝。版本冲突需要重新读取并让作者确认新事件，不能静默替换授权对象。

服务方法分别为 `builders.v2.get(actor,input)`、`publish(actor,input)`、`exportPack(actor,input)`。已有事务的受管导出使用 `builders.v2.readWithin(db,actor,input)`；禁止为了读取私有登记切换成作者身份。

输入事件的完整严格字段以 `src/shared/builder-support-v2-schema.mjs` 为准。集成调用的最小顺序如下，变量来自实际读回和用户选择，不是示例生产 ID：

```js
const current = await api('/v2/builders/support/read', {builderId});
const event = {
  id: newOperationId,
  builderId,
  expectedRevision: current.revision,
  declarationId: current.declarationId,
  declarationHash: current.declarationHash,
  kind: 'support-profile',
  support: userSelectedSupport
};
// 用原始 payloadJson 准备、展示并签署 builder.publish 授权。
const payloadJson = JSON.stringify(event);
const receipt = await api('/v2/builders/support/events', {consentId, payloadJson});
```

MCP 的七个实际入口是 `galaxy_builder_support_read`、`galaxy_builder_support_publish`、`galaxy_builder_pack_export`、`galaxy_builder_read`、`galaxy_builder_owned`、`galaxy_builder_receipt`、`galaxy_builder_notices`。使用相同服务和原请求者权限，没有描述层的虚假能力。

## 状态的准确含义

支持清单/Pack 状态有 `not-declared`、`current`、`unavailable`、`stale-declaration`。最新扩展不可用时，不回退显示旧公开扩展。声明更新使旧扩展失去当前绑定；旧历史原字节仍保留。

报告保留格式检查、来源流程、独立互通、宿主体验这四类的评估者标注，但服务不会凭类别字段声称独立执行已经验证。返回 `authority:configured-assessor-reported` 和 `independentExecutionVerified:false`。这些报告表示配置评估者提交的有界结果，不能作为任意第三方或专业能力认证。

每个评估者、测试类别的最新报告取代更早报告。评估者移除、授权撤销、声明/支持更新、报告过期或已固定套件失效时，旧通过不恢复。当前可用报告中，同一动作存在失败即显示 `reported-fail`；否则有通过显示 `reported-pass`，没有通过显示 `not-tested`。报告观察时间不能在未来，当前最多追溯 30 天，有效窗口最多 30 天。

相同评估者对同一 Builder 不得用同一个 run ID 重新包装另一事件来增加记录数。该限制不是跨平台运行真实性证明；当前没有据此生成全局独立样本计数。源码 hash、报告 hash 和 peer 元数据仍是评估者提供的引用，服务器没有下载其外部内容核验。

Pack 导出遇到下架或未解决安全状态会拒绝。导出返回的是作者所选元数据及外部引用，没有安装内容或新建 Case/Attempt。`actualUseCount:null` 不代表零次使用，也不代表已有成功。导出 JSON 本身不是新的签名证明；离线核验需原 Consent 或另外的签名 Proof，继续使用前须重新核对当前撤销状态。

## 网页流程与恢复

`BuildersWorkspace` 提供查询、本人管理、当前声明与报告分栏、清单下载、技术作者 JSON 草稿和确认发布。新登记使用原 v1 声明接口，扩展用上述 v2 接口；维护使用原事件。页面不会编造发布版本、来源 hash 或已跑测试的范例。

浏览器在发出签名授权和事件前保存原操作。网络回复丢失后先查询准确事件回执，已记录则恢复原结果；未记录才重试原载荷。取消确认不发送事件，放弃本地重试也先查回执，不能把已记录事件当成撤销。授权过期需处理原待办后准备新操作，不偷偷扩大或延长原签名。

本切片网页使用本地设备身份和绑定；实际组件挂载、网站发布和人工体验验收应在对应交付记录中确认。自动测试不替代用户验收。

## 生命周期、部署与后续

Schema 64 只扩展原表允许的事件 kind，保留 1–63 的迁移和旧合法数据。没有新表、后台队列、角色权限或外部基础设施。M19 的原 `builder-events` 本人原始导出和删除覆盖这三种事件；新增受管 `builder-support` 视图按当前同事务授权读取。私有资料、授权撤销和删除待处理状态不能通过 Pack 导出或支持视图绕过。

AI Agent 部署时先核对当前发布包实际 schema 与源码 revision，追加执行迁移 64，再使用已有最小 `galaxy_api` 角色运行。不得把 suite 配置或 assessor 列表凭空补成真实审核机构，不设置后台安装器，不自动抓取作者外部 URL，也不导入模型密钥。既有评估者/固定套件配置为空时，界面应保持未测；不能为了通过验收改成万能评估者。

本切片验证了真实 HTTP/Consent/数据库链路、版本/撤销反例、旧报告兼容、网页确认与回执恢复。尚未取得第三方实际互通、真实宿主、Worker执行和Pack真实使用证据；这些属于相应后续任务。Configuration v2 可读之后，下一步用精确配置、Attempt、Result、Evidence 和来源撤销规则关联真实工作，不能由 Pack 声明自动造出配置或使用记录。
