<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../01-intake/traceability/snapshots/b4/b4f7f2e10aa6582c16e903382514729c760e287bd838f3aaaecf186b6bd88dbd.md)保留旧文字与定位。
> CUR-35已恢复计划内开发与部署，后台备份仍暂停。历史验证不代表当前完整动态业务上线；保留政策正按对象实施，实际Worker与删除/导出范围见当前记录。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# Galaxy Founding Beta

当前CUR-35已部署官方后端r14/schema73及网页r16，包括身份资料包、Hub/直接互联、Worker Pack实际使用、信息关注、任务/房间治理和共享原生客户端修订6下载；银河账号提供方已接入，注册仍关闭。用户模型与Skill/MCP仍承担判断和推理，完整客户端、真实账号和协作体验未全部验收。具体源码、部署与剩余条件见[当前后端实施记录](../../../07-logs/development/public-deployment-v2-r14.md)及[网页 r16 发布证据](../../GALAXY_WEB_20260913-product-v2-r16.json)。以下早期本地切片说明及旧发行兼容语义按各自版本保留，不能覆盖当前执行状态。

> **保留的2026-09-09切片说明（非当前运行状态）：** 本仓仍是本地Founding Beta；正式静态官网在独立目录 `../../official-site/` 发布，不能把本仓浏览器预览称为云业务。参见[当前状态](../../../99-index/PROJECT_STATUS.md)、[基础云计划](../../GALAXY_OFFICIAL_BASIC_CLOUD_DEVELOPMENT_CHECKLIST_v0.1.md)及[原文证据](../../GALAXY_OFFICIAL_BASIC_CLOUD_SOURCE_EVIDENCE_v0.1.md)。

Galaxy 的第一个可运行开发切片：让 AI Coding 中的真实困难从一个本地 **Galaxy ID** 开始，经过 Case Draft、Disclosure Preview、Consent Grant 和 Local Proof Draft，形成一条默认不出设备的事实链入口。

> **早期切片历史说明：** 当时为本地开发原型，尚未部署或公开分发；当前发行状态见上方CUR-35记录。

> **后续产品方向：** 2026-09-06 已实现 L3 默认能力包、本地 Connection Profile／Scope 数据契约、只读 MCP 查询及项目级 `/galaxy` 独立连接页。仅最终确认后保存本地 L3 初始化记录，不连接任何 Official 或 Hub 服务。完整规范见 [能力优先初始化与默认接入设计 v0.2](../../GALAXY_CAPABILITY_FIRST_INITIALIZATION_AND_CONNECTION_DESIGN_v0.2.md)，当前增量见 [本地连接契约](docs/connection-contract-v0.2.md)。

新创建的 Galaxy ID 使用严格 32 字符的 **GUID-32 v1**：`GUID<V><O><T×10><C×16>`。它只包含格式版本、不可变出生来源、创建时间和不透明 Genesis Commitment；并不编码主体类型、账户、Hub、能力、绑定或信任结论。现有旧 ID 保持原值。详见 [GUID-32 规范](../../GALAXY_GUID_32_IDENTITY_FORMAT_v1.0.md)。

## 用户入口：Galaxy Integration Pack

用户不应手动安装或操作一个 npm CLI。产品入口是 **Galaxy Integration Pack**：一个同时提供 MCP 和 Skill 的本地集成包，由兼容的 AI 主机负责启动，并按以下顺序引导设置：

既有OpenCode适配切片的首次入口按语言、能力愿景、Personal形态、默认L3、接入可见性、身份和精确确认呈现；控制台选项6为独立只读接入页。旧配置档与模块API继续用于兼容和开发，普通用户不需要逐项勾选内部模块。最终确认前不写入，已有配置不因查询升级。

当前源码集成包位于 [`integrations/codex/plugins/galaxy-integration-pack/`](integrations/codex/plugins/galaxy-integration-pack/)。它是开发验证用的源包，尚不是可面向公众分发的独立二进制或插件市场版本。

首次 `/Galaxy` 会选择产品级初始化形态，而非让普通用户选择技术模块：**Personal Galaxy**（当前可用）、**Galaxy Worker**（未来 7×24 Agent Runtime）或 **Galaxy Hub**（未来组织/社区本地星系）。设置完成后，`/Galaxy` 进入已有服务；只有 `/Galaxy setup` 才进入配置变更预览和再次确认。Worker 和 Hub 当前仅是不可初始化的架构路径。详见 [初始化形态与命令面](../../GALAXY_INITIALIZATION_AND_COMMAND_SURFACE_v0.1.md)。

### 兼容配置档与内部模块（不是当前默认首次UI）

| 配置档 | 启用内容 |
|---|---|
| `minimal` | Galaxy ID |
| `coding-case` | Galaxy ID、Coding Case 工作区、披露与授权控制 |
| `agent-workspace` | 所有当前可用模块：再加 MCP 工作区和 AI 引导设置 |

`openclaw-adapter`、`github-ci-verification` 和 `remote-sync` 只在目录中标为未来计划，当前不能初始化，更不能被宣传为已实现。

## 源码中已有的本地切片（完整新体验尚未验收）

- 本地 A2A 适配：官方 SDK 1.1.0 / JSONRPC 1.0 消息、查询、取消、Case/Attempt 关联；可选宿主组合及原生任务菜单、实际本机签名结果导入与回执恢复；[范围与使用](packages/galaxy-a2a/README.md)。未全局安装或部署动态服务；
- 官网式入口与 Galaxy ID Console；浏览器预览数据只写入浏览器本地存储；
- Galaxy Integration Pack：MCP 模块目录、依赖解析、只读预览、明确确认后的本地初始化与模块 Gate；
- 本地 Ed25519 Galaxy ID 和本地状态机；
- 本地 stdio MCP：模块选择、初始化、身份状态、Case Draft、披露预览、Consent Grant、Local Proof Draft 和本地历史；
- AI Skill：禁止把底层运行命令交给用户，要求先预览再确认；
- Secret、`.env`、Token、凭据和未选择源码不进入披露范围；本地导出不包含私钥、原始源文件、环境变量、Token 或浏览器凭据。

## 完整新体验尚未完成的部分

- 新Account登录与银河ID控制衔接、当前控制链、跨设备恢复及个人摘要同步完整流程；已有远程服务端源码和绑定用例不表示上述新体验完成；
- 公开 Proof、Hub、Worker、Bridge、Federation、排行榜或支付；
- 完整第三方Verification网络及新身份恢复链的端到端验收；现有验证接口/适配源码保留，企业交付与运营条件分别后置；
- 插件市场分发与八端完整体验尚未完成；共享运行时独立签名候选现已公开下载，验证范围见当前发行记录。

## MCP 工具边界

优先由已安装的 Integration Pack 调用以下工具，而不是让用户直接运行命令：

- `galaxy_integration_list_modules`
- `galaxy_integration_preview_initialization`
- `galaxy_integration_initialize`（必须携带明确确认值）
- `galaxy_integration_status`
- `galaxy_command`（为 `/Galaxy` 适配器返回首次设置、正常服务、变更或计划中服务路由）
- `galaxy_identity_status`
- `galaxy_identity_describe_guid`（只读解释 GUID-32 的有限格式语义；旧 ID 返回 legacy）
- 已受模块 Gate 约束的 Case、披露、授权与本地历史工具

以上列举的是保留的本地初始化切片边界。仓内另有Official HTTP/MCP、检索、协助、绑定、Proof与Verification等服务及适配源码，不能将所有工具一概称为local-only，也不能据源码声称已部署。逐项当前行为、复用限制与新接口见[实施工作包](../../../02-architecture/redesign-v1/predevelopment/README.md)。

## 开发者验证

以下命令仅用于维护本源码仓库和自动化验证，不是终端用户安装流程：

```bash
npm install
npm test
npm run lint
npm run build
npm run integration:mcp
```

`internal:galaxy-id` 是内部兼容与测试入口；产品文档、Skill 和 UI 不把它作为用户路径。

## 设计依据

- [Founding Beta 构建合同](../../FOUNDING_BETA_BUILD_CONTRACT_v0.1.md)
- [Galaxy Integration Pack 与模块初始化设计](../../GALAXY_INTEGRATION_PACK_AND_MODULE_INITIALIZATION_DESIGN_v0.1.md)
- [Galaxy 数据与能力授权说明](docs/GALAXY_DATA_AND_CAPABILITY_CONSENT_v0.1.md)
- [OpenClaw 接入边界](docs/OPENCLAW_ADAPTER_BOUNDARY.md)
- [Agent-readable product guide](public/agent.md)

## 边界原则

**默认本地；跨边界逐案授权；公开发布逐次确认；训练与商业再利用永不捆绑同意。**
# 2026-09-06 本地连接契约增量

已新增 v0.2 Connection Profile／Scope 数据层及 `galaxy_connection_preview`、`galaxy_connection_status` 只读 MCP 工具。L3 默认初始化与独立只读连接页已接入项目级 Adapter；真实宿主加载与布局尚未验收，端点配置不代表已连接。详见 [本地契约说明](docs/connection-contract-v0.2.md)。

## 需求追溯检查与AI Agent开发入口

先读取仓库AGENTS.md及项目产品基线，按模块定位完整原文、决定与上下游流程。配置发现从package.json、局部开发规则和受控配置样例开始，不读取凭据或.env；本轮不连接真实服务。`npm run check:requirements`执行只读校验，`GALAXY_PROJECT_ROOT`指定匹配资料，`GALAXY_PYTHON`指定Python。缺资料或阅读包过期明确失败，不跳过为绿色。

AI Agent未来部署前应按卷14–16核对具体配置、用户选择的环境和所需权限，先准备可审查候选再执行明确范围。测试、源码候选和历史官网记录不等于当前生产可用；常见错误包括把旧数据/API条数当需求覆盖、将已确认保留期限写成已实施，以及从当前工具能开面板推定所有宿主插件都能嵌入。业务按CUR-35继续实施，备份仍暂停。
