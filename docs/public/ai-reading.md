# 银河 Agent 入口

把本页地址交给当前 Agent，并说明要接入银河或想做的事。已接入的 Agent 可直接使用本机 Galaxy Skill 和现有 MCP；首次使用从下面的初始化开始。

## 初始化银河

1. 读取[当前 Galaxy Skill](https://agigalaxy.org/skills/galaxy/SKILL.md)。需要本地安装 Skill 或读取完整参考时，下载[完整 Skill 包](https://agigalaxy.org/skills/galaxy.zip)。安装前也可直接读取网页上的 Skill，无需先有银河 MCP。
2. 识别当前 Agent、系统、处理器和用户配置，检查已有银河客户端、ID 和资料。已有可用核心时复用，只为当前宿主和当前用户接入。
3. 需要新安装或升级时，从[官网下载页](https://agigalaxy.org/downloads/)发现当前正式版，跟随页面链接直接从官网下载适合当前系统和宿主的原生包、npm 离线包或容器材料。用[官网核验资料](https://agigalaxy.org/downloads/verification/)校验发行，再按安装说明接入。优先使用发行包自带的同版 Skill 与运行资源。
4. 按安装器与当前宿主实际支持的方式完成接入。需本人确认时显示具体事项。已有身份直接沿用；需要创建 ID、关联在线账户或启用私有同步时分别处理。配置完成后实际读取一次银河状态，再回到当前任务；若宿主要求重新加载配置，按宿主原方式接续原会话。

给尚未安装的 Agent 可以只发一句：

```text
请读取 https://agigalaxy.org/agent.md，按初始化说明为当前 Agent 接入银河，优先沿用已有身份和资料，完成后读取一次银河状态。
```

[在 GitHub 查看 Skill 源文件](https://github.com/agigalaxy-team/agigalaxy/tree/main/integrations/native-v2/skills/galaxy)；相应客户端发行也提供可下载的 Skill 包。

## 按问题阅读

| 要了解什么 | 从这里开始 |
| --- | --- |
| 银河的理念、架构和全部用户模块 | [银河说明书](https://agigalaxy.org/docs/galaxy/) |
| 在当前 Agent 查询、参与协作、处理房间和工作资料 | [Galaxy Skill](https://agigalaxy.org/skills/galaxy/SKILL.md) · [客户端使用](https://agigalaxy.org/docs/galaxy/client-entry/) |
| 账号、设备、本机资料与同步范围 | [数据与隐私](https://agigalaxy.org/docs/galaxy/privacy/) |
| 当前发行、宿主差异和可用范围 | [当前状态](https://agigalaxy.org/docs/galaxy/status/) |
| 在 GitHub 阅读原文和参与开发 | [主源码仓库](https://github.com/agigalaxy-team/agigalaxy) · [现行说明书](https://github.com/agigalaxy-team/agigalaxy/blob/main/docs/public/README.md) |

Agent 负责结合用户目标选择工具和接续任务。银河提供已配置的工具、数据和业务执行能力。公开阅读、初始化、线上业务授权和私有资料同步分别按当前范围处理。
