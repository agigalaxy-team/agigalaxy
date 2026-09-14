<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/0d/0d4ad43f2a7a801899dd991bc5154068dc4e91b3bc795007f689b0dbfdc3024f.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 原生宿主配置与身份切换

2026-09-11：CL-07 自动实现已交付待复核。独立安装的候选 4 在真实 OpenCode 1.18.29、120×40 ConPTY 中完成端点、Scope、请求内容、身份目录切换及合成重新初始化。记录 41 个渲染状态、22 次终端按键阶段、30 个实际 HTTP 请求；原真人体验、生产 HTTPS 与发布要求保留。

## 每次启用重新读取配置

`createConfiguredGalaxyPlugin` 保留直接传入配置对象的用法，也接受同步或异步配置提供函数。宿主停用旧插件后保存新的选择，再启用插件；提供函数在每次启用时重新运行，新实例从尚未读取 Manifest、无会话状态开始。

```ts
import { createConfiguredGalaxyPlugin } from '@galaxy/native-host/configured';

// loadCurrentHostConfiguration 由可信宿主实现，返回当前明确选择的配置。
export default createConfiguredGalaxyPlugin(async () => loadCurrentHostConfiguration());
```

旧实例关闭会取消预览与未完成操作、丢弃内存凭据并解除菜单。异步配置仍在等待时若宿主已停用，迟到创建的 Adapter 会关闭，不会注册命令。提供函数错误由宿主报告，不回退到旧会话。仅修改外部对象不等于切换已运行实例；实际切换必须先停用旧插件。

此入口没有增加自动连接、配置编辑菜单、身份迁移或自动初始化。冻结的 `/galaxy` 主菜单、`0` 返回、Esc 退出和逐字确认保持原语义。

## 实际流程与证据

|切换|实际结果|
|---|---|
|Official A → B|先替换现有 Connection Profile 的唯一 Official 目标，再重新启用；B 无旧回执、无会话，读取与绑定分别确认|
|A 的 binding → binding/history|历史回执显示配置不同；旧确认文字被拒绝，精确确认新范围后才建立新绑定|
|改变 installationId，即改变请求内容|旧回执保留为历史，旧请求确认文字不匹配；新请求独立确认|
|切到另一合成身份目录|该身份看不到原身份的回执，没有旧会话；本机签名建立新绑定|
|重新初始化当前合成目录|新 ID 与旧 ID 不同；运行中的旧会话在本地失效，核查返回 no-session，没有发送凭据；重新启用后旧回执不成为新身份的授权|

六次绑定均有独立确认，产生 24 个 POST；每次显式发现产生 1 个 GET，共 30 个业务请求。成功运行没有携带 Bearer 的 HTTP 请求：重新初始化后的核查在发送前已失效。与上一批真实撤销后 401、T02/T03 的接口正常/拒绝流程共同覆盖原验收。

原合成身份的身份文件没有改变；Connection Profile 在显式切换端点后恢复为原配置，最终原 6 文件摘要一致。第二个合成身份目录经过明确的测试重置和重新初始化；旧回执仍作为历史存储，按当前身份过滤。本测试调用现有 Core 重置入口，不作为真人在 UI 中确认重置的证据。

服务首次使用的准备脚本被“一份 Profile 只能有一个 Official”规则拒绝，脚本已改成逐次替换，产品约束未放宽。第一次宿主探针误把菜单中的“本机绑定回执”选项当成已打开的回执页，发生 5≠0 的断言失败；改为同时等待实际回执页标题和渲染内容。失败报告保留；成功报告以运行前计数计算增量，没有把前次 1 个绑定计入本次 6 个绑定。

两个实际合成服务和宿主均正常退出，退出码 0。Case、Case event、Consent、Proof、Context grant 均为零。测试只使用隔离临时身份与 loopback 服务，没有改用户级 OpenCode 配置或远程运行服务。

## AI Agent 复现与部署

先按[原生包构建步骤](native-host-package-v1.md)构建和独立安装候选。启动两个新合成服务输出目录，A 接受测试中的两个绑定范围，B 使用默认范围：

```text
node packages/galaxy-official/test/opencode-binding-service.mjs <new-existing-output-a> https://switch-a.galaxy.invalid binding,history
node packages/galaxy-official/test/opencode-binding-service.mjs <new-existing-output-b> https://switch-b.galaxy.invalid
node scripts/prepare-opencode-switch-check.mjs <opencode-binary> <installed-package/galaxy.js> <address-a> <address-b>
mode.com con cols=120 lines=40
node <printed-launch.mjs>
```

地址从各自 `service-ready.json` 读取。宿主必须在真实终端运行，按照该次 `phase.json` 向终端输入按键；探针通过真实宿主 API 调度菜单，原生 Prompt 接收实际终端文字，不直接调用确认回调。检查成功报告、尺寸和退出码，再请求两个 loopback 服务各自的 `/fixture/stop` 并等待退出。准备器隔离宿主目录；真实身份、全局配置和公网参数均不能替代合成输入。正式宿主可以使用配置提供函数，测试桥及夹具路由不属于发行服务。

当前候选 4 共 182447 字节、13 文件、111 源模块/9 ESM，SHA-256 `d681ae5acec8bda424df337bb9dd08b0653a168f8a0e853a0537624777d8891a`。15 项宿主契约、严格类型和 lint 通过；未签发或公开发行。

CL-09 已新增 120×40 的真实运行证据，并保留前批 80×24 记录；完整首次初始化、多尺寸布局可用性和真人体验仍需继续核对。尺寸读数不是全部界面可用性的验收结论。

[成功报告](../outputs/opencode-host-1789093019673/host-report.json) · [失败报告](../outputs/opencode-host-1789092906804/host-report.json) · [当前安装包](../outputs/native-host-20260911-4/installation.json) · [相关检查](../outputs/layer-check-1789092849592-8b5d1ba1-9dec-49e2-8e54-e9e74fb8daa0/report.json)
