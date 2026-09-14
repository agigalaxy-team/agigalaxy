# Capsule 网页与精确操作恢复

本切片属于 `NEW-M05-FLOW`。业务来源和采用层级见项目 `02-architecture/redesign-v1/packets/M05.md`、`predevelopment/work-packages/M05.md`、卷06；修改前说明及完成记录见 `07-logs/development/capsule-web-v2.md`。延续 B-06-Q03 和 A-Q-09：用户端模型整理和解释，正式内容有实际结果来源，已有许可可以复用，普通阅读不能计作应用或资格。

## 已实现行为

`CapsuleWorkspace` 接受 `{runtime,subjectId,connected,navigate,capsuleId?,versionId?}`。主应用接入 `/app/capsules`、`/app/capsules/:id`、`/app/capsules/:id/versions/:versionId`。准确版本路径可供原生客户端打开；回到原聊天后仍由用户模型解释并执行。

页面包括公开查询、当前可读版本、来源/限制/工具/Skill/MCP、作者归属与许可、参考及实际应用记录。匿名访问不产生使用记录。私有新版存在时，默认最新版读取不会偷偷回退；用户仍可明确选择获准旧版。来源失效后正文隐藏，作者仍可维护停用状态。

发布者从本人有参与事实的工作历史中选择当前成功报告结果，逐项整理策略、环境、验证范围和限制。可以选择自己的或已获准的具体事实和消息来源、贡献署名、现有许可及外部参考链接。普通房间不变成任务，不自动收集整段聊天。消息选择只存精确引用；公开仍需来源作者的具体许可。共享摘要不是普通原创消息，当前消息选择器明确排除，不能绕过其派生来源规则。

草稿仅显式保存在本设备，按 endpoint 与 subjectId 分开，发布或维护其他版本不会自动清空已有草稿；删除草稿需明确操作。来源条件预览不持久化草稿。最终确认产生精确签名发布；新版本不覆盖旧版本，维护可以标记停用、安全事项及处理，替代版由用户明确选择。

应用流程从本人已有实际工作中选择 Case、Attempt 与其精确 Result。结果和环境直接来自当前获准事实，界面不能把失败改成成功。再验证选择先前应用及针对同一结果版本的当前 M06 检查。仅阅读、加入参考、实际应用和再次验证分别表达。合成演示和真实工作分开，检查数量不证明独立因果关系或能力资格。

来源许可页支持本人事实/消息多选、真实已知参与者选择、补充已有联系人、许可范围、署名、已有许可文件依据、公开允许范围、可选截止及撤销。读取房间不代替发布许可，来源文件指针不冒充已验证法律权利。外部链接仅作为引用，不自动导入正文。

## 三个追加只读接口

全部沿用 `capsules` scope，原写接口和数据库迁移未改变。

| POST 路径 | 输入 | 权限及返回语义 |
|---|---|---|
| `/v2/capsules/receipt` | `type: publication/use/permission, operationId, payloadHash` | 仅本人；`absent/acknowledged/conflict`。hash 匹配确认原操作曾经接受，不证明正文仍可读；明确 `currentReadPermissionConfirmed:false`。 |
| `/v2/capsules/versions` | `capsuleId, after?, limit?` | 可匿名，逐版本走当前来源和 Consent。只给当前可读版本的分页游标；本人可取管理修订号和已发版本数。 |
| `/v2/capsules/permissions/query` | `view: owned/granted, after?, limit?` | 登录；本人或明确列为 grantee 且有查看授权，当前撤销/到期/来源状态分开。 |

MCP 追加 `galaxy_capsule_v2_receipt`、`galaxy_capsule_v2_versions`、`galaxy_capsule_v2_permissions`，均为只读。既有八个工具仍保留。

回执只查询本人 ID 和原始载荷摘要，没有原文响应，不绕过当前来源读取；物理清除后查不到回执也不能证明旧在途请求已取消。停止本机重试会清本机正文与签名，保留最小 ID/hash 对账，原请求晚到可再查询。重试沿用原业务 ID、内容及已接受的 Consent。新的浏览器连接不会导致已接受授权重新签署。

## 实际验证与边界

1. `test/capsule-web-v2.test.mjs`：真实 createBrowserClient、HTTP 路由、身份控制签名、Consent、许可及应用流程，1/1；本地存储为显式内存替身，不宣称真实 IndexedDB 已验收。
2. `test/postgres/capsule-web-v2.test.mjs`：隔离 PostgreSQL 与真实受限 API 角色，最后一次 1/1，3823ms；临时集群清理 `removed:true`。增加精确 M06 再验证、来源许可撤回后仍可维护版本的同一工作流断言；没有重跑无关全量套件。
3. 覆盖缺 Consent ACK、重连复用原授权、缺发布 ACK、停止本机重试后原请求晚到、别人回执不可读、私有最新版不回退、真实失败应用不计成功、再验证不冒充独立因果证明、来源撤回隐藏依赖正文。API 角色禁止任意修改原 Capsule 正文。
4. Capsule 组件及其本地依赖 TypeScript 检查通过。构建、真实浏览器、真实消息服务和部署由主代理统一执行，本文不以 API 测试代替这些状态。

配置来源差额已在 schema63 后续切片补齐：[配置版本与来源权限](configuration-v2.md)。创作和来源许可区可选精确配置元数据；仅作为 Attempt 比较条件与明确复用正文分开。共享摘要独立来源发布适配仍未纳入普通消息选择；原授权已失效而未获接受时保留原操作并提示处理，不自动扩大披露。历史 v1 来源规则有标识，不反向伪造新签名。没有真实参与者、原生宿主和真实复用数据时，不宣称试点或资格业务完成。

## AI Agent 部署说明

此切片不新增数据库表或迁移；需同时发布 Capsule 服务的只读扩展和调用它们的网页。复用当前浏览器配置发现、既有身份/Consent 服务以及当前 API role，不读取凭据或更改既有部署资源。部署前检查精确路由、公开/私有版本行为及静态路径回退；没有新接口时不得用本地假数据让页面显得成功。后台备份保持暂停，发布必须以主代理捕获的不可变包为准。
