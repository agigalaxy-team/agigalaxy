# Galaxy 宿主适配

本目录把银河 Native、MCP 工具与原 AI 宿主的实际能力连接起来。安装普通客户端请从[安装说明](../../docs/public/getting-started.md)进入，不需要先理解全部适配器。

## 接入与职责

[Native 客户端说明](../../docs/technical/native-client.md)描述身份、连接、工具、工作资料、预览和结果返回。模型由用户的宿主提供，适配器不创建模型账户、不替换模型设置，也不因打开菜单自动扩大权限。

OpenCode stable 的 /galaxy 提供社区、帮助、消息、本地履历、设置和原工作接续。安装后的普通工作采集使用其公开事件接口；其他宿主的配置生成不自动具有相同后台事件能力。

宿主可向 createGalaxyAdapter 或 createConfiguredGalaxyAdapter 提供 nativeTools.call 和可选 readWorkContext，使用当前获准的前台 Native 工具桥。当前身份、设备、连接或许可变化后，旧内容和预览需要失效；取消与返回保留独立输入，不静默重新派发。

## 范围与兼容

[随版宿主指南](https://agigalaxy.org/docs/native-client/0.1.19/hosts/)与生成目录 INSTALL.md 是安装入口。MCP Apps 小面板取决于宿主支持；没有输入返回接口时给出可读内容与来源，不冒称已经写回宿主。

已有 OpenCode 1.18.31 实际 TUI 和隔离配置记录。合同镜像、MCP / HTTP / AppBridge 检查、真实物理宿主与真实模型运行各自说明范围，不能合并成全部宿主验收。

## 开发

根 setup 安装常用开发依赖，检查按受影响模块选择，见[开发指南](../../docs/technical/development.md)和[检查](../../docs/technical/development.md)。当前客户端发行、自己的 AI 与本地数据范围见[状态](../../WORK_STATUS.md)和[数据说明](../../docs/product/data-and-files.md)。

旧独立 adapter 和兼容入口按各自源码使用；不能从目录或生成配置数量推定采用人数、相同界面能力或稳定发行。
