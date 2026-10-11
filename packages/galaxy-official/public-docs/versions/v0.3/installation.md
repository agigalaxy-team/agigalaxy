# 原生宿主开发候选版：下载与启用

版本：public-docs v0.3，2026-09-11。发行修订：0.1.0-rc.20260911；包版本0.1.0。

这是公开下载的开发候选版，供了解当前本地体验。正式稳定发行和人工体验验收尚未完成。已验证Windows、Node24.19.0、OpenCode1.18.29；其他版本与操作系统暂不列入已验证范围。包包含本地身份签名能力，不含私钥。网页和加载插件本身不会替你初始化、连接或发布。

## 1. 下载并校验

先确认已安装Node24.19.0和OpenCode1.18.29。以下命令用于Windows PowerShell，在一个新的普通目录执行；不要放入已有项目或覆盖已有配置。下载后先运行校验器，看到`verified:true`再继续安装。

```powershell
New-Item -ItemType Directory galaxy-preview
Set-Location galaxy-preview
Invoke-WebRequest 'https://agigalaxy.org/downloads/native-host/0.1.0-rc.20260911/galaxy-native-host-0.1.0.tgz' -OutFile 'galaxy-native-host-0.1.0.tgz'
Invoke-WebRequest 'https://agigalaxy.org/downloads/native-host/0.1.0-rc.20260911/release.jws' -OutFile 'release.jws'
Invoke-WebRequest 'https://agigalaxy.org/downloads/native-host/0.1.0-rc.20260911/host-acceptance.json' -OutFile 'host-acceptance.json'
Invoke-WebRequest 'https://agigalaxy.org/downloads/native-host/0.1.0-rc.20260911/verify-native-download.mjs' -OutFile 'verify-native-download.mjs'
node .\verify-native-download.mjs .
```

包SHA-256：`13b32760166cef9b98a3ba433d0856c89fc782e3b0fe71ccbe45bd03dbae0e89`，181871字节。也可用`Get-FileHash -Algorithm SHA256 ./galaxy-native-host-0.1.0.tgz`独立比对摘要。

校验器SHA-256：`8b6d6b152b17cdb8be321c4ba2fdd9082f6be0ac6e6a3a5d53183e8ac07764af`。校验器复用发行签名校验代码，读取网站当前公钥状态并核对固定公钥指纹、JWS、包及宿主报告；它不会安装包或连接Galaxy业务服务。确认下载来源与摘要后再运行文件。

发布者：https://agigalaxy.org。公钥：[keys.json](https://agigalaxy.org/releases/keys.json)；JWK thumbprint：`mpeo6qMIGNl-uw1MPlQH3SKqmrMuZqdNjAP0YgsQ2U4`。签名有效至2026-10-11T05:57:54.000Z；过期、撤销或校验失败时不要继续安装，应返回下载页获取后续候选。HTTPS域名与固定公钥是当前信任来源，不是第三方能力认证。

## 2. 安装到独立目录并配置原生入口

```powershell
npm init -y
npm install --ignore-scripts --save-exact ./galaxy-native-host-0.1.0.tgz
node --input-type=module -e "import{writeFileSync}from'node:fs';import{resolve}from'node:path';import{pathToFileURL}from'node:url';writeFileSync('galaxy-preview.tui.json',JSON.stringify({plugin:[pathToFileURL(resolve('node_modules/@galaxy/native-host/galaxy.js')).href]},null,2),{flag:'wx'});"
$env:OPENCODE_TUI_CONFIG = (Resolve-Path .\galaxy-preview.tui.json).Path
opencode
```

`OPENCODE_TUI_CONFIG`只作用于当前终端及它启动的进程。该示例使用新建的候选配置，结束试用可关闭此终端；没有修改全局OpenCode配置。已有宿主配置的用户应在了解配置合并方式后手动接入，不覆盖原配置。

进入OpenCode后输入`/galaxy`。按界面完成五阶段初始化；最后一步仍须输入界面要求的精确确认文本。已存在的Galaxy身份继续保留，不要为升级执行init/reset。主菜单、0返回、Esc退出和本地确认交互保持。

## 范围、升级和回退

五份实际OpenCode进程报告覆盖80×24和120×40初始化、数字键、旧配置与离线场景，共97个观察状态。身份与工作材料为合成夹具，未代替真实用户反馈。报告：[host-acceptance.json](https://agigalaxy.org/downloads/native-host/0.1.0-rc.20260911/host-acceptance.json)。

@galaxy/native-host的`./opencode`用于原生TUI入口，`./configured`用于明确配置的连接适配。此页只说明本地入口；不提供Official或Hub的业务地址。绑定、公开Proof、远程MCP和云端协作尚未开放。L3初始化不代表已经联网。

候选包中的`private:true`用于防止误发npm registry，包内旧构建说明保留“Local candidate”标记；当前分发范围以本页的开发候选说明为准，不能解释为正式稳定版本。此版本的4个依赖固定为canonicalize4.0.0、ipaddr.js2.5.0、jose6.2.12、zod4.5.4，由npm按包声明安装；不含整个Official服务器。

升级时先在另一个目录下载校验并安装，然后手动切换宿主配置；保留原身份目录。回退时重新选择旧配置和旧包，不重建Galaxy ID，不回滚或恢复已撤销授权。退出候选终端即可结束本次配置作用范围。

[下载页](https://agigalaxy.org/downloads/) · [项目状态](https://agigalaxy.org/status/) · [隐私说明](https://agigalaxy.org/docs/v0.3/privacy.md)
