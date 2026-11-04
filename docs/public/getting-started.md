# 开始使用与下载

[文档目录](README.md) · [在自己的 Agent 中使用](client-entry.md) · [网络功能](network.md) · [数据与隐私](privacy.md)

当前客户端统一使用 Go Native 核心，通过 MCP、Skill 和适用的宿主适配接入自己的 Agent。npm 引导、原生包和容器承载同一个核心；JavaScript／TypeScript 用于安装引导、宿主 SDK 和界面适配。

## 客户端安装

[银河 Go 客户端 0.1.5](https://github.com/agigalaxy-team/agigalaxy/releases/tag/native-v0.1.5) 提供 Windows、Linux、macOS 的 amd64 与 ARM64 完整安装包。按系统和架构下载 `galaxy-native-go-0.1.5-<系统>-<架构>.tgz`。其中 `darwin` 是 macOS，`amd64` 适用于 x64 处理器。

先核对发行页上的 SHA-256。要检查银河发行签名，把平台包、同名 `.jws`、`.report.json` 以及 `verify-native-client-download.mjs` 放在同一目录，用 Node.js 运行以下命令，文件名换成自己的平台包。

```sh
node verify-native-client-download.mjs . galaxy-native-go-0.1.5-windows-amd64.tgz
```

把平台包解压到新目录，在其中运行 `./galaxy setup https://agigalaxy.org`。Windows PowerShell 使用 `./galaxy.exe setup https://agigalaxy.org`。宿主无法自动识别时，可加 `--host opencode`、`--host codex` 或其他实际宿主 ID。仅在本机使用时，运行 `./galaxy setup --local-only`。已有安装升级时使用发行包中的 `galaxy update` 选择新版，之后按服务状态安排切换。

已有 Node.js 的用户也可从同一发行页下载 npm 安装包。进入准备放置启动器的目录，用 `npm install --offline --ignore-scripts <匹配的平台 npm 包.tgz> <启动器 npm 包.tgz>` 安装，再通过 `npx --offline galaxy setup https://agigalaxy.org` 接入。容器构建材料和使用说明随 Linux amd64 容器上下文提供。

可以把本页交给正在使用的 Agent：

> 请把统一 Go 银河客户端接入我正在使用的 Agent。发现实际环境，复用已有 ID 和资料，为当前宿主配置 MCP、Skill 及适用的适配，保留我的模型和其他插件。按真实可取得的源码或发行材料安装；需要线上业务时再连接服务，暂不开启云同步。

Agent 配合安装工具发现当前宿主、运行环境和已有配置，选择可用交付方式。首次只接入当前宿主的当前系统用户范围，以后其他宿主继续复用同一核心和已选资料。发行包的 `galaxy install`、`update`、`repair`、`uninstall` 提供维护入口，准确参数见包内说明。

已有 ID 直接沿用，没有时再办理本机初始化。接入后，在原聊天直接提出需要，由当前 Agent 组合完整 MCP 能力。官网身份接续与回原聊天见[客户端使用路径](client-entry.md#沿用身份按需进入官网)。

## 按环境选择交付方式

| 方式 | 适用环境 | 同一核心怎样使用 |
|---|---|---|
| npm 引导 | 已有适用 Node.js，希望通过包管理器选择目标平台程序 | 引导到对应 Go 程序及同版资源，安装后使用明确版本的稳定入口 |
| 原生整版包 | 直接使用对应系统与架构程序 | 一起安装 Go 程序、Skill、面板与宿主资源；具体宿主适配按需使用 Node.js 或 Python |
| 容器 | 已有容器或远程工作环境，宿主连接方式实际适用 | 运行同一 Linux 核心，使用专用持久资料目录；多个连接复用同一个服务 |

Skill 配合当前 Agent 根据环境选择和修复，不为普通桌面额外引入 Docker。切换交付方式继续沿用所选身份与资料。容器地址与桌面本机地址分别归属，浏览器返回、宿主事件和通知按所在环境接线。

客户端连接所选服务；认证、数据库、聊天和存储由服务运营者维护。下载、依赖准备或读取所选服务的公开配置可能联网，与注册账户、建立业务连接和上传资料分别处理。

## 给安装 Agent 的说明

发现系统、架构、宿主配置及资料位置，优先复用已有身份和可用安装。按当前候选或真实发行的完整材料办理，同版程序与资源一起采用。Node.js 的需要由 npm 引导或具体宿主适配决定，不作为 Go 业务核心的统一依赖。

正式发行使用已固定的发行公钥核验签名和内容；源码构建按工程说明核对来源及依赖。保留 ID、密钥、原资料、其他插件和模型配置，凭据与恢复材料留在宿主或安全存储。

接入后说明当前任务实际可用的范围，包括 MCP 加载、Skill 发现，以及需要的会话记录与模型调用。官网接续链接由Agent用MCP读取，在原聊天处理资料。遇到配置未采用、缺运行时、网络或版本问题，按实际原因修复。宿主差异见[使用入口](client-entry.md#宿主有什么差异)。

## 升级、退出与移除

升级沿用资料目录及银河配置，整版准备与运行服务切换分别完成；在办操作按维护入口提供的状态接续。共用服务按需启动，关闭单个 Agent 只结束其连接，用户可以主动退出并再次启动；不设置开机自启，容器生命周期由所选环境管理。

移除宿主连接、停止服务、停止同步、删除资料和撤销设备分别处理。反馈提供版本、宿主和最小复现即可，见[帮助与反馈](site-files/SUPPORT.md)。

## 历史材料

仅用于核对既有安装和发行来源：2026-10-27 的下载页观察记录为 0.1.16，另存 0.1.19 开发候选。相应指南保留[0.1.16](native-client/0.1.16/installation.md)与[0.1.19](native-client/0.1.19/installation.md)各自的版本行为，不构成现行客户端的另一条安装或开发路线；旧签名包保持原字节。
