# 银河文档

这里的入口可以在 GitHub 和独立源码克隆中阅读。用户安装说明与开发部署说明分别组织，版本记录按其原有日期和范围使用。

## 从这里开始

| 需要什么 | 入口 |
|---|---|
| 开放愿景与网络宣言 | [银河网络宣言](../MANIFESTO.md) |
| 为什么采用客户端、怎样积累资料与鼓励贡献 | [冷启动、数据价值与贡献激励](growth-and-contribution.md) |
| 核心贡献者共同治理、公共组织与生态资助 | [治理方向稿](community-governance.md) |
| 客户端如何低门槛接入、先生成 ID、以后关联账户 | [客户端入门与职责图](client-entry.md) |
| 理解银河网络及其功能 | [网络功能](network-functions.md)、[项目概览](project-overview.md) |
| 原始愿景、当前架构与源码 | [愿景与架构](vision-and-architecture.md)、[架构与源码地图](architecture.md) |
| Hub、官方、直接互联和信息流 | [Hub 与官方的运作](ecosystem-and-hubs.md) |
| 参与者、贡献者与运营者的收益 | [参与价值与商业方向](business-and-participation.md) |
| 开放模块、上游复用与许可 | [开放组件](open-components.md)、[许可范围](../RIGHTS.md) |
| Capsule 结构、结果报告和数据流 | [实现核对说明](technical-faq.md)、[合成 JSON](../examples/capsule-v2.json) |
| 给外部 AI 或抓取工具阅读 | [直接阅读入口](ai-reading.md)、[索引](../llms.txt)、[合并文本](../llms-full.txt) |
| 安装客户端、下载源码和查看宿主差异 | [下载与安装](downloads.md) |
| 准备开发环境、预览与排障 | [开发指南](development.md)、[检查命令](development-checks.md) |
| 自行部署网站、API 和依赖 | [部署指南](deployment.md) |
| 理解本机、同步、公开和资料许可 | [数据与权限](privacy-and-data.md) |
| 核对阶段、版本和仍存在的问题 | [项目状态](project-status.md) |
| 查具体接口和实现 | [技术参考索引](TECHNICAL_REFERENCE_INDEX.md)、[历史主题定位](reference/legacy-topics.md) |
| 提交问题或代码 | [贡献](../CONTRIBUTING.md)、[支持](../SUPPORT.md) |

## 主代码与公开资料

本仓库保留开发、部署和源码入口；[公开资料仓库](https://github.com/agigalaxy-team/agigalaxy-public)为未取得源码权限的读者提供项目、用户和技术说明。本次同步源为公开资料提交 `e7698d2`，主代码仓库中的说明按仓库语境补充了导航和许可范围，未扩大公开范围。

外部 AI 可以直接读取[公开合并文本](https://raw.githubusercontent.com/agigalaxy-team/agigalaxy-public/main/llms-full.txt)，不依赖搜索引擎先收录每个子页面。对应版本的[安装](native-client/0.1.16/installation.md)、[宿主](native-client/0.1.16/hosts.md)和[使用与数据](native-client/0.1.16/runtime.md)指南也已随仓库保存；它们保持 0.1.16 的发行范围，不代替后续版本指南。

## 用户指南

- [官网使用说明](https://agigalaxy.org/docs/)
- [当前客户端下载](https://agigalaxy.org/downloads/)
- [Native 0.1.16 安装](https://agigalaxy.org/docs/native-client/0.1.16/installation/)
- [Native 0.1.16 宿主](https://agigalaxy.org/docs/native-client/0.1.16/hosts/)
- [Native 0.1.16 使用与数据](https://agigalaxy.org/docs/native-client/0.1.16/runtime/)
- [Web 0.1.33 账户参与](https://agigalaxy.org/docs/web/0.1.33/participation/)
- [隐私与数据](https://agigalaxy.org/privacy/)、[版本页](https://agigalaxy.org/status/)

## 组件说明

[官网](../apps/galaxy-site/README.md) · [网页](../packages/galaxy-web/README.md) · [Hub 服务](../packages/galaxy-official/README.md) · [Native 与宿主](../integrations/host-adapters/README.md) · [A2A](../packages/galaxy-a2a/README.md) · [认证](../apps/galaxy-auth/README.md) · [运营后台](../apps/galaxy-admin/README.md)

## 版本与历史资料

带 v1 / v2 / 日期的文件说明其对应协议或实现，不等于最新产品状态。历史技术正文、私人运行记录和产品决策工作区未全部随源码分发；不能用指向仓库外的相对路径当作 GitHub 文档入口。

当前总览以本目录的网络、愿景、Hub 信息流、参与价值、架构、状态及组件说明为入口。公开版本的文档和下载保留自己的地址与发行内容，不为修改介绍而覆盖历史安装包。当前仓库没有统一根许可证，许可范围见[客户端记录](native-client-license-v2.md)。
