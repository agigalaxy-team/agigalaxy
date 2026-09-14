<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/7f/7fc09c1aad6f043f531394efa464c31ca130d3913fd42a559a5bb26b97739f55.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 完整原生初始化与终端布局

2026-09-11：CL-09 的自动交付进入待复核。实际安装的候选 5 在 OpenCode 1.18.29 的 80×24、120×40 Windows ConPTY 中完成五阶段初始化；80×24 额外通过真实数字键导航。原五阶段、六项主菜单、`0` 返回、Esc 退出及逐字确认保持原语义。

## 发现并修复的显示问题

候选 4 的真实 80×24 流程能执行，但渲染记录显示 L3 采用按钮、隐私条款入口、条款返回说明与最终确认输入说明被长标题挤出屏幕。该报告的 `passed` 只代表流程执行，`layoutFindings` 仍有七个记录，不能视为布局通过。

候选 5 使用现有原生 Dialog，压缩初始化标题、模块名称及隐私说明的排版。模块摘要取实际初始化预览的五个已选模块；本地发现/Hub 明确未启用，修正旧展示把规划项也加勾的问题。Official 默认入口、Hub 可选、本地身份与远程授权分离、各对象的接收方/用途/字段/时限/撤销要求保留。导航提示将 Esc 准确标为退出。

上游固定版本的 [DialogSelect](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/tui/src/ui/dialog-select.tsx) 只为选项区域设置滚动和高度，长标题仍占用独立空间；[DialogPrompt](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/tui/src/ui/dialog-prompt.tsx) 也在标题下放置输入区域。本修复调整显示文案，复用原生组件，没有增加 UI 框架或改变 Core 初始化规则。

## 本批实际结果

|场景|结果|
|---|---|
|80×24 五阶段|21 个渲染状态，必要文本缺失列表为空；错误确认和取消均未写入，准确确认后生成 5 个本地文件|
|120×40 五阶段|同一安装包、同样 21 个状态和五阶段；必要文本缺失列表为空|
|80×24 数字键导航|34 个状态、22 次终端按键阶段；`1` 选择、`0` 返回、`4` 打开隐私条款、Enter、Esc 和中文精确确认均通过|
|80×24 旧配置|旧格式读取、返回、Case 入口、停用/启用通过；原 5 文件不变，不自动应用 L3 或生成新 ID|
|120×40 离线|`.invalid` 端点读取失败有准确说明，本地入口、返回和重启后读取通过；原 5 文件不变|

准确确认后，实际本机状态为 `l3-foundation`、五个模块、`not-connected`。设置返回、接入页只读查看和插件停用/再启用不会重写这五个文件。隔离目录中的身份由真实原生初始化操作创建，是测试身份，不代表真实用户或正式发行身份。

15 项宿主契约、严格类型和 lint 通过。原绑定/会话/撤销、配置与身份切换、恢复和错误配置证据仍保留，见[绑定流程](native-binding-host-v1.md)、[配置切换](native-configuration-switch-v1.md)及[早期五场景](native-host-package-v1.md)。本批实际键盘流程使用中文；英文整体体验、更多终端/宿主组合和真人反馈继续在复核中记录。文本可见性检查覆盖本批必要控件，不能替代所有页面的人工视觉验收。

## AI Agent 复现与发行边界

```text
node scripts/prepare-opencode-host-check.mjs <opencode-binary> initialization <installed-package/galaxy.js>
mode.com con cols=80 lines=24
node <printed-launch.mjs>
```

使用新输出和隔离临时目录。按该次 `phase.json` 提供的阶段向真实终端输入，等待阶段变化；不可直接调用 Dialog 确认回调。换一套新目录并把 ConPTY 改成 120×40，可复现另一尺寸。首先核对 `input.json` 的安装包路径与二进制摘要；结束后检查报告、`layoutFindings`、本地状态和进程退出码。`legacy`/`offline` 场景复用同一准备器。不要以截图文本里存在确认词替代真实输入检查，也不要借用用户身份、全局配置或远程凭据。

候选 5：111 源模块、9 ESM、13 打包文件，181871 字节，SHA-256 `13b32760166cef9b98a3ba433d0856c89fc782e3b0fe71ccbe45bd03dbae0e89`。独立离线安装通过。本批没有变更 Core 数据格式、服务 Schema、用户级 OpenCode 配置或远程服务，没有正式签发/公开发布插件。

[修复前布局记录](../outputs/opencode-host-1789093648382/host-report.json) · [80×24](../outputs/opencode-host-1789094076755/host-report.json) · [120×40](../outputs/opencode-host-1789094076756/host-report.json) · [真实数字键](../outputs/opencode-host-1789094378016/host-report.json) · [旧配置](../outputs/opencode-host-1789094254628/host-report.json) · [离线](../outputs/opencode-host-1789094254639/host-report.json) · [安装包](../outputs/native-host-20260911-5/installation.json)
