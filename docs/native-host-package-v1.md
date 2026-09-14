<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d8/d88c53ab62a78b9633ef7a2c30d7621f35651110020971c6bf9b8ae8eeadcfea.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 原生宿主包与实际运行记录

当前候选为 `native-host-20260911-5`：修复小终端初始化信息溢出；80×24/120×40完整五阶段、真实数字键、旧配置和离线均从独立安装包通过。CL-09自动交付待复核，正式签发/发布保留；见[完整初始化与当前包](native-initialization-layout-v1.md)。以下候选1–4为各批历史证据。

当前候选更新为 `native-host-20260911-4`：增加每次启用重新读取配置的函数入口，独立安装后在120×40真实宿主完成端点、Scope、payload、身份和重新初始化五类切换。候选3的绑定记录保留；当前摘要与证据见[配置切换](native-configuration-switch-v1.md)。

同日后续：当前候选已更新为 `native-host-20260911-3`，包含原生 Esc 取消修复与显式 discoveryTransport 接线；独立安装后完成真实终端绑定、错误确认、撤销和 Manifest 错误/过期流程。以下候选 1 的摘要与五场景记录保留为历史证据；当前包及复现见[原生绑定实测](native-binding-host-v1.md)。

2026-09-11：新增 `@galaxy/native-host` 本地候选。它补齐实际OpenCode适配器及本机运行层的独立安装交付；现有 `@galaxy/client` 仍是便携协议客户端。两者职责和发布身份分别记录。

## 构建与安装

使用仓库已有的esbuild0.27.3，并将该实际版本列为直接开发依赖。Adapter原来的三个计算URL导入改为等价的字面量动态导入，使构建器能收集依赖；页面、初始化和连接语义未改变。

```text
node scripts/build-native-host.mjs <absolute-new-output> <absolute-pinned-client-lock>
node scripts/install-native-host-candidate.mjs <absolute-built-package> <absolute-npm-cli.js>
```

构建产生9个ESM文件，收集111个Core、客户端、本机运行层和Adapter源文件。包导出 `./opencode`（默认插件）及 `./configured`（显式配置工厂），保留canonicalize4.0.0、ipaddr.js2.5.0、jose6.2.12、zod4.5.4四个固定依赖。包含本机签名实现，不包含私钥或任何用户数据。

安装脚本使用独立空npm配置、离线ci/pack和临时消费者目录，逐文件核对包摘要，实际导入两个入口。包没有指向源码仓的运行时引用，也不复制服务端数据库、服务签发密钥或用户身份。

本次 `galaxy-native-host-0.1.0.tgz` 共182284字节、13个打包文件，SHA-256为 `945298855ebaf2a4c2998996da3c8353f5c494800c855720b97c2e9b6b8a7d7c`。这是未签发的本地候选，未发布npm、官网或真实下载渠道；不能用它宣称正式发行。

## 从安装包运行真实宿主

```text
node scripts/prepare-opencode-host-check.mjs <opencode-binary> <scenario> <installed-package/galaxy.js>
node <printed-launch.mjs>
```

场景支持uninitialized、initialized、legacy、recovery、invalid-connection、offline。后五项本次已在真实OpenCode1.18.29运行，使用独立安装目录的包，均正常退出。全部终端为80×24；探针通过真实宿主API调度命令并保存实际渲染文本。

|场景|验证结果|
|---|---|
|initialized|L3本地状态、未连接说明、设置返回和本地Case入口；5个本地文件摘要不变|
|legacy|读取旧文件名与旧profile，显示L3尚未应用；5个文件保留，不自动迁移或生成ID|
|recovery|显示中断恢复说明，未进入初始化；恢复标记不变|
|invalid-connection|显示连接配置读取失败，仍能回设置和Case入口；5个文件不变|
|offline|对保留的.invalid测试域名读取失败，显示未取得服务响应，仍可使用本地入口；5个文件不变|

测试身份由准备脚本在临时目录生成，标记synthetic-host-acceptance，绝非用户真实身份或经授权真实Case。Case这里验证原生入口可访问，不替代真实Case创建/协作验收。默认未初始化入口的前次真实运行见[生命周期记录](native-host-lifecycle-v1.md)；本次相关13项测试、严格类型和lint通过。

## AI Agent 部署说明

先核对安装目录、包摘要、固定依赖和当前OpenCode版本，保留当前数据目录。OpenCode项目级 `.opencode/tui.json` 的 `plugin` 可引用安装包的 `galaxy.js`；配置入口则用包装模块调用 `createConfiguredGalaxyPlugin`。参见[配置工厂](configured-native-adapter.md)。这些是后续安装步骤，本批没有修改全局或项目常用插件配置。

升级或回退只切换经核对的包路径，不运行init/reset、不复制用户私钥，也不把本机签名实现交给不可信远程调用方。加载本身不连接Official；Manifest读取、签名绑定和业务授权分别确认。出错时优先看本次隔离配置与宿主日志；不要把能导入模块当作完成全部宿主验收。

后续继续：已有端点/Scope的真实配置读取、有效Manifest与绑定、取消/撤销/过期、更多尺寸和物理键盘；正式publisher、签名及发行渠道仍需落实。当前CL和C03-02原验收条件不变。

[安装与包摘要](../outputs/native-host-20260911-1/installation.json) · [包清单](../outputs/native-host-20260911-1/native-host.json)
