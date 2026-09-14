<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/9d/9d86f9ee93b740659049c653935fda1dea5fc03698f86b3124c5d0c3b126d669.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Hub Manifest profile v1

2026-09-10。C15-05 本地实现：Hub 签名发现、目录声明核对、显式宿主连接及运行配置记录。动态服务未部署。这里的 Hub 是独立配置的自治服务端点；不涉及首次 `/galaxy` 的 Hub 形态初始化，也不提供跨 Hub Federation。

## 复用的实现

使用已有 `jose` / Ed25519 JWS、根密钥分发、短期 Manifest、Connection Profile、binding/session 握手和本机 Galaxy ID。JSON 摘要使用固定依赖 `canonicalize@4.0.0`，实现 [RFC 8785](https://www.rfc-editor.org/info/rfc8785/)；参考 [canonicalize 源码](https://github.com/erdtman/canonicalize)。没有新增数据库表、身份格式、认证算法或自动发现的可信端点。

原 `verifyManifest` 和 `discoverOfficial` 始终要求 `networkType: official`。新 `verifyHubManifest` / `discoverHub` 始终要求 `hub`；调用者不能通过覆盖 options 把一种类型当作另一种。

## 服务端配置

现有 API 运行入口增加可选 `GALAXY_NETWORK_PROFILE_FILE`，指向以下公开 JSON 文件。未配置时继续使用 Official。文件内容只选择服务类型和公开描述，不能覆盖实际 endpoint、密钥、operator、region 或运行能力。

```json
{
  "networkType": "hub",
  "displayName": "Example community Hub",
  "serviceVersion": "0.2.0",
  "hub": {
    "profile": "galaxy-hub/1",
    "charter": "https://hub.example.org/charter",
    "scope": "Community coding assistance",
    "exit": "Revoke this endpoint binding and remove its local configuration.",
    "export": "Export your selected records before leaving."
  }
}
```

`hub.example.org` 仅为示例，未内置于运行配置。实际 endpoint 沿用 `GALAXY_ENDPOINT`；operator / region 沿用 `GALAXY_OPERATOR` / `GALAXY_REGION`。配置错误使启动失败，不回退成 Official。启动配置账本记录实际服务的 `network.type` 和 `network.manifestSha256`；旧账本没有该字段时仍可核验。

Manifest 路径保持 `GET /.well-known/galaxy-network.json`，正文为 `{signed}`。签名 envelope、issuer/audience、key status 路径及最长 300 秒有效期与原服务相同。ETag 对应完整签名响应，签名缓存每 60 秒刷新。

Hub 数据字段包括原 Manifest 的 schemaVersion=1、networkType、displayName、operator、endpoint、capabilities、policy、region、serviceVersion、signingKeyId、revocationPath，并新增上面的 `hub` 对象。目前支持的能力名称仍是 binding / sessions / docs-mcp，不能把未知能力放进该 profile。policy 保持 `automaticUpload: false`、`privateKeyCustody: client` 和同 origin 的政策 URL。Hub charter 是公开 HTTPS 引用，读取 Manifest 不会自动访问它。

## 目录摘要与声明核对

对已经验证的 **Manifest data 对象** 计算：

```text
manifest.sha256 = SHA-256(UTF-8(RFC8785-canonicalize(data)))
manifest.specVersion = galaxy-hub/1
manifest.url = endpoint + /.well-known/galaxy-network.json
```

摘要不包含 JWT 时间戳、JTI 或签名，因此重新签署同一份 data 不需要更新目录。data 内的 `signingKeyId`、版本或政策等发生变化时，摘要会改变，需要更新声明。HTTP ETag 不可填入 `manifest.sha256`。

核对的声明字段：name、operator、region、scope、charter、policy、exit、export、release.version、manifest.sha256。返回 `directoryState: matched | mismatch` 和不匹配字段名；未知 profile、无效签名、过期或未配置可信 pin 直接失败。发行 artifact、sourceCommit、buildHash 和 dependencies 仍属于登记者声明，不能从 Manifest 匹配推导为已验证的软件发行。

目录服务 pin 与目标 Hub pin 分开配置。目录不能给自己声明的 Hub 授予信任；Manifest 内的信息也不能成为新的可信 pin。

独立客户端可使用：

```js
import { discoverHub } from '@galaxy/client/discovery';
import { verifyHubDirectoryManifest } from '@galaxy/client/builders';

// hubPins 来自运营者选定后，通过独立渠道核对的公开签名键。
const discovered = await discoverHub(endpoint, hubPins);
// 仅当 discovered.state === 'verified' 时使用其 manifestSha256。
const checked = await verifyHubDirectoryManifest(document, {
  declaration, trustedKeys: hubPins, now: Math.floor(Date.now() / 1000)
});
```

有根信任配置时使用 `discoverHubWithRoot(endpoint, rootPins, {trustDirectory})`。复用现有根签名 keyring 和防回退持久状态；根 pin 仍需独立配置。

## 宿主与原生菜单

`createConfiguredRuntime` / `createConfiguredGalaxyAdapter` 的现有配置增加 `networkType: 'hub'`。其 endpoint、trustedKeys 或 rootPins、已有本机身份目录和绑定 Scope 都须属于该 Hub。实际本地 Connection Profile 的目标必须是 `kind: hub`；同 URL 的 Official 目标不能自动转用。

服务信息页仍由用户选择后才读取，显示 Hub 类型、运营者和签名状态；确认连接后复用四步握手。本机已有 Galaxy ID 和密钥保持原值；Manifest 读取不生成身份、不绑定、不恢复旧会话。返回/取消会丢弃迟到页面。

若要从建设者目录主动核对 Hub，可在**目录客户端的可信宿主配置**中加入：

```js
hubTrustedKeys: new Map([[selectedHubEndpoint, independentlyCheckedHubPins]])
```

`createBuilderClient`、本机 runtime 和配置 adapter 传递该设置。Hub 详情出现“核对Hub签名与目录声明”，调用 `verifyHubDirectory({builderId, declarationId, manifestSha256})`。未提供此配置时无核对入口；空 Map 允许显示入口，但必须补齐准确端点的 pin 才能读取。

该操作向 Hub 发出一次主动匿名 Manifest GET，不转发目录会话凭据或本机身份。访问前后重读当前目录项，声明/版本/维护状态、授权或 pin 变化都会使本次结果失效；不保存全局“可信 Hub”状态、不更新配置、不自动连接。连接其他 Hub 需通过宿主单独选择其配置并确认。

读取仅使用现有有界公共 HTTPS reader，禁止私网、凭据 URL、重定向和超限正文。`readHubManifest` 注入参数只供可信宿主传输适配或测试，不能接受来自目录的实现代码。

## 自动验证和操作边界

- 真实本机 HTTP：签名缓存刷新、稳定摘要、Hub binding/session、独立目录与 Hub 签名键、目录下架和信任改变。
- 原生 Adapter：Official/Hub 分别读取、精确确认、取消迟到回调、断开和本机回执；首次初始化未改。
- 独立离线安装客户端：内置 crypto 单独生成 Hub JWT，打乱字段顺序后使用已安装包验证；不依赖项目 Manifest producer。
- 旧 Official 发现、根密钥恢复、本机 runtime 和运行配置账本按本轮影响范围回归。
- 实际 `server.mjs` 使用受限 PostgreSQL API 角色启动为 Hub，返回独立核验的 Manifest 并保存同一 data 摘要；错误 profile 启动失败且不新增配置记录。本轮 35 项不同相关用例及 1 项独立 PostgreSQL 进程用例通过，临时数据库已清理。

独立服务入口用例可通过 `GALAXY_TEST_PG_BIN=<PostgreSQL bin>`、`GALAXY_TEST_PG_CASE=hub` 运行 `node packages/galaxy-official/scripts/test-postgres.mjs`。该入口创建新的合成集群，不接受现有业务数据库 URL。检查输出及两次测试脚本失败的修复说明保存在本轮 [进度证据](../../../GALAXY_HUB_MANIFEST_PROGRESS_2026-09-10.json)。

这些是受控 fixture 的互操作证据。真实第三方 Hub / 公网 endpoint、实际宿主人工交互、正式发行、额度/告警和异地运营恢复仍按原验收条件执行。`matched` 只表明当前签名和列出的元数据一致，不认证自然人运营者、目录所有权、任务能力或整套 Hub 软件。

## AI-agent 部署说明

先读取目标环境的现有启动、根信任和回滚配置；本节不提供任何凭据。将公开 profile JSON 纳入该环境的发行配置，并设置 `GALAXY_NETWORK_PROFILE_FILE`。沿用现有隔离数据库、API/Worker 角色、显式迁移和现有签名键路径，不把私钥放进 profile。

启动后用独立 pin 读取准确 endpoint 的 Manifest，确认 networkType/profile/operator/region，再核对启动配置账本摘要。设置独立本地 Hub 目标和准确 Scope 后进行一次明确批准的连接，检查取回和撤销入口。常见错误：将 JWT/ETag 当目录摘要、复用目录服务 pin 作为 Hub pin、只修改服务类型却没有修改本机目标类型、把签名有效当成业务已授权。

回退使用已验证的旧发行及对应运行配置。停用新增目录读取入口可移除 `hubTrustedKeys`，不改写已有身份；Hub 连接按现有断开/撤销流程处理。不要仅删除 profile 环境变量就把同一部署默认为 Official；服务类型变更须匹配相应发行、目录和本地接入配置。
