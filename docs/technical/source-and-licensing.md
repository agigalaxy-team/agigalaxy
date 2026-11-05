# 源码、许可与发行材料

主源码 [agigalaxy](https://github.com/agigalaxy-team/agigalaxy) 已公开，源码、介绍与贡献说明直接在本仓库维护。银河自有代码统一采用 **Apache-2.0**，标准原文和归属说明集中在根 [LICENSE](../../LICENSE) 与 [NOTICE](../../NOTICE)。该选择覆盖银河自有的 Go、网页、宿主与专业服务接线代码；第三方与上游派生材料仍遵守原许可，用户资料和商标不因此授权。历史已签名发行保留原字节与准确随版许可。

## 自有与第三方范围

| 范围 | 原文和准确来源 |
|---|---|
| 当前银河自有代码 | 根 `LICENSE`、`NOTICE` 统一声明 Apache-2.0；银河自有 Go 核心、网页、宿主和服务接线适用，外部材料另依原声明 |
| 历史 Native 自有代码、Skill、辅助工具与说明 | `integrations/native-v2/legal/LICENSE`、`NOTICE` 保留原发行 profile 和准确版本范围；不改已签名包 |
| Go 核心与依赖 | `go/go.mod`、`go/go.sum` 固定实际模块版本；Go SDK、HTTP、PostgreSQL、River、SQLite、Prometheus 等第三方模块保留各自许可，不能据实现语言推定统一授权。源码位置、构建及运行见 `go/README.md` 与 `go/deploy/README.md`；银河自有 Go 代码适用根 Apache-2.0，第三方模块原许可与发行随附义务分别保留 |
| Native宿主与界面npm依赖 | 依准确lock和实际安装包提取LICENSE／NOTICE／COPYING及许可元数据；这些资源服务Go核心的宿主适配与界面，不是独立Node业务核心 |
| 参考Worker第三方A2A SDK | `integrations/reference-worker-pack/package.json`及其锁固定`@a2a-js/sdk` 1.1.0；用于独立参考Worker与第三方协议端夹具，保留实际分发依赖的许可。原自定义JS A2A业务包及其自我比较测试不属于当前交付 |
| MCP SDK | package 许可字段与实际混合许可原文分别保留；已发行版本的原文不能用浮动 main 替代 |
| Keycloak | `apps/galaxy-auth/licenses/KEYCLOAK-APACHE-2.0.txt`；主题自有 NOTICE 一并进入主题包 |
| AgentOS/Agno | `services/galaxy-operations-agentos/requirements.lock` 固定依赖；README 对 Agno3.1.7 标 Apache-2.0，分发二进制/镜像仍须携原文 |
| Model Gateway/LiteLLM | `services/galaxy-model-gateway/SOURCE.json` 固定提交、版本与 upstream/uv.lock；MIT 范围排除 enterprise，Dockerfile 明确不安装它，并复制固定上游原文 |
| Discovery/OpenPanel | `services/galaxy-discovery/SOURCE_BUILD.md`、source-inputs 与实际补丁/许可；完整上游为显式输入，不伪作本仓库自有实现 |
| Web 头像 | `packages/galaxy-web/THIRD_PARTY_AVATARS.md` 精确记录生成资产来源 |

`upstream-reference` 仅按所存原文的范围使用，不能证明当前镜像来源。用户资料、私聊、提示词和业务数据不随代码许可开放。

通用插件的开源研究及固定源码入口集中在[Native开发准备](native-client.md#通用插件与共用本机服务)，区分已有SDK、候选依赖、代码借鉴和构建工具。研究项目不自动进入运行依赖或发行声明；实施时只为实际引用/采用的模块更新准确锁与随包原文，不复制一套研究材料或将候选清单伪作已接入组件。

当前Native连接、导出、删除、A2A、原操作持久化与公网请求由Go承担。旧自定义JS A2A业务及Node传输连同仅服务旧实现的互通参照退出当前源码和组件入口；不为旧测试保留另一套客户端业务。第三方协议端夹具仍可直接验证Go与实际SDK的wire交互。

`packages/galaxy-client/src/node`中仍被宿主采用的诊断／日志与`packages/galaxy-official/scripts/governance-review.mjs`的离线治理准备各保留其实际用途。离线工具准备当前Go服务读取的configuration／review／authorities材料，不启动旧Node服务。浏览器共享的验证、展示和请求适配按实际消费者保留；不能据文件扩展名归为已撤业务，也不能从一个包的自我导出推定它仍在当前使用。

## 源码归档

归档读取组件 catalog，纳入应用/服务/包源、Java/FTL/Python/Dockerfile、provider 注册描述、宿主脚本/清单、图片署名、锁、配置示例和许可。当前组件的入口、嵌入 SQL 和声明资源由同一 catalog 交付；源码归档不加载旧 Node 服务或要求先构建二进制。固定上游完整源码与大锁包按组件获取合同准备，公开历史下载按原发行目录另行获取。

实际环境文件、凭据/私钥、依赖树、缓存、构建输出和运行工件不入源码。运维只保留 `configuration.example.json`，具体主机配置在源码外，通过工具的 `--config` 显式指定。成员哈希只证明包成员完整性及隔离解压校验，不证明权属、运行状态或发布授权。

## Native 许可生成与准备（按准确发行 profile）

```sh
node scripts/build-native-v2.mjs <新的绝对候选目录>
# 在候选目录：已有准确锁用 npm ci；首次无锁才按 builder 的准确依赖 npm install。
npm ci --ignore-scripts --no-audit --no-fund
# 回到仓库根目录：
node scripts/native-license-notices.mjs generate <绝对候选目录>
node scripts/native-client-release.mjs <绝对候选目录> <新的绝对准备目录> <本机tar绝对路径>
```

`npm run prepare:client -- <新的绝对输出目录>`统一构建Go Native、按准确锁安装宿主依赖、收集许可并准备包；已有缓存时可显式传`--offline`。`go-native-licenses.mjs` 从实际 Go 依赖图收集原文；npm 许可仍按最终 lock 和安装图核对。Go包布局见[Go运行样例](../../go/deploy/README.md)。历史签名包的验签与许可profile仅描述原发行字节，不是现行源码的安装或开发入口；当前候选签名、上架与平台验收仍按实际结果分别记录。命令只构建无凭据候选和准备包，不签名、安装宿主配置或公开发布。生产签名按既有授权短期注入，生成 NOTICE 不需要读取发行私钥。

`generateNativeLicenseNotices({candidate})` 无网络、按 lock 与实际安装组件新建 `third-party-licenses/` 和 `license-inventory.json`，拒绝覆盖；`verifyNativeLicenseNotices({candidate})` 只读重算。缺文本、版本不符、lock变化、篡改或缺可选平台 lock 成员都阻止准备，不伪造跨平台检查。bundler 外置 npm 依赖，源输入含 node_modules 时拒绝当前许可 profile；esbuild 原文只说明构建工具归属。

`prepareNativeClientRelease` 先验证，再将许可纳入实际 tar 成员、字节校验、package-files 与协议报告 artifacts hash。`createNativeClientRelease` 不修改已准备包；旧签名包保留旧字节，新增许可材料需要新发行。`source-hashes.json` 保留准确选定源，不能单凭其摘要证明法律权属。
