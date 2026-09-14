<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/63/6338876c87e2ba0c88732718826324acfceda15825b5ef0460cf62c5afa297b8.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# v0.2 本地 Connection Profile／Scope 契约

> **后续记录（2026-09-09）：** 本文正文保留9月6日源码验收时点；9月7日已验证真实宿主加载，完整布局未验收。静态官网独立发布不改变本契约的not-connected/authorized:false。后续实现以[基础云清单](../../../GALAXY_OFFICIAL_BASIC_CLOUD_DEVELOPMENT_CHECKLIST_v0.1.md)与[原文证据](../../../GALAXY_OFFICIAL_BASIC_CLOUD_SOURCE_EVIDENCE_v0.1.md)对照；不将本地配置伪装成有效远程授权。

实施日期：2026-09-06。已包含本地数据层、L3 默认初始化及项目级稳定 `/galaxy` 的独立只读连接页。远程接入未实施。

`packages/galaxy-core/src/connection-profile.mjs` 提供纯契约、校验、本地文件读写和撤销操作。`galaxy_connection_preview`、`galaxy_connection_status` 是只读 MCP 工具，不接受端点输入，不触发初始化或网络请求。

## 状态与配置

- `capabilityProfile: l3-foundation` 表示推荐能力包／本地意图。`includedModuleIds` 为包内容；`enabledModuleIds` 从现有初始化状态读取，空设备返回空数组。保存连接配置不会启用任何模块。
- 可选配置文件为数据目录中的 `galaxy-connection-profile.json`。未配置独立文件时读取初始化记录内的空连接意图；两者均不存在时返回 `not-applied`。读取不会创建目录或身份。损坏文件与非法字段直接报错，不回退为可用状态。
- Official 最多一个；Hub 由调用方明确配置，不内置地址。HTTPS 端点禁止用户名、密码、查询串和 fragment。配置仅返回 `configured-unverified`，整体始终为 `not-connected`。
- Manifest 始终为 `not-fetched`，binding 为 `not-bound`，`bindingPreview` 为 null。即使存在端点，也须等待远程协议与验证实现后才能生成可签名预览。
- Scope 独立记录 action、targetId、recipient、purpose、visibleFields、expiresAt、revokedAt。action 分为 binding、proof、case-teaser、history、context。状态只可能为 proposed、expired、revoked；`authorized` 始终为 false。
- 本地 audit 记录创建与撤销；重复撤销保持幂等。这是配置操作记录，不是防篡改远程审计或签名证据。

## 内部 API 与持久化边界

`createConnectionProfile` 创建数据对象；`revokeConnectionScope` 返回独立副本；`saveConnectionProfile` 显式保存；`readConnectionProfile` 只读。保存前严格校验，以同目录临时文件和 rename 替换，调用方须串行化同一文件的修改。此版本不提供并发编辑合并或多进程事务。

没有端点配置写入的 MCP 工具或用户 UI；上述文件写接口目前供 Core 集成与测试使用。新的 Personal Galaxy 初始化在最终确认后，将 `capabilityProfile`、`enabledModuleSnapshot` 和空 `connectionProfile` 随初始化状态一同保存。原有 minimal／coding-case 配置不会因读取而升级；模块变更保留既有 L3 初始化快照。重新初始化保持原删除清单，删除状态内的 L3 记录，可选独立连接意图文件仍保留；其中不含 Galaxy ID、签名或有效授权。

## 宿主交互

新流程：语言 → 功能愿景 → 形态 → L3 默认能力包 → 接入与可见性（可读条款）→ 身份 → 精确文本确认。保留五阶段导航及宿主原生 Dialog。Worker／Hub 形态与已有 ID binding 仍不可选择。

控制台选项 6 为独立“接入银河”页，选项 3 仍为设置。连接页只读显示 L3 应用状态、端点、Scope 与未连接边界；确认返回控制台，Esc 退出。标准 MCP 路由新增 `/Galaxy connect`，空设备也可只读查询。

此处确认的是项目级源码与模拟宿主回归测试。未修改用户级 OpenCode 旧绝对路径、未重启宿主、未验证真实小窗布局或全局加载。

Scope 扩大、端点替换不会获得权限。Manifest 读取、换钥验证、断网重试、签名 challenge、远程撤销和传输均未实现；测试仅确认本地模型不会将这些情况误报为已连接或已授权。

## 验证

`npm test` 覆盖空目录无写入、保存／重读、撤销幂等、到期边界、扩大 Scope、替换端点、非法配置、伪造 Manifest／权限字段拒绝、MCP 注册及处理器只读、零 fetch 调用。另以模拟宿主运行真实 Adapter，验证返回、条款查看、错误确认、取消均不写入，精确确认才创建临时测试身份并保存 L3，连接页返回控制台且不修改状态。

不读取 Hermes 归档；不修改全局 OpenCode 配置；不创建真实 Galaxy ID；不部署、发布或访问远程端点。测试数据仅存于自动清理的临时目录。
