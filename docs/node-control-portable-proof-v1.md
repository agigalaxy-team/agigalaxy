<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/e6/e66cf89c6e2ab3edf79b1ea68569f026eb5ce7796433bd81ad2b1d878b5e2fd7.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 节点授权可携带证明 v1

2026-09-10，C15-02。本地开发实现，动态服务未部署。复用已有 Node Genesis、Ed25519/JOSE、精确声明授权、撤销链与便携客户端，不创建另一套身份或任务执行权限。

## 两种证据

| 证据 | 谁签名 | 能核验的内容 |
|---|---|---|
| Registry snapshot | 当前配置的服务签名键 | 服务在 checkedAt 读取到 Node 对准确 Owner、登记和声明的有效授权 |
| Direct Node proof | 上述服务键，加 Node 自己的 Ed25519 密钥 | Node 主动重新签署了该准确快照；Genesis 把签名公钥关联到 Node Galaxy ID |

旧 Consent 数据库只保存签名摘要，不能重建历史签名。第二种证明是 Node 在原生入口查看内容、准确确认后新签署的证明，不冒充原始 Consent。证明用途为 node-control-portable-proof，签名类型 galaxy-node-control-proof+jws；Consent、登录和执行接口均不接受这种签名作为授权凭证。

两者均不证明端点控制权、端点可达、模型质量或任务能力，也不授权持有证明的人执行任务。capabilityVerified 和 endpointControlVerified 保持 false。控制事件与声明继续保留原始版本；生成证明不修改它们。

## 服务快照

POST /v1/builders/node-control/export，输入 {builderId,controlId}。复用 builders 会话，要求调用者能读取当前声明与当前 Node 授权。仅对应准确的当前 controlId 可导出；旧声明替换、Node/Owner 撤销事件、Consent/绑定撤销、过期及未知签名 pin 都不能生成当前有效证明。私有材料仍按原授权读取，匿名导出拒绝。

返回 {signed}，使用现有服务签名封装 galaxy-node-control+jwt。schema 1 包含准确 Node/Owner/登记/声明 ID、声明 SHA-256、Node 控制事件、其原始 controlPayloadJson 字节和 sourceEventHash、检查/失效时间、维护状态及刷新路径。原始事件字节用于摘要核验，接收方不用复制服务端 JSON 字段排序。受众及发行者固定为实际配置的 HTTPS origin。

有效期最长 300 秒，受 Node 授权、两份 Consent 及其原绑定的最短有效期约束；服务签名键有效性另由既有 signer 检查。下架或安全状态随快照保留，不因此隐去维护信息。每次导出用 builder.node-control.export 审计，分别记录调用者与来源 Node 的绑定，不记录签名正文或私钥。

## Node 主动签署与本机文件

建设者详情中的“节点授权证明”提供“读取服务签名授权快照”；只有当前 Node 身份看到“用Node密钥签署并保存证明”。后者先读取已验证快照、显示准确 Owner/Node/声明/快照摘要与时限，再要求准确确认。

执行前重新读取 Node 授权，声明、控制事件或维护状态变化即停止。可信宿主仅对这份已确认的 payload 开放签名，使用现有本机密钥；不导出密钥或保存会话凭证。取消、身份变化、旧页面回调及过期预览不会继续正常导出。

成功后在当前本机 Galaxy 数据目录创建新的 galaxy-node-control-proof-UUID.json，包含 version、registrySigned、nodeSigned 和公开 genesisProof。文件是私有本机导出，不自动上传。新建文件不覆盖旧证明；旧文件之后仍可能过期或已被撤销，不应按文件存在判断当前有效。

## 独立客户端核验

@galaxy/client/builders 导出 verifyNodeControlSnapshot 和 verifyNodeControlProof；构建保持 19 个公开入口，新增两个共享/验证源码文件。验证器不发网络请求、不读取本机身份，不把包内或证明自带的服务公钥当作可信 pin。

```js
import { verifyNodeControlProof } from '@galaxy/client/builders';
const result = await verifyNodeControlProof(proof, {
  endpoint, trustedKeys, now,
  builderId: expectedBuilderId,
  controlId: expectedControlId,
});
// 核对 result.data.ownerId/nodeId/declarationId/declarationHash
// 是否等于自己的预期目标；签名不是陌生所有者的信任推荐。
```

验证检查服务签名/pin/时间/目的、准确对象关联、原事件字节摘要、Node Genesis、公钥签名和快照摘要；篡改字段、替换节点、端点、控制事件或过期均失败。返回 nodeSignatureVerified:true 表示两份签名和关联通过；currentRevocationChecked:false 表示离线无法知道快照签出后的撤销。要获得较新的状态，显式调用 builders.exportNodeControl，仍须核对同一控制事件和声明。

## AI Agent 部署与验证

本次无数据库迁移，仍为 Schema33/41 表；现有 API 角色足以读取两份授权及记录审计。使用现有运行配置的 endpoint、builders Scope 和可信 pin，Caddy 路由模板新增唯一 POST 路径；没有自动端点探测。升级客户端时使用新构建的源码摘要，旧客户端不应把未知类型当作通过。

回退可关闭该原生入口和新代理路径，保留登记、撤销事件、审计及本机证明文件；旧声明不会因此恢复。相关检查覆盖 HTTP/签名/撤销、独立 Node crypto 核验、真实本机签署保存、原生确认、受限 PostgreSQL、实际 Caddy 转发以及独立离线安装消费者的直接证明验证。测试数据为合成；真实建设者、目标宿主人工体验、运营容量和异地恢复等原验收要求保留。
