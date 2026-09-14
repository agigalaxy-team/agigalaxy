<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/1c/1c43723f5d61b1a33236f8950f78d4851664d206be0ee99b4fae56d13ca6bd53.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 官网、公共文档与发行准备 v1

2026-09-11，本地开发交付。官网候选2026.09.11-1 / public-docs v0.2；动态服务未部署，本候选尚未替换9月9日静态网站。项目仍使用既有Oracle静态站架构，未创建新的托管站点或改变域名。

## 已准备的交付

|交付|内容|使用范围|
|---|---|---|
|[开发API目录](development-api-reference-v1.md)|92个业务路由、12个发现/协议/内部条目，实际分发与代理匹配|内部开发参考；publicApiEndpoints为空，无生产base URL|
|[API行为](api-behavior-v0.1.md)|当前错误声明、授权类型、分页、重试与大小限制|不把静态错误扫描当作全部运行路径证明|
|官网候选|状态、网络说明、发行前提、Agent索引、变更记录与8份分版本文档，共25文件|仅编写的公共静态内容；无动态API或下载按钮|
|Docs MCP|保持v0.1四主题原内容，新增v0.2四主题；同一模板、两个工具、两个解释prompt|新旧URI同时可读；prompt使用v0.2；独立SDK客户端已验证|
|客户端候选记录|现有@galaxy/client包及对应安装记录重新核对；63源码、21导出、4依赖|未重新安装或签发；未公开发布|

代理配置补齐5个已实现POST路径：bindings/query、assistance/events/receipt、requester-history/facts、context-grants/receipt、notifications/archive。原有方法与Host限制保留，内部探针继续只供内部使用。实际Caddy验证通过；没有对线上Caddy执行更改。

## 当前候选路径与摘要

在代码仓根下：

- [官网候选清单](../outputs/public-release-20260911-1/website-candidate.json)：每个公开文件SHA-256、候选zip摘要及本地链接检查结果。
- [官网候选包](../outputs/public-release-20260911-1/galaxy-website-2026.09.11-1.zip)：25项明确白名单文件，可供原有静态站发布流程使用。
- [客户端候选记录](../outputs/public-release-20260911-1/client-candidate.json)：当前包元数据、源码匹配与已有安装证据范围。
- [客户端包](../outputs/client-complete-1789060247274/galaxy-client-0.1.0.tgz)：63128字节，SHA-256 `2c7bda69ad79432e7479da58bd7c2cd90e097066cf81abee3f89e9896b232486`。

此tarball不是完整宿主安装器，不含私钥、宿主本机运行时或Official服务器。依赖为canonicalize 4.0.0、ipaddr.js 2.5.0、jose 6.2.12、zod 4.5.4；源码与导出以实际package.json/source-hashes.json为准。服务数据库仍Schema41，文档更新没有迁移。

## 重建与AI Agent操作

使用当前代码仓根目录，Python 3.11+和现有Node/锁定依赖：

```powershell
python ../../official-site/build.py
python packages/galaxy-official/scripts/build_public_docs.py
node scripts/build-api-reference.mjs
python scripts/prepare-public-release.py --client-artifact outputs/client-complete-1789060247274/galaxy-client-0.1.0.tgz --output <新的绝对候选目录>
```

最后一个参数必须替换为新的实际绝对目录。此命令只核对本地包、当前源码、静态白名单、文档保留和站内链接，并生成候选；不会执行归档内代码、使用凭据、上传、签发或安装。源文件变化使旧客户端不再匹配时，先按[客户端构建](client-release-v1.md)生成当前包；不能修改旧verification.json来让检查通过。

网站源是`05-build/official-site/build.py`，浏览器演示仓app/page.tsx不是官网。公共文档只从两个显式字典提取；不得把内部API目录、项目历史或整个代码仓拷贝进静态站。新旧Docs MCP客户端都必须选择明确文档版本；v0.1内容保持历史语义。

## 发布与回退仍需完成的部分

C03-01/08的本地交付可复核；线上静态更新与动态服务发布分别执行原计划。生产访问、域名和旧服务状态以发布时实测为准，旧deployment-state/verification文件是历史证据，不能覆盖成本次已部署。

C03-02仍进行中：正式发行需要实际publisher/可信签名键、匹配的Conformance发行证据、支持宿主矩阵与真实下载渠道，复用已有client-release/signRelease/verifyRelease流程，不另造发行协议。用户或指定评审完成真实宿主体验；其他可自动完成的构建与发行接线继续推进。

官网切换使用保留前版的原子发布；旧静态候选已保存在official-site/releases，历史公共文档仍留在v0.1路径。Docs MCP回退可回退到仅v0.1的服务版本，但新v0.2 URI将不可用，需同步文档与调用方；不改变数据库。客户端升级先在新目录核验，保留当前ID和本地数据；回退包不能自动降级数据库或恢复已撤销权限。

本次验证为7项HTTP/版本/Docs MCP相关测试、3项实际Caddy检查及lint通过；25项静态文件白名单、164个站内引用和4份旧文档原字节均已核对。没有执行浏览器视觉或真实服务器验收。
