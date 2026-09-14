<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/55/557584e585b0d881c8f9fdada1d748e94726544472cead9cf5a934a8a1dace76.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 项目／模块发现 v1

2026-09-11。G0 项目介绍与 A1/A2 的首版服务实现，使用现有 Profile、Consent、偏好、HTTP 和 Personal MCP。Schema41 不变，无新表、依赖、外部模型或工作区扫描。后续已接通[原生机会卡片、项目编辑和意愿界面](project-discovery-native-v1.md)，当前仅在开发环境验证；未发布 Official 业务接口，也未接入聊天室。

## 资料与发现范围

在 `selfDeclared.projects` 中明确填写项目／模块，每项包含 `id`（UUID）、`kind`（project/module）、`title`、`summary`、`functions`（功能标签），可选 `technologies`、`sourceUrl`（无用户名密码的 HTTPS 地址）、`discoverable`（默认 false）。最多 10 项，每组标签最多 16 项；整个签名 Profile 正文仍须满足现有 12000 字符上限。发布沿用 `/v1/profiles/statements`、`profile.publish` 精确签名 Consent 和完整替换版本；不是局部追加，请保留要继续发布的其他自述字段。

只有候选项目明确 `discoverable:true`、主体启用发现，且当前 Profile 对查询者可见时，才可成为机会。可见性复用 Public/public-profile 或 Private 的准确接收者授权。查询者可以用自己仅本人可见的项目主动查询，不会因此公开该项目。`discoverable:false` 只排除推荐；已由 Public Consent 发布的项目仍在公开 Profile 中可见，不能把它当作隐藏资料开关。

每次读取重新检查最新 Profile 的 Consent 与绑定。私有替换、撤销、过期不回退到旧公开版本。项目和功能都是自述，始终返回 `classification:self-declared`、`capabilityVerified:false`。来源地址只作为引用返回，服务器不会下载内容或扫描仓库。

## 接口与使用顺序

| POST 路径 | Scope | 输入／结果 |
|---|---|---|
| `/v1/profiles/statements` | history（创建 Consent 另需 consent） | `{consentId,payloadJson}`，发布含项目的完整自述 |
| `/v1/discovery/preferences/read` | notifications | `{}`，返回 preferences、revision、effective |
| `/v1/discovery/preferences/save` | notifications | `{expectedRevision,preferences}`，替换发现偏好并保留其他通知设置 |
| `/v1/discovery/query` | history | `{projectId,limit?}`，返回 items、enabled、method、computedAt、windowLimited、resultLimited |

先用既有本机签名流程发布明确选取的项目介绍，再读取偏好并按当前 revision 开启发现，最后选取自己的项目 ID 查询。双方都明确开启、功能及交流目的匹配时才产生卡片；普通交流本身就是完整目的，不要求复用、报酬或任务。

偏好例子（示例 `until` 必须由调用方换成期望的未来 Unix 秒）：

```json
{
  "expectedRevision": 0,
  "preferences": {
    "enabled": true,
    "purposes": ["conversation"],
    "functions": [],
    "temporary": null
  }
}
```

长期 `purposes` 支持 conversation、reuse、collaboration、recruitment；默认 conversation。`functions:[]` 表示不额外限制关注方向。短期配置为 `{until,contact:"welcome"|"paused",purposes?,functions?}`，显式给出截止时间，可随时替换或清为 null。在截止前覆盖长期目的和功能关注；到期自动使用长期设置，无需后台作业。暂停或关闭后下一次查询生效；临时 welcome 不会绕过长期 `enabled:false`。双方目的必须有交集，非空关注标签须与共同功能有交集。该设置尚未连接未来的机会推送或聊天室通知。

revision 复用通知偏好的主体版本；同时修改会返回 `notification_preferences_conflict`，调用方重新读取后编辑，不自动覆盖。旧通知客户端省略 discovery 时服务保留现有值。普通通知总开关与发现启用是不同意愿，关闭通知不会擅自取消已选择的主动发现。

## 机会卡片与匹配边界

每张卡片返回项目介绍、主体 ID、显示名、双方资料来源 `statementId/projectId/sourceUrl`，以及 `match.sharedFunctions`、共同目的和双方独有的功能／技术标签。卡片 ID 由双方项目与当前声明 ID 生成；它不是邀请、房间访问权或长期授权。

首版 `functional-tags-v1` 使用 NFKC、空白及大小写归一化后的功能标签交集；score 是交并比，用于确定排序，不是能力分数或概率。技术标签、标题、摘要均不计分；同技术栈不会单独产生匹配。没有同义词推断、中文语义模型、互补匹配或 AI 推荐效果证明。用一致的功能词汇准备首批样本；需要语义召回时按 C11-08 的评测前提扩展既有搜索体系。

当前按最新声明时间扫描最多 200 个其他主体，每次默认返回 8 张、最多 20 张。`windowLimited` 表示候选窗口未覆盖全部资料；`resultLimited` 表示已匹配可见结果超出 limit。没有全局总数或后续分页，不能把空结果说成全网没有相关项目。两者是首版实现限制，不是用户确认的业务人数或邀请期限。

## MCP 与 AI Agent 接入

Personal MCP 增加 `galaxy_profile_submit`、`galaxy_discovery_query`、`galaxy_discovery_preferences`、`galaxy_discovery_preferences_save`。查询／发布使用 history，偏好使用 notifications；传输继续使用现有 OAuth 资源令牌与 binding scope。`galaxy_profile_submit` 只接收已准确签名并创建 Consent 的正文，不代签。

部署时先读取实际隔离环境配置和版本，通过现有 `createServices`、HTTP／MCP 工厂接入；目标应支持 Schema41。现有 Caddy 路由生成器已包括三个新路径，但生成规则不表示公网已经启用。不要将 `agigalaxy.org` 静态官网作为业务 API base URL。以前公开的原生候选是不可变旧发行，不包含本次功能；含新增字段的资料需使用当前兼容 schema 的客户端。服务回退到不识别 projects/discovery 的旧源码会解析失败，不能直接视为兼容回退。

本人导出沿用 profile-statements 和 notification-preferences，删除执行器沿用原所属数据表，无新副本或独立检索库。原生 `/galaxy` 顶层菜单与初始化没有修改。可见卡片入口现已接通，下一步是基础聊天身份和房间接线与 B1 接触流程；本版不建房、不邀请、不发送消息。

针对性验证：`node --test packages/galaxy-official/test/discovery.test.mjs packages/galaxy-official/test/personal-mcp.test.mjs`；真实 PG 可指定 `GALAXY_TEST_PG_CASE=discovery` 运行既有隔离测试脚本。自动样本与真实参与者试用分开记录。
