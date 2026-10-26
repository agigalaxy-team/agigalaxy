# 源码、许可与发行材料

归档和目录整理不改变仓库公开性、账号权限或许可。根仓库未提供覆盖整仓的 LICENSE；Native 发行的 Apache-2.0 不外推到 Hub、Admin、全部服务、用户数据或运营资料。整仓开源/拆仓须明确对应范围。

## 自有与第三方范围

| 范围 | 原文和准确来源 |
|---|---|
| 选定 Native 自有代码、Skill、辅助工具与说明 | `integrations/native-v2/legal/LICENSE`、`NOTICE` 限定 Apache-2.0 范围，商标及第三方另列 |
| Native 外置 npm 依赖 | 依准确 lock 和实际安装包提取 LICENSE/NOTICE/COPYING 与 package/lock 许可元数据，不把全部改写为 Apache |
| MCP SDK | package 许可字段与实际混合许可原文分别保留；已发行版本的原文不能用浮动 main 替代 |
| Keycloak | `apps/galaxy-auth/licenses/KEYCLOAK-APACHE-2.0.txt`；主题自有 NOTICE 一并进入主题包 |
| AgentOS/Agno | `services/galaxy-operations-agentos/requirements.lock` 固定依赖；README 对 Agno3.1.7 标 Apache-2.0，分发二进制/镜像仍须携原文 |
| Model Gateway/LiteLLM | `services/galaxy-model-gateway/SOURCE.json` 固定提交、版本与 upstream/uv.lock；MIT 范围排除 enterprise，Dockerfile 明确不安装它，并复制固定上游原文 |
| Discovery/OpenPanel | `services/galaxy-discovery/SOURCE_BUILD.md`、source-inputs 与实际补丁/许可；完整上游为显式输入，不伪作本仓库自有实现 |
| Web 头像 | `packages/galaxy-web/THIRD_PARTY_AVATARS.md` 精确记录生成资产来源 |

`upstream-reference` 仅按所存原文的范围使用，不能证明当前镜像来源。用户资料、私聊、提示词和业务数据不随代码许可开放。

## 源码归档

归档读取组件 catalog，纳入应用/服务/包源、Java/FTL/Python/Dockerfile、provider 注册描述、宿主脚本/清单、图片署名、锁、配置示例和许可。显式 service/source resource 清单缺失时失败。固定上游完整源码与大锁包按组件获取合同准备，公开历史下载按原发行目录另行获取。

实际环境文件、凭据/私钥、依赖树、缓存、构建输出和运行工件不入源码。运维只保留 `configuration.example.json`，具体主机配置在源码外，通过工具的 `--config` 显式指定。成员哈希只证明包成员完整性及隔离解压校验，不证明权属、运行状态或发布授权。

## Native 许可生成与准备

```sh
node scripts/build-native-v2.mjs <新的绝对候选目录>
# 在候选目录：已有准确锁用 npm ci；首次无锁才按 builder 的准确依赖 npm install。
npm ci --ignore-scripts --no-audit --no-fund
# 回到仓库根目录：
node scripts/native-license-notices.mjs generate <绝对候选目录>
node scripts/native-client-release.mjs <绝对候选目录> <新的绝对准备目录> <本机tar绝对路径>
```

命令只构建无凭据候选和准备包，不签名、安装宿主配置或公开发布。生产签名按既有授权短期注入，生成 NOTICE 不需要读取发行私钥。

`generateNativeLicenseNotices({candidate})` 无网络、按 lock 与实际安装组件新建 `third-party-licenses/` 和 `license-inventory.json`，拒绝覆盖；`verifyNativeLicenseNotices({candidate})` 只读重算。缺文本、版本不符、lock变化、篡改或缺可选平台 lock 成员都阻止准备，不伪造跨平台检查。bundler 外置 npm 依赖，源输入含 node_modules 时拒绝当前许可 profile；esbuild 原文只说明构建工具归属。

`prepareNativeClientRelease` 先验证，再将许可纳入实际 tar 成员、字节校验、package-files 与协议报告 artifacts hash。`createNativeClientRelease` 不修改已准备包；旧签名包保留旧字节，新增许可材料需要新发行。`source-hashes.json` 保留准确选定源，不能单凭其摘要证明法律权属。
