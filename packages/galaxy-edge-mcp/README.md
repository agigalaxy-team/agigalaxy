# Galaxy MCP / Native client

本包提供个人 MCP 与本机 Native 工具表面，组合 Core、本机 Node 客户端、Official 的当前受权读取和领域工具定义。它不另存一套服务端业务规则，也不因宿主展示、复制链接或连接配置而取得新权限。

## 入口与目录

| 位置 | 职责 |
|---|---|
| `src/index.mjs` | 个人 MCP 库导出 |
| `src/native-v2-entry.mjs` | 已有 Native 命令入口 |
| `src/native-v2/runtime.mjs` | 本机运行组合、当前连接与资源生命周期 |
| `src/native-v2/server.mjs`、`stdio.mjs` | MCP SDK 注册与 stdio 启动 |
| `src/native-v2/configuration.mjs`、`store.mjs`、`diagnostics.mjs` | 受控配置、本机存储与闭合诊断 |
| `src/native-v2/work/` | 原工作接续、选定资料再读与本机／云端同步 |
| `src/native-v2/identity/` | 当前账户关联、身份范围展示与 Web 设备交接 |
| `src/native-v2/watch/` | Watch 状态机、宿主配置、调度与交接 |
| `src/native-v2/tools/` | HTTP、通知、公开账户等工具的客户端适配 |
| `src/native-v2/adapters/` | A2A 与参考 Worker Pack 宿主适配 |
| `src/native-v2/interaction/` | 选择、导航、阅读书签与业务结果呈现 |
| `src/native-v2/host-adapters/`、`notifications/` | 既有宿主驱动与平台通知资源，保持原文件位置 |

内部模块直接导入上述实现。已移动的二十七个内部模块不在 `native-v2/` 根部保留转发文件；正式启动入口继续服务现有构建、发行和宿主配置。

## 构建与检查

从仓库根目录运行现有 `scripts/build-native-v2.mjs` 生成正式 Native 制品。它以命令入口、运行组合、MCP 服务和 OpenCode TUI 四个真实入口追踪依赖；不要只复制某个入口文件或把 `src/` 的目录布局当作已安装制品。

`scripts/structure/check-native-layout.mjs` 在内存中编译同一组入口和 Web 的原工作接续消费者，确认已分类模块进入实际依赖图；它不创建发行、不安装宿主、不调用模型。包内行为检查位于 `test/`，宿主集成检查仍在 `integrations/`，仓库级本机工作接续检查仍在根 `test/`。

## AI Agent 部署与维护

自动化安装前应先读取仓库的 Native 构建脚本和 `configuration.mjs` 所声明的配置合同，确认目标宿主、所选服务、本机数据目录及当前身份。凭据只使用用户已选安全引用，不读取无关环境变量或把原始秘密写入工具参数、报告与发行包。

启动组合与业务资格分开核验：能够启动 MCP 并不证明当前账户、设备、来源版本或外部 Agent 已获准执行业务。接续读取通过已有服务再次核对当前身份与准确来源，资料过期、撤回、断网或身份变化时不得用旧正文补齐结果。A2A 身份和认证仍按所选对端配置，Watch 不把未完成工作自动标记为已处理。

变更目录时同步直接导入、当前验证工具的源码清单和四入口构建图，保留平台资源的文件 URL。历史发行快照和宿主已经安装的文件按各自发行管理，不随源码目录整理搬移。
