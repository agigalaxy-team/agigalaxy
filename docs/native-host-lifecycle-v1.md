<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/a6/a61cdc797860023342e388e12fd4e5031bf53742033b528229f2bb72ac41df9a.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# OpenCode 原生插件生命周期接线

同日初始化收尾：当前候选5在80×24和120×40完成首次初始化，真实数字键、错误确认、取消、准确初始化及重启后只读状态通过；原文件不被重写。见[完整原生初始化](native-initialization-layout-v1.md)。

同日配置切换：通用插件工厂支持异步 Adapter，配置插件可在每次启用时读取当前配置。停用后迟到的提供函数不会注册命令；15项宿主契约通过，真实切换运行见[配置与身份切换](native-configuration-switch-v1.md)。

同日后续：真实终端 Esc 只触发对话框清理、未调用 onCancel，导致旧预览未释放。适配器现已修复，并通过取消重开、错误确认、准确绑定及撤销后的真实流程；当前宿主契约 14 项通过。详见[关闭时序与绑定证据](native-binding-host-v1.md)。

同日后续：本修复现已纳入独立原生宿主包并实际安装运行，后文“尚未重新生成客户端包”只描述本批当时边界。正式签发/发布仍未执行；见[原生包与五场景](native-host-package-v1.md)。

2026-09-11：本机 OpenCode 1.18.29 Windows 原生进程已验证插件加载、语言页、欢迎页、退出命令、停用、重新启用及再次打开。终端为80×24，证据保存真实渲染文本；完整布局与物理按键体验仍待人工验收。

## 修复与配置

默认插件模块不再永久复用一个 Adapter。OpenCode 每次启用插件时，`createGalaxyPlugin()` 创建新实例；Adapter 接入 `lifecycle.signal` 与 `lifecycle.onDispose()`，卸载取消读取/连接、断开运行时并清理菜单及命令。直接使用 `createGalaxyAdapter()` 的调用方仍拥有 `close()`，单实例只能挂载一次。

真实宿主还暴露了旧模拟器遗漏的问题：`dialog.replace()` 执行旧页面关闭回调，旧代码在回调里误删新页的退出与编号键。现在每页只清理自身注册，且清理幂等。其他插件替换 Galaxy 页面后，卸载 Galaxy 不会关闭那个页面。原 `/galaxy` 顺序、导航与精确确认不变。

配置工厂保留；需要交给宿主多次启停的模块使用新包装器：

```ts
import { createConfiguredGalaxyPlugin } from './configured-galaxy.tui.ts';
export default createConfiguredGalaxyPlugin(configuration, { readCaseSubmission });
```

输入及授权边界沿用[配置说明](configured-native-adapter.md)。包装器不生成身份、不自动读 Manifest 或连接。本批真实进程使用默认未初始化入口，实际配置绑定流程仍需独立验收。

## AI Agent 部署与复现

定位已安装的 OpenCode 可执行文件，再执行：

```text
node scripts/prepare-opencode-host-check.mjs <installed-opencode-binary>
node <printed-launch.mjs>
```

准备器为子进程生成独立 XDG 配置/数据/缓存/状态、临时项目和 Galaxy 目录；只传递基础运行环境，不继承提供者凭据。实际宿主日志只加载临时配置。不改用户级 OpenCode 配置，不创建 Galaxy ID、不调用模型或 Official。探针通过真实宿主 API 调度命令，不使用模拟 Dialog。

`outputs/opencode-host-*/input.json` 固定程序/Adapter/探针摘要，`host-report.json` 保存版本、插件、命令、对话框和渲染文本。检查进程退出码、报告结果及未初始化目录未创建。临时宿主数据不是项目身份或运行配置。加载失败时检查该次隔离目录日志，不应改全局配置或借用真实身份。

`node scripts/verify-layers.mjs --layers=adapter,host-contract` 最终严格类型检查及7文件13项测试通过，lint通过。首次组合运行因旧MCP断言仍期待7项工具而失败；核对当前接口后，改为精确验证8个工具名称，补跑和最终组合检查通过。

本批未重新生成、签发或发布客户端包；发行前应包含本次修复。完整初始化、旧配置、已初始化状态、真实配置连接、不同尺寸、物理按键与用户判断继续保留在 CL 原验收要求中。

## native v2 运行时收尾

native v2 的宿主进程收到 `SIGTERM` 或 `SIGINT` 时，会先关闭 MCP 服务、释放已绑定 Watch 的定时器与事件订阅，再关闭本机运行时连接。宿主重新启动并第一次访问 Watch 时，会从本地授权记录恢复仍有效的 Watch 调度；恢复只建立有界宿主检查，不自动检查、不调用模型、不确认工作。过期、停止或撤销的 Watch 不会重新激活。用户 Agent 仍负责读取工作、处理内容并显式确认。

## 上游依据与证据

- [OpenCode 配置说明](https://opencode.ai/docs/config/)：自定义配置会与其他来源合并，单独指定路径不能隔离整个宿主。
- 固定1.18.29源码的[全局目录](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/global.ts)、[运行开关](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/flag/flag.ts)和[插件生命周期](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/specs/tui-plugins.md)。本机插件类型也声明 signal/onDispose。
- [最终真实宿主报告](../outputs/opencode-host-1789089334131/host-report.json)；[页面切换失败记录](../outputs/opencode-host-1789089211487/host-report.json)保留。
