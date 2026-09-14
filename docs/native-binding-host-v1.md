<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/ab/abdf5f721b1dda75608dfd4ebf4de0888fe58beb46aba4d783e6819026ecdd37.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 原生宿主绑定与取消流程

2026-09-11：独立安装的 `@galaxy/native-host` 候选在真实 OpenCode 1.18.29、80×24 Windows 终端中完成了服务发现、取消、错误确认、精确确认、绑定查询、撤销后拒绝、错误签名和过期信息处理。按键通过 ConPTY 输入，菜单通过宿主命令 API 调度；没有替换原生 Dialog 或直接调用确认回调。

## 修复的实际问题

第一次尝试在 Esc 取消后重新预览时失败，提示“无法准备连接；没有发送”。OpenCode 的 `DialogPrompt` 虽声明 `onCancel`，当前组件在 Esc 时只运行对话框关闭清理；旧适配器只释放菜单键，连接预览仍占用运行时。

现在关闭清理同时取消当前操作，并区分已经确认的页面跳转。旧页面清理不会取消新页面，确认后宿主自动关闭 Alert/Select 也不会丢失下一步。六项主菜单、`0` 返回、Esc 退出聊天、初始化与连接的逐字确认均保持原语义。新增回归覆盖不调用 `onCancel` 的真实关闭顺序。

上游依据固定到实际安装版本对应提交：[DialogPrompt](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/tui/src/ui/dialog-prompt.tsx)、[Dialog 关闭与替换](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/tui/src/ui/dialog.tsx)、[DialogAlert 确认后关闭](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/tui/src/ui/dialog-alert.tsx)。

## 真实进程结果

|操作|实际结果|
|---|---|
|显式读取已有端点|匿名 Manifest GET；未创建绑定或改写现有身份/配置|
|Enter 进入连接页，Esc 取消预览|无 POST；重新进入可继续预览|
|输入错误确认文字|显示不匹配，无绑定或签名请求|
|逐字确认准确请求|实际本机签名；四个 HTTP POST 完成绑定挑战、绑定、会话挑战和会话|
|查询绑定，撤销后再查询|先返回 200/binding-verified，随后返回 401/remote-rejected|
|撤销后打开本地 Case|入口仍可访问；实际离线草稿创建由同批 HTTP 综合测试另行验证|
|错误签名与过期 Manifest|分别显示“服务信息未通过验证”和“服务信息已过期”|
|退出并停用插件|Galaxy 命令清空，进程退出码 0；原 6 个本地文件摘要不变，只新增绑定回执文件|

成功报告保存 14 个实际渲染状态、6 次终端按键阶段。合成服务跨两次尝试累计 10 个业务 HTTP 请求：首次失败尝试只读取 1 次 Manifest，成功尝试 9 次；四次 POST 均在精确确认之后。Case、Case event、Consent、Proof 和 Context grant 均为零。服务已正常停止，退出码 0。

这里使用合成身份、PGlite 与真实服务 HTTP 处理器。可信测试桥把逻辑 HTTPS origin 映射到明确的 loopback HTTP 服务；这证明宿主接线和协议流程，不证明生产 HTTPS、真实用户或公网发布。撤销由夹具调用既有服务方法触发；本人撤销接口的准确确认与 HTTP 行为由原 T02/T03 流程覆盖。

## 配置与复现

配置工厂第二个参数新增可选 `discoveryTransport`，向已有 `createConfiguredRuntime` 传递 `readManifest`/`readKeyring`；省略时仍使用原公共 HTTPS 读取器。该参数由可信宿主代码提供，不接受 MCP 调用者或网页输入。原地址检查、独立公钥验证、本机签名、Scope 和 Consent 约束不变。

```text
node scripts/build-native-host.mjs <absolute-new-package> <absolute-pinned-client-lock>
node scripts/install-native-host-candidate.mjs <absolute-built-package> <absolute-npm-cli.js>
node packages/galaxy-official/test/opencode-binding-service.mjs <absolute-existing-new-output>
node scripts/prepare-opencode-host-check.mjs <opencode-binary> binding <installed-package/galaxy.js> <service-ready-address>
node <printed-launch.mjs>
```

最后一步需要真实终端。按该次 `phase.json` 的 `keyboard` 值向终端输入，等待阶段变化；确认字符串仅针对该次合成请求。探针结束后检查 `host-report.json` 和退出码，再使用 Node fetch 请求该次 loopback 地址的 `/fixture/stop`，等待服务退出。不要将夹具控制路由部署到服务发行包。

AI Agent 应从 `service-ready.json` 读取地址，从 `installation.json` 读取独立安装目录。准备器隔离 XDG、宿主配置和 Galaxy 数据，测试密钥只保存在 OS 临时合成目录。不要复用真实身份、修改全局 OpenCode 配置或把本地 HTTP 桥配置用作公网连接。失败时保留报告，修复后构建新的不可变候选。

## 交付与剩余范围

当前候选为 `outputs/native-host-20260911-3`：111 个源模块、9 个 ESM、13 个打包文件，182407 字节，SHA-256 `b137257ecca6ae3a1defcecbd8d83afd33eb31bc36448555eb91f66f23fcec34`。离线独立安装和入口导入通过；未签发或公开发布。

严格类型、lint、14 项宿主契约测试及 10 项原验收相关测试通过。后者包含真实 MCP HTTP 公开文档读取、绑定正常/拒绝/重放/并发/撤销、离线 Case 草稿，以及本机签名和范围检查。CL-01/02/03/05/06 的自动实现进入待复核；原验收条款不变，真人体验、生产来源和发布条件保留。CL-07 的真实配置/身份切换，以及 CL-09 的不同终端尺寸和完整人工体验继续推进。

[成功宿主报告](../outputs/opencode-host-1789091818397/host-report.json) · [首次失败报告](../outputs/opencode-host-1789091203498/host-report.json) · [服务结束状态](../outputs/opencode-binding-service-20260911-1/service-result.json) · [安装记录](../outputs/native-host-20260911-3/installation.json) · [分层检查](../outputs/layer-check-1789091927135-b68c18cc-41dd-4f05-8914-15825133a9c9/report.json) · [原验收相关输出](../outputs/opencode-host-1789091818397/criteria-check.log)
