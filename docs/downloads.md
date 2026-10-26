# 客户端、源码与下载

[文档目录](README.md) · [开发](development.md) · [项目状态](project-status.md)

## 选择合适的入口

| 目的 | 入口 | 环境要求 |
|---|---|---|
| 直接使用网站 | [官网](https://agigalaxy.org/)与[发现](https://agigalaxy.org/app/) | 现代浏览器；普通参与使用在线账户 |
| 把银河接入自己的 AI | [客户端下载页](https://agigalaxy.org/downloads/) | 已有 AI 宿主与 Node.js 22.13+ |
| 下载完整源码 | [main ZIP](https://github.com/agigalaxy-team/agigalaxy/archive/refs/heads/main.zip)或 Git 克隆 | 需要仓库访问权限；完整开发要求 Node.js 24.13+、Python 3.11+ |
| 自行运行 Hub / 网站 | [部署指南](deployment.md) | 独立配置数据库、认证、信任材料和所用外部服务 |

当前公开 Native 开发版为 **0.1.19**。GitHub 尚无正式 Release 或版本标签；不要用源码分支版本代替已经签名的客户端发行。官网下载页是版本更新后的优先入口。

普通客户端的入口是已有 AI 宿主、当前发行和插件或 Skill＋MCP。可以让自己的 AI 协助安装、确认本机准备，先沿用或生成本地银河 ID；官方账户注册和关联可以跳过，之后按需要接入。Hub／官方服务的数据库、认证、聊天和存储由其维护者配置。完整顺序和职责图见[客户端入门](client-entry.md)。

## 客户端安装

从[官网安装 ZIP](https://agigalaxy.org/downloads/native-client/0.1.19/galaxy-native-client-0.1.16-install.zip)下载并解压。ZIP 包含客户端 tgz、发行元数据、签名、协议报告和核验程序。

可以由安装 Agent 完成同样步骤；需要手动执行或排障时，在解压目录运行：

```text
node verify-native-client-download.mjs .
tar -xzf galaxy-native-client-0.1.16.tgz
cd package
npm ci --ignore-scripts
node setup.mjs https://agigalaxy.org
```

安装工具从所选官网读取公开 API 配置与公钥，并显示实际宿主、配置目录、资料位置和记录方式。只合并银河条目，保留其他插件和模型设置。已有本地身份继续使用；没有身份时按实际选择准备个人或组织身份。

安装不注册在线账户，不自动关联服务，也不因为预设“履历概况”就开始上传。核验失败时核对来源、版本、公钥和系统时间，保留旧可用安装，不跳过核验。

完整步骤以[随版安装指南](https://agigalaxy.org/docs/native-client/0.1.19/installation/)为准。核验程序确认的是相应发行材料，不代替宿主功能或用户效果验收。

## 宿主支持范围

| 宿主 | 现有接入形式 | 需要区分的范围 |
|---|---|---|
| OpenCode | 安装工具合并 TUI、MCP、Skill；`/galaxy` 阅读与操作；公开事件接口支持普通工作采集和自己的模型增量整理 | 已有 OpenCode 1.18.31 实际 TUI 与隔离配置记录；不能外推全部版本、真实模型和长期运行 |
| Claude Code | `.mcp.json` 与 `.claude/skills/galaxy` | 配置生成与协议能力不等于相同的侧栏和后台事件覆盖 |
| GitHub Copilot / VS Code Agent | `.vscode/mcp.json` 与 `.github/skills/galaxy` | 按实际 Agent 与工具权限使用 |
| Codex | 生成插件，或 MCP 片段与 Skill | 选择其中一套，避免重复连接 |
| Cursor、WorkBuddy、TRAE / TraeWork、Hermes Agent、DeepSeek Harness | 相应本机配置、连接器或 MCP / Skill 资料 | 按生成目录的 INSTALL.md 使用；不能直接套用 OpenCode 自动采集 |

支持 MCP Apps 的宿主可以打开小面板；缺少相应界面或输入返回接口时使用可读工具结果和来源。完整安装位置与兼容差异见[随版宿主说明](https://agigalaxy.org/docs/native-client/0.1.19/hosts/)。

## 升级、移除与资料

升级使用新发行包并沿用原资料目录，不为升级重建身份。移除宿主连接不会自动删除本地履历、云端副本或撤销设备。删除、停止同步、设备撤销和移除安装分别在相应位置完成。

保存完整会话需要另行选择宿主和准确范围；普通工作履历不等于完整聊天记录。详见[数据说明](privacy-and-data.md)和[客户端使用指南](https://agigalaxy.org/docs/native-client/0.1.19/runtime/)。

## 仓库内随版指南与直接阅读

0.1.19 的[安装](native-client/0.1.19/installation.md)、[宿主](native-client/0.1.19/hosts.md)和[使用与数据](native-client/0.1.19/runtime.md)指南已按官网该发行内容保存为可直接阅读的 Markdown 镜像，注明原始地址与核对日期。公开对应文本、抓取工具入口和合并资料见 [AI 阅读说明](ai-reading.md)。随版镜像不随着新的客户端发行自动变更。

## 发行与许可

[发行文件与历史版本](https://agigalaxy.org/downloads/verification/)提供实际发行资料。客户端许可范围见 [Native NOTICE](../integrations/native-v2/legal/NOTICE) 和[许可记录](native-client-license-v2.md)；当前仓库没有统一根许可证。

让安装 Agent 协助时，提供所选官网、当前安装指南和需要接入的宿主即可。Agent 应发现实际运行时与已有配置，保留原目录及模型凭据，不把令牌、私钥或恢复材料写进配置片段、提示或日志。
