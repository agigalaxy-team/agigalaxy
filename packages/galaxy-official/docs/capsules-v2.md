# Capsule v2：选定来源许可与真实复用事实

本切片依据完整产品方案 v1 的 M05 工作包、卷06及原文阅读包；实施前说明位于项目 `07-logs/development/capsule-v2.md`。这是已实现的数据服务切片，不能据此宣称完整宿主体验、正式试点、公开部署或能力资格模块已完成。

## 当前业务含义

首批 `publicationClass: formal-source-success` 固定引用真实 Case 的成功 **reported Result 精确版本**。它并不等于独立验证、请求者接受、问题已解决或专家资格。诊断和失败教训可以继续作为协助、经验事实及用户端草稿；本接口没有把它们伪装成正式成功 Capsule。实际采用 Capsule 后失败、部分完成、无法判断、结果冲突都允许如实记录。

读取不写任何使用事实。`reference` 只是显式引用；`apply` 必须有新的 Case、实际 Attempt、以该 Attempt 为来源的 Result、环境差异及具体采用部分；`reverify` 关联此前 apply 和 M06 对同一精确 Result 的验证报告。多份验证不会被计成多个新 Case。所有返回都明确 `capabilityVerified: false`，独立复用因果不由报告自动成立。

测试来源必须保留 `synthetic: true`。合成 Capsule 或合成目标结果不会进入真实 Case 成功计数。计数区分记录次数、合成应用、当前可见的非合成独立目标 Case、报告成功及混合结果；不从未知关系推断不同操作者独立性。

## 来源和许可

来源可以是精确 Case 根、Attempt、Intervention、Result、Evidence、Verification 或明确选定消息。服务使用 M03/M06/M12 的当前读取规则，递归检查真正依赖的记录和作者。Case 背景作者与结果作者分别承担自己的材料许可；最终解决者不自动取得其他人的贡献。

发布者的精确发布 Consent 覆盖自己的选定内容。他方作者使用 `capsule.permission` 签署一份可覆盖多条明确来源的许可，列出接收发布者、许可名、范围、署名、是否允许公开及可选到期时间。已覆盖许可可跨版本复用；未覆盖来源不能通过填写 contributors 数组补齐。房间阅读权只允许当前阅读，不授予公开或共同署名。

`authored-content` 与 `documented-covering-license` 分别记录作者声明和已有许可依据；后者需要许可引用。系统校验注册来源作者、精确版本及当前授权，不声称替用户完成法律权属认定。外部链接仅作为 `reference-only; no-imported-body` 引用；未知外部文件权限不能被消息作者或结果报告者自动授予。当前配置版本材料还没有独立权利适配器，作为发布内容依赖时明确返回 `capsule_configuration_rights_unavailable`。

许可与共同署名分开。`attributionRefs` 表示发布者基于真实来源进行的贡献归因；需要查看 Intervention 的本人回应时，仍到原记录按其当前权限读取。Capsule 不复制私有回应正文，也不声称每位贡献者批准共同著作。

## 版本、撤销和删除

每个公开版本保留固定 event ID 和来源版本。新版私有时，不用旧公开版冒充当前最新版；明确指定旧版本仍可在其当前授权有效时读取。来源 Result 后续纠正，旧 Capsule 标为 `source-result-superseded` 并停止新应用，历史引用不偷偷改指新 Result。应用 Result 纠正则原使用记录保留原版本，标为 `application-result-superseded`。

来源 Consent、许可撤销、许可到期、证据撤销及源记录不可读会实时影响查询。不可用的派生正文返回 `version: null` 或 `record: null` 与受限状态。维护事件的解释文字可撤回，但已发生的弃用或问题状态不会因此逆转。弃用或待处理问题阻止新的实际应用，既有失败和使用事实仍保留。

M19 可以删除本人许可和本人使用事实。被其他作者引用的 Case/Capsule 记录如果因外键保留，只保留无正文占位：`payload_text=''`。读取器不会解析空串、补回旧副本或把占位当完整来源。独立其他作者使用记录可以保留，但只显示来源不可用状态。当前测试中的直接清空只证明读取器遵守这个约定，不能冒充实际删除 worker 运行证据。

## 接口与持久化

保留 v1 业务 API 和合法数据。v2 发布版本继续写 `capsules` / `capsule_events`，payload 明确 `schemaVersion: 2`。旧接口遇到 v2 版本明确 `unsupported_semantics`，防止旧规则忽略新权限。历史 v1 通过 v2 读取时标 `legacy-v1-source-policy`，不伪造追溯签名。

迁移49追加 `capsule_permissions` 与 `capsule_uses_v2`；旧迁移和历史 payload 字节不改。精确 Attempt/Result 版本、此前 apply、授权、哈希及验证集合指纹分别保存。验证和选定消息的精确引用由当前源服务校验，JSON 引用不通过数据库外键强迫保留被删材料。

| POST 路径 | 实际服务 | 调用含义 |
|---|---|---|
| `/v2/capsules/events` | `publishV2` | 精确已签 `consentId + payloadJson`，创建版本或维护事件 |
| `/v2/capsules/uses` | `recordUseV2` | 精确引用、应用或验证记录 |
| `/v2/capsules/permissions` | `permissionV2` | 作者授予或撤销选定来源许可 |
| `/v2/capsules/permissions/read` | `permissionReadV2` | 当前有权访问的许可及撤销状态 |
| `/v2/capsules/preview` | `previewV2` | 校验用户端草稿，不存草稿，不发布 |
| `/v2/capsules/read` | `getV2` | 当前有效版本或明确历史版本 |
| `/v2/capsules/query` | `queryV2` | 逐候选校验当前权限后再分页 |
| `/v2/capsules/uses/query` | `usesV2` | 当前获准的精确复用记录与有限计数 |

写入、许可读取和预览使用当前 `capsules` 身份授权；公开读取可匿名，错误凭据不能降级为匿名。MCP 的八个 `galaxy_capsule_v2_*` 工具调用同一真实服务，客户端提交已经确认和签署的字节，服务端不替用户签名或做模型判断。首个正式版本 payload 的可执行样例见 `test/capsules-v2-workflow.mjs` 的 `version()`。

同事务消费接口为 `capsules.readV2Within(db,actor,input)`、`usesV2Within` 和 `capsules.v2.historyWithin(db,actor,caseId)`。M07 履历使用最后一项实时读取当前可见使用；引用不会产生 `capsule-applicant` 角色。M08 旧 qualification 仍需要后续有界规则接入；不能将接口存在写成已经颁发资格。旧搜索索引暂排除 schemaVersion2，v2 实时查询负责新版权限；后续专用索引需保持相同撤销语义。

## 验证与部署边界

`test/capsules-v2.test.mjs` 使用实际身份绑定、Ed25519 Consent、Task/Participation、Case、M06、M07 和 HTTP，场景数据明确合成。覆盖真正失败的 apply、证据撤回、多方源许可及重复利用已有许可、来源删除占位、私有新版、精确历史纠正及维护阻止新应用。`test/capsules.test.mjs` 保留完整 v1 59次 HTTP 交互兼容流程。

`test/postgres/capsules-v2.test.mjs` 必须由隔离 PostgreSQL runner 执行：迁移与角色安装用管理连接，实际业务测试用 `galaxy_api`。测试文件存在本身不表示真实 PG 已通过。真实选定消息依赖 M12 与 Prosody 的实际环境验收；运行时插件与宿主界面、真实非合成复用、公共运营和部署状态由各自阶段提供证据。

AI Agent 部署时先发现当前数据库迁移状态和受管配置，不改旧迁移或注入用户模型服务。追加迁移49，更新最小业务角色并启用统一服务/HTTP/MCP组合；验收采用实际角色，检查新旧版本兼容、许可撤销和失效源视图。不得把本机合成测试、静态页面或历史服务器记录当作当前完整上线。


## 2026-09-13 当前展示撤销与来源修复

当前 v2 引用/应用复用原 Capsule 通知类别；已发布的版本及维护事件按当前源授权重新读取，通知包含精确版本路径。来源不可用时没有原正文或旧标题副本；纯阅读不建立通知关系，原用途授权撤销后不继续推送。此机制消费已有业务变化事件，不代表云端替用户模型持续观察一切外部来源。

版本和使用记录只向本人提供 ownerControl（type、operationId、consentId、payloadHash），供客户端核对原 Consent 与实际业务回执后撤销该记录展示授权。网页使用既有 /v1/consents/{id}/revoke，丢响应保留最小原操作并查询，不能把撤销当成物理清除外部副本。其他主体无控制字段。

源正文不可读时，本人仍可依据当前管理 revision/版本计数起草空白后续版本；必须重新选择合法成功来源，不预填失效内容，也不悄悄恢复旧授权。验收入口为 test/capsule-recovery-v2.test.mjs 和独立 PostgreSQL case capsule-recovery-v2。
