# 许可与源码范围

本次组件目录和归档不改变仓库公开性或许可。仓库根未发现覆盖整仓的 LICENSE；不能把原生客户端 Apache-2.0 的发行授权外推为 Hub、Admin、全部服务或用户材料的许可。正式整仓开源/拆仓前由维护者明确对应范围，当前只形成可审阅本地源码。

既有原生客户端范围和 Apache 原文在 `integrations/native-v2/legal/LICENSE`、`NOTICE`，详细规则见 `native-client-license-v2.md`。第三方维持原文和范围，不归并成银河自有代码。Keycloak 原许可保留在 `apps/galaxy-auth/licenses/KEYCLOAK-APACHE-2.0.txt`，主题自身 NOTICE 同时进入主题包。

AgentOS 依赖按 requirements.lock 固定，Agno 3.1.7 的 README 标明 Apache-2.0；实际二进制/镜像发布仍需携带对应分发原文与依赖材料。Model Gateway 的 `SOURCE.json` 固定 LiteLLM 上游；其 MIT 范围排除 enterprise，本目录 Dockerfile明确不安装 enterprise，并复制固定 upstream 的原许可和锁文件。`upstream-reference` 中保留的原文仅按其实际范围使用，不能用旧来源标记证明当前运行镜像。

源码归档读取组件 catalog，把 apps/services 与包源、Java/FTL/Python/Dockerfile、锁文件、配置示例和 LICENSE/NOTICE/COPYING 纳入，排除实际环境文件、密钥、依赖树、输出、缓存和运行工件。它也按既有 service/source resource 清单检查必要资源；缺失直接失败。固定上游完整源码/大锁包按各组件获取合同准备，不把外部依赖树当作本仓库自有源码。

归档是来源检查点；包内哈希只用于成员完整性和隔离解压校验，不证明法律权属、运行状态或发布授权。用户资料、私聊、模型提示词和业务数据不随代码许可或归档对外开放。
