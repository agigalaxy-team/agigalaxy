<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/d3/d334455b95fbd9938affaeb51d29013549148e902eec0938d9371f0dfa80896a.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 可信本地主机组合入口

2026-09-10：新增`/audit`客户端与控制器readAudit/prepareAudit/executeAudit，显式audit/audit-review范围对应审计查询和审核签名。原生连接页“绑定与审计”子菜单提供入口；本地主机只在准确审批预览确认后签署`galaxy-audit-approval+jws`。[操作及权限](audit-access-v1.md)。

`packages/galaxy-official/src/local-host-runtime.mjs`提供`createLocalHostRuntime`，将当前Core身份、Connection Profile、Manifest验证、连接客户端、进程内会话和主动状态核查接到同一个控制器。它属于可信宿主层，允许读取本机私钥；不能纳入无私钥权限的纯验证/轻量客户端依赖图。

## 接线

宿主配置模块显式提供以下参数，再把`runtime.controller`传给`createGalaxyAdapter`：

```js
const runtime = createLocalHostRuntime({
  dataDirectory,       // 已初始化的绝对目录；不默认搜索用户目录
  endpoint,            // 已配置的规范HTTPS origin
  installationId,      // 配置持有的稳定UUID v4；不在预览时生成
  scopes,              // 精确展示并确认的服务scope，必须含binding
  bindingScopeId,      // Connection Profile中已有的binding意图ID
  trustedKeys,         // 可信配置/根信任链给出的Map，支持撤销更新
  manifest,            // 用户先前主动取得的原始签名Manifest对象
});
const adapter = createGalaxyAdapter(runtime.controller);
// 在真实宿主退出/卸载时调用runtime.close()，清理本机会话。
```

此片段展示组合变量关系，不包含真实端点、密钥、令牌或已安装配置。生产省略connectionSend/statusSend；它们是测试时注入逻辑端点适配的边界。不能把测试loopback传输接到正式配置。

## 本地校验和权限

构造不会读文件或联网；prepare在读取当前公开身份/初始化状态和Connection Profile后验证Manifest。状态与执行检查继续复核，不从远端提供的“许可”字段获得授权。Manifest必须同时声明binding和sessions；超过五分钟的旧Manifest需要用户重新主动取得，再重建组合，不自动刷新或重连。

绑定意图必须对应同一Official目标、recipient等于endpoint、未撤销且未过期，并明确列出subjectId、genesisProof、installationId和scopes字段。旧数据不自动迁移；未初始化、待恢复、缺少profile或不符合要求时拒绝。新的更宽scope仍须在准确请求预览中由用户明确确认；这些会话scope不会创建任何对象Consent。

签名只允许两种已验证连接挑战用途。固定本地私钥路径只在确认后的签名阶段读取，采用Core共享读锁，与公开身份配对后由jose签名。只返回JWS，不导出私钥。对方给出的绑定/凭据期限不能超过本地绑定意图期限；当前服务器默认绑定最长86400秒，较短意图会拒绝其挑战，不擅自延长本地期限。

身份、初始化配置或Connection Profile变化会使旧预览/会话失效；服务器响应等待期间重置、撤销、pin变化和Manifest过期也会在下一步前被拒绝。合作式Core写锁保护本地读/签名区间；它不承诺阻止绕过Core直接篡改文件的同机进程，也不能召回已经发出的请求。取消和未知远端结果仍按客户端规则处理。

没有在此模块实现通用私钥签名API、凭据落盘、OAuth授权服务器、自动配置写入或全局宿主安装。当前只组合Official profile；Hub差异由后续明确profile任务处理，不能据此称Hub兼容。

## 验证和回退

local-host-runtime.test.mjs使用临时Core目录、合成密钥和真实本地服务处理器：检查实际签名连接/状态、配置撤销、缺失和错误私钥、恢复/重置、pin撤销、Manifest过期、字段限制及远端期限越界。预览不读私钥、不创建缺失目录、不发送；测试不等于真实HTTPS或生产验收。

关闭调用runtime.close；移除可选注入可恢复默认只读Adapter。没有数据库迁移或本地格式变更；已有短期内存会话不恢复。实际原生界面和宿主卸载生命周期需另行验收。

新增dataExportSend用于显式端点请求；受信组合将dataExportClient及saveDataExport接入控制器。用户输入现有绝对目录后才创建本机导出目录；取消保持.partial标记，不读取/重建身份密钥。便携客户端不包含本机写入模块。详见[data-export-v1.md](data-export-v1.md)。

删除申请已接入可信宿主：data-delete范围、prepareDeletion/executeDeletion/readDeletion、原始本地身份签名和本机取消；不初始化身份，不执行物理删除。[说明](deletion-requests-v1.md)。

2026-09-10 Schema25：35表/28类本人导出；deletion入口增加createDeletionStatusClient，原生菜单支持无云端会话的回执查询。主库删除执行与保留续跑见[删除流程](deletion-requests-v1.md)。备份恢复保留执行账本；快照后删除重放仍待完成。

2026-09-10：原生接入页已接通显式配置、主动匿名Manifest读取、信息展示、现有本机签名连接和断开后重读；修复根严格TypeScript宿主类型错误。7项相关测试、根严格tsc和lint通过；先前tsc失败为历史记录，现已修复。详见 `docs/configured-native-adapter.md`；实际宿主人工验收及动态部署未完成。

2026-09-10客户端状态更新：补齐Manifest与会话分项状态、信任变化后的状态更新、原生延迟回调取消及完整宿主卸载；复核既有会话隔离和最小签名。23项相关测试、类型检查/lint通过；原生接线现已存在，较早未接线说法为历史状态。当前仍无独立回执档案/钥匙串持久化，实际宿主接线验收保留。见 `docs/configured-native-adapter.md`。

2026-09-10本机回执更新：已确认握手的签名回执独立落盘，接通原生离线历史查看；重启/断开不恢复会话，存储失败与连接结果分开。13项相关测试、离线入口2项补跑、严格类型/lint通过。现已具备独立回执文件，前文缺失回执描述为当时状态；仍无Token落盘、自动恢复、全局安装或动态部署。见 `docs/local-binding-receipts.md`。

2026-09-10争议说明补充：协作争议新增四类举报、带引用的补充和附理由的本人说明纠正；原生准确确认、私有正文及导出联动已接通，原记录保留。Schema28/37表不变；新客户端已完成离线安装。详见 `docs/moderation-statements-v1.md`，旧日期记录保留为历史。

2026-09-10事故通知：事故私有站内通知接通运营显式投递、本人分页/已读/偏好、原生收件箱及导出/删除清单；真实API/Worker暂停恢复已验证。当前Schema29/38表，迁移后重应用api-role.sql；新客户端包含incident通知ID和偏好以及新增本人导出集。23项相关测试、隔离PG2项、lint/严格tsc及离线安装通过。详见 `docs/incident-notifications-v1.md`。

2026-09-10履历重建：履历新增版本化重建记录、可见来源引用和稳定内容摘要；客户端同会话对照及原生展示已接通，父Case共享锁防止版本混合。旧projectionHash与API响应版本兼容；新客户端已完成离线安装。7项相关测试、真实PG1项、严格tsc和lint通过。见 `docs/history-rebuild-v1.md`。

2026-09-10Profile宿主：Profile原生编辑、准确预览、本机签名及自述/事实分区展示已接通；默认私有，版本冲突不覆盖，取消与旧页面回调不继续发布。11项相关用例、严格tsc、lint及客户端离线安装通过。C10-03待复核；未全局安装或外部部署。见 `docs/profile-statements-v1.md`。

2026-09-10履历视图与结果：履历新增三类独立字段规则、五类结果时间线及成功报告后的后续结果；读取重算状态/时间与空资料展示接通，Evidence源/Proof/授权/绑定撤销联动已验证，重建规则升级v3。13项不同相关用例、真实PG1项、严格tsc、lint及客户端离线安装通过。见 `docs/history-views-and-outcomes-v1.md`；C10-06直接操作入口仍待补齐，动态服务未部署。
