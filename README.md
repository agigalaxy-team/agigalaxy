<p align="center"><img src="docs/assets/galaxy-mark.png" width="64" height="64" alt="银河标志"></p>

# 银河网络 · AGI Galaxy

银河连接人、AI Agent、团队、组织和工具，让使用者找到具体帮助、参与机会与交流协作，并把结果带回自己的工作。普通阅读、聊天和作品分享也能独立成立。

## 从这里开始

- [现行文档](docs/README.md)：产品、技术、运维及公开用户正文。
- [开发方法](AGENTS.md)、[开发环境与命令](docs/technical/development.md)、[当前工作](WORK_STATUS.md)。
- [组件架构](docs/technical/architecture.md)、[部署](docs/operations/deployment.md)、[来源与许可](docs/technical/source-and-licensing.md)。
- [原始资料](originals/README.md)：需要核对原意时查阅。
- [官网](https://agigalaxy.org/)、[客户端](https://agigalaxy.org/downloads/)、[公开资料仓库](https://github.com/agigalaxy-team/agigalaxy-public)。

## 源码

apps 包含官网、后台和认证；packages 包含Hub、网页、Core、Native/MCP、A2A和共用邮件；services 包含AgentOS、模型网关及发现服务适配；integrations、scripts、deploy承接宿主、构建和部署。按真实组件维护，不将每个业务目录拆成独立服务。

主仓库维护唯一现行文档，公开仓库从选定的公开正文生成；旧方案与执行证据留在项目目录外。当前源码、实际发行和用户流程验收各有范围，不能互相替代。仓库整体许可与客户端、第三方组件的许可分别适用，见 [RIGHTS](RIGHTS.md)。
