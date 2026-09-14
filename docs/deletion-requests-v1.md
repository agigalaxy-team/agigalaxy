<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/11/11450908fa66684298f8d519b5d0e3478172b16a6d5d8b20ad196a6bccc01416.md)保留旧文字与定位。
> CUR-35已恢复计划内开发与部署，后台备份仍暂停。保留、导出和删除按具体对象分批实施；[当前隐私网页与实际验证](../../../../07-logs/development/privacy-web-workspace.md)及[当前服务记录](../../../../07-logs/development/README.md)描述现状。下方日期型内容保留其证据范围，不能用于宣称全部数据类别或存储介质已完成删除。
<!-- END GALAXY-CURRENT-ENTRY -->

# 删除申请与处理账本 v1

2026-09-10 更新：当前 Schema38 / 43张表。删除清单已登记多主体运营规则历史，保留规则定义；执行回执的 `operatorPolicies` 明确报告仍包含本人ID的Honor版本数和 `cleanupImplemented=false`。运营规则引用的保留/最小化须另行处理，不能以本人主库删除结果宣称这些引用已清除。见[规则历史](honor-rule-history-v1.md)。下方Schema26说明是首次交付记录。

Schema26增加恢复重放记录，沿用Schema25的deletion_executions及执行结果；当前36张表、28类本人导出、19个客户端入口、16个可选会话范围。签名申请、审核、主库执行、续跑和删除后回执查询均已接通；动态服务未部署。

**提交申请或审核通过都不会执行物理删除。** 原五种状态为requested、review-needed、approved、rejected、cancelled；执行器新增partial和primary-erased。primary-erased只表示本人主库记录已删除，不代表备份、介质或第三方副本已擦除。所有结果仍明确serviceWideDeletionComplete:false；隔离恢复重放已实现，回执最小化及准确快照到期清理已实现，生产执行配置待完成。

## 申请人的流程

原生入口：“接入银河”→“绑定、审计与数据管理”→“数据删除申请”。申请和列表只在当前会话明确包含新范围 `data-delete` 时可用；凭本机身份查询回执不需要云端会话；旧绑定和旧会话不自动扩权。继续使用原Galaxy ID、公钥和本机私钥，不重新初始化身份。

选择“已取回所需数据”或“不需要先导出”，随后预览准确端点、主体、申请ID和全部本人云端数据范围。点击“签名并提交”才使用本机身份签名。API/客户端还可选择privacy/other原因，以及已经导出时的manifest SHA-256；服务不收本机导出文件。取回声明来自申请人，不等于服务验证了本机文件完整性。

签名类型为 `galaxy-deletion-intent+jws`，复用jose/Ed25519。严格载荷包含版本、事件ID、端点、主体、当前绑定、签发和到期时间；意图最长300秒。request包含 `scope:all-owned-service-data`、原因和取回选择；cancel包含原申请ID及expectedRevision。不接受SQL、路径、任意表名、他人主体替换或额外字段。

当前范围是申请处理本人在该Official上的服务数据，不授权删除他人的贡献或本地身份。原始签名和载荷作为请求证据保存；请求受理后不依赖原签名继续有效来表示记录存在，也不把原签名当成永久登录凭据。

每个主体最多一条requested/review-needed/approved/partial/primary-erased申请。服务校验当前data-delete会话与本人签名，并以事件UUID/载荷摘要实现重复提交保护。不同内容复用同一事件ID会冲突；撤销的申请不会因重发原意图重新打开。新的有效绑定可以查询、取消同一主体的旧申请。

取消只允许requested/review-needed/approved且版本一致；取消也签名。审核和取消在同一申请行上串行，版本冲突必须先刷新。取消只改变尚未执行的申请，不恢复已经撤销的业务授权；当前受理/审核本身也不撤销任何Case、Consent或绑定。

不确定网络结果时先查询申请，不自动换一个ID再发。取回窗口内允许申请接口；status-only/closed阶段不再提供认证及原申请读写API；新增status持钥查询仍可用，但仍需要服务实际在线。服务完全不可达时通过停服公告渠道处理。

## API与客户端

均为POST JSON；除status使用原身份签名外，其余使用data-delete会话；Caddy路径和固定HTTP失败审计已加入。

| 路径 | 输入 | 输出 |
|---|---|---|
| `/v1/deletion-requests/status` | `{signed}` | 原身份持钥查询，无Bearer凭据 |
| `/v1/deletion-requests/config` | `{}` | 当前主体、范围和受理边界 |
| `/v1/deletion-requests/submit` | `{signed}` | request或cancel的当前回执 |
| `/v1/deletion-requests/read` | `{id,afterRevision?}` | 本人申请、原始签名、最多20条后续事件 |
| `/v1/deletion-requests/query` | `{after?,limit?}` | 本人申请，最多20条及下一游标 |

回执含requestHash、state、revision、时间和 实际 `physicalDeletionPerformed`、`executionImplemented:true` 及逐存储execution结果。它是服务报告的受理/审核状态，不是独立签名的物理删除证明。本人读页保留subject事件的原始签名；operator事件明确没有主体签名，不能混为申请人的意图。

`@galaxy/client/deletion`提供createDeletionClient、prepare/execute/cancel、config/read/query。便携客户端仅调用注入的签名器，不读取私钥或写本机文件。可信本机宿主核对预览、当前会话、原身份、原授权和密钥匹配后签名。客户端核对端点/主体/申请、原请求摘要、逐事件摘要、连续版本及完整分页。

“取消本机预览”与“签名取消远端申请”分别处理。前者不会发送取消意图；已发送而返回迟到时，应查询实际记录。原生详情区分未执行、部分处理、主库已删除，并显示本次删除/剩余数量、审计状态和未完成的备份处理。

## 运营审核

审核使用独立数据库角色galaxy_deletion_reviewer及脚本：

```text
node packages/galaxy-official/scripts/deletion-review.mjs <绝对路径decision.json> <新的绝对路径receipt.json>
```

先在迁移环境配置现有DATABASE_URL/GALAXY_ENVIRONMENT，并通过 [deletion-review-role.sql](../packages/galaxy-official/src/infrastructure/deletion-review-role.sql)授予审核角色。它只能读取两张账本表、追加事件、更新申请状态/版本，不能删除主体或修改历史事件。API请求没有运营审核入口。

decision包含事件UUID、原申请ID、端点、expectedRevision、reviewerRef、decision和explanation。decision为needs-information、approve、reject；只有approve必须同时提供完整plan。reviewerRef是受授权数据库操作者填写的可公开参考，不是通过主体签名核验的自然人身份。

plan明确primary的删除notBefore与依据、audit最小保留until与依据、backups快照到期/删除重放until与依据，以及外部副本不受本服务控制。时间和依据必须由运营填写，代码没有预设生产保留天数，也不验证法律依据是否充分。当前审批仍只是计划记录。

审核事件追加保存。审批必须从requested/review-needed开始，重复相同事件保持幂等，改写旧事件、跳过当前版本或审核已取消申请都会失败。输出写入失败不等于审核没提交；先核对该事件ID，再按同一个事件重试。脚本返回固定错误，不输出数据库地址、正文或凭据。

## 存储、导出与恢复

deletion_requests保存原始主体签名、验证用公钥、原绑定引用和当前状态；deletion_events保存主体操作/运营意见、各自摘要及版本。两张表故意不以外键依赖subjects/bindings，以便后续主体数据删除后保留必要回执；保留不等于已决定无限期保留，Schema27已支持按显式政策最小化运营文本；主体签名及必要关联继续保留。

本人数据导出包含deletion-requests/deletion-events/deletion-executions，共28类。后者按原申请主体过滤；申请人可取回运营对其申请的意见，不可导出他人的请求记录。签名、副本、撤销状态和操作来源均保留。

备份包含三张账本表；隔离恢复保留其原始字节并继续关闭旧绑定/凭据。仅恢复普通备份仍不覆盖快照之后的变化；Schema26增加独立账本捕获、取消/审核/执行事件补齐与幂等重放，见[删除恢复](deletion-recovery-v1.md)。恢复流程不会仅凭approved状态自动执行删除。

## 验证与下一步

测试覆盖实际HTTP、客户端、宿主控制器、原始身份签名、重复请求、他人拒绝、签名不匹配、权限移除、意图过期、运营审核/版本冲突、取消与本人导出；原生菜单和可信本机宿主另有测试。真实PostgreSQL工作流使用受限API与审核角色，备份演练保留真实生成的签名申请及事件。

后续部署落实生产捕获/存储配置；备份到期/删除必须取得各仓库的实际证据。真实宿主人工验收、运营保留政策、生产通知和部署仍单列；当前动态Official未部署。


## 主库执行器（Schema25）

`node packages/galaxy-official/scripts/deletion-execute.mjs <绝对路径command.json> <新的绝对路径receipt.json>`

命令为严格JSON：`version:1`、新的UUID `id`、`requestId`、对应approve事件的`approvalId`、准确`endpoint`、当前`expectedRevision`和运维引用`executorRef`。不接收表名或SQL。沿用migration运行环境，通过独立注入的DATABASE_URL连接专用数据库。当前执行器需要该数据库的维护/迁移所有者权限；API、Worker、审核角色不能执行。生产运营者及保留政策尚未配置。

执行器重新核对原申请签名、审核计划和notBefore，锁定当前36表，撤销主体的绑定、凭据、Consent、Proof、材料授权、审计访问和导出票据，然后对30张目标表按主键建立候选记录。按照真实外键反复删除无引用的本人叶子记录，绝不通过CASCADE删除别人的贡献。Worker审计的逻辑binding引用在保留期内也阻止删除该绑定，保证续跑可定位。

audit_events、audit_access_grants、audit_reads、data_export_reads遵守审核计划的audit.until；他人引用造成的剩余行保留并计数，不伪装删除完成。已删除或撤销的主体不能通过新挑战或旧待完成挑战重新注册；正在采集的Worker丢失已删除作业后退出，不重建记录。删除本机身份不在范围内。

同一执行ID与相同命令返回原结果，不重复删除；同ID不同命令冲突。保留到期或引用解除后的续跑使用新的执行ID和当前revision。每次结果保存选中、删除、剩余及累计计数，区分主库、审计、备份、外部副本、回执账本；事件、执行结果及请求版本在同一事务提交。事务失败全量回滚。若文件写入失败而事务已提交，先核对原执行ID，不推断执行失败或换ID盲重试。

此版本是维护窗口工具：事务对36表取得ACCESS EXCLUSIVE锁，会等待并阻塞业务访问；沿用数据库连接的语句超时，超时/死锁整体回滚。大数据量需要后续批处理设计，不承诺不停服删除或物理介质安全擦除。

## 删除后的本人回执

`@galaxy/client/deletion`另导出createDeletionStatusClient。prepare/execute/cancel使用独立 `galaxy-deletion-status+jws` 签名，包含原申请ID、主体、端点、新意图ID和最长300秒有效期；仅在确认后签名并发送，不附带云端凭据。服务使用删除请求中保存的原公钥验证，返回对应意图ID和当前执行结果。它是经HTTPS查询的服务账本状态，不是独立签署的全介质擦除证明。

原生菜单的“凭本机身份查询回执”允许无云端会话进入，用户输入原申请ID；可信宿主使用原身份密钥。当前仍要求本机显式配置的绑定意图未撤销/到期；过期配置需先由用户更新。申请签名、公钥和必要账本保留；运营原文及执行明细支持到期最小化；可在准确隔离恢复库中显式补齐快照之后的事件并重放已执行删除，完成后仍继续隔离。

当前执行计数覆盖数据库事务时点；独立SQLite失败审计队列已接入删除期限检查，到期后确认出队而不重建主库记录。primary-erased不能解释为所有存储及后续异步交付均已清空。

Schema26删除恢复与迟到审计的命令、截止时间、来源保护和实际范围见[操作说明](deletion-recovery-v1.md)。

Schema27的保留字段、到期命令、摘要校验及恢复边界见[回执最小化](deletion-minimization-v1.md)。
