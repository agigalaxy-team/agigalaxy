<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/55/55e24a71caf2c6c30469c5f1450b25645719c72a04b5d7800c1cfcf0db3f0473.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 显式配置的原生接入入口

2026-09-11配置切换：`createConfiguredGalaxyPlugin` 现接受配置对象或同步/异步配置提供函数，每次启用读取最新选择。先停用旧实例再启用，不能通过旧回执恢复会话。实际120×40宿主完成五类切换；原回调和直接配置对象用法兼容。见[切换流程与复现](native-configuration-switch-v1.md)。

2026-09-11最新：配置工厂第二参数接受可选 `discoveryTransport: { readManifest, readKeyring }`，传给既有配置运行时；默认公共 HTTPS 路径不变。仅可信宿主代码可提供该传输，用户仍需主动读取并准确确认。独立安装包已在真实 OpenCode 中完成合成身份的 HTTP 绑定、原生取消重开、撤销和过期状态；见[实测与部署边界](native-binding-host-v1.md)。

2026-09-11：新增 `createConfiguredGalaxyPlugin(configuration, options)` 作为可反复启停的宿主模块入口；每次启用创建新 Adapter，卸载钩子负责关闭。本批默认入口已在真实OpenCode 1.18.29加载、页面切换与重新启用通过；配置连接仍需独立宿主验收。见[生命周期与复现](native-host-lifecycle-v1.md)。

2026-09-10补充：可选 `rootPins` 与 `trustDirectory` 已接入明确读取服务信息流程，先更新服务键撤销历史再验证Manifest；更新后旧会话失效，重新接入仍需准确确认。详见[事故签名信任恢复](incident-trust-recovery-v1.md)。原只配置服务键的方式继续兼容。

2026-09-10：宿主可通过 `integrations/host-adapters/opencode-stable/configured-galaxy.tui.ts` 的 `createConfiguredGalaxyAdapter(configuration)` 组合现有本地运行时。默认 `galaxy.tui.ts` 仍可独立加载；没有配置时保持本地只读接入页。

## 宿主接线

```ts
import { createConfiguredGalaxyAdapter } from './integrations/host-adapters/opencode-stable/configured-galaxy.tui.ts';

const adapter = createConfiguredGalaxyAdapter({
  dataDirectory,     // 现有已初始化绝对目录，与原生状态/初始化页面共用
  endpoint,          // 用户明确配置的规范 HTTPS origin
  installationId,    // 宿主保存的稳定 UUID v4
  bindingScopeId,    // 已有 Connection Profile 中的 binding 意图 ID
  scopes,            // 本次请求范围；不是预先取得的授权
  trustedKeys,       // 独立可信来源的 Map；不是 Manifest 自带键的自证
});
export default adapter;
// 宿主卸载时调用 adapter.close()，关闭运行时并清空会话。
```

以上变量必须由宿主的显式配置提供；这不是可直接复制的生产端点配置。构造不会生成 ID、改写 Connection Profile、读取私钥或发起网络请求。配置数据目录直接传入原生页，不依赖更改全局环境变量。

若宿主提供已授权的选中草稿，可用第二个参数 `{ readCaseSubmission }`，其异步返回值为 `{ consentId, payloadJson }` 或 `null`。工厂会将该回调传给原生入口；只有选择提交时才调用，不在打开页面时读取选区。自动化检查与实际宿主验收划分见[宿主验收入口](native-host-acceptance.md)。

## 用户流程

1. 在 `/galaxy` 主控制台第 6 项或设置内的接入入口，查看配置端点和请求范围。
2. 选择“读取服务信息”，匿名 GET 固定 Manifest 路径；复用现有公共请求和签名核验。仅发送公共请求元数据，不发送本地身份、Case、Context 或会话凭证。
3. 信息签名有效且声明支持 binding/sessions 后，展示服务名称、运营者、端点和检查时间。“信息已验证”不表示已连接。
4. 进入既有“预览连接”，读取现有身份与 Connection Profile，展示准确待签请求。逐字确认后使用本机密钥，完成真实绑定/会话协议；每项业务仍需要自身 Scope 和 Consent。
5. 断开本机会话后回到服务信息页，可以主动重新读取。该页保留最近一次信息状态；Manifest 过期后也可用该路径刷新，刷新不会自动重连。断开本机会话不等于撤销远端绑定。

`0` 返回，Esc 退出聊天并取消正在读取的信息；迟到结果不会重开页面。六项主控制台与精确初始化确认保持。缺失本地身份或配置时，连接预览失败，不会补建身份。

## 验证与回退

`configured-adapter.test.mjs` 覆盖无网络构造、无本地写入、错误签名、取消、原生页主动读取、准确目录、本机实际签名四步绑定、断开与迟到结果。服务端采用本机真实处理器和合成身份，未连接生产 HTTPS。既有 L3/连接/履历原生测试覆盖旧配置只读、精确确认和冻结导航。

根严格 TypeScript 检查与 lint 通过；新增窄宿主类型契约，没有关闭 strict。`allowImportingTsExtensions` 配合已有 `noEmit`，允许 Node/宿主直接加载 TypeScript 入口。

移除配置工厂并恢复默认 Adapter 即可回退。没有数据库迁移、便携客户端 API 变更或全局宿主配置修改。真实宿主窗口尺寸与实际卸载钩子接线保留人工验收；动态服务未部署。

## 状态隔离与宿主生命周期（2026-09-10）

配置、Manifest 和短期会话分层管理：配置引用已有 Connection Profile；Manifest 及其检查时间仅在配置工厂内存中保存；当前会话只保存必要元数据和不可序列化的凭据闭包；业务 Consent 继续由独立流程管理。绑定回执现已单独落盘并提供离线历史入口，见[本机回执](local-binding-receipts.md)。重启后重新读取/确认，不恢复旧会话，不将凭据写入公开配置。尚无操作系统钥匙串持久化。

`discovery.status()` 是只读快照，不访问磁盘或网络、不包含控制器或凭据。它区分未读取、读取中、验证通过、过期、不可达、未验证、不支持连接、本机配置错误、取消、关闭。已验证信息也会按当前时钟和当前信任键变化重新判定状态；不能把过去一次验证当作永远有效。

原生页显示已有会话状态的中文/英文解释：本地检查失败、授权变化、会话过期、远端拒绝与远端结果未知分别展示。远端拒绝不推断具体撤销原因；未知结果不自动重试。离开接入页仍可返回原本地控制台。

`adapter.close()` 现在取消读取和连接操作、移除根命令及模态键、关闭配置运行时并丢弃会话。关闭后不能再次挂载；改变端点、数据目录、安装实例或请求 Scope 时，宿主先关闭旧实例再创建新实例。预览后改写现有身份/Connection Profile、撤销本地授权或信任键，均由既有本地运行时在实际发送/签名时阻断；不能用新配置继承旧批准。

原生 Dialog 的延迟确认、取消和选择回调绑定当前页面；Esc、切页或卸载后不会继续执行旧回调。测试覆盖立即确认后 Esc、卸载前的排队选择、关闭期间的迟到网络结果，以及实际本机签名、配置撤销、过期、重置和错误密钥。23项相关测试分两组通过，另对配置入口2项在信任状态改动后复跑通过；严格TypeScript和lint通过。真实生产HTTP及人工窗口验收未执行。
