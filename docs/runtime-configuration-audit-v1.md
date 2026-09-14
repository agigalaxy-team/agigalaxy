<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/69/691c8d3a0d814e2cccdf75462ad70439a9c7ad31ddcb69ef563b69290da49789.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 运行配置留痕与归档 v1

2026-09-10更新：当前Schema39/43张表、31类本人导出。[Honor规则历史](honor-rule-history-v1.md)已有私有完整定义表；API配置观察同时提交规则版本引用、定义和审计。[资格策略](qualification-moderation-v1.md)另在既有快照增加qualificationRegistry的逐策略版本摘要，沿用事务和配置锁拒绝同版本替换，无新表。Honor和本版资格服务读取当前数据库引用；其他配置仍按各实例加载记录理解。下方Schema28为首次交付时版本。

Schema28新增 `runtime_config_events`，数据库共37张表。API和Worker在开始监听或领取作业前，记录已经加载、将被该进程使用的配置。写入失败会中止启动。此记录证明配置加载，不证明后续监听成功或服务上线。

## 保存与查询

每条记录包含启动操作ID、端点、API/Worker组件、时间、运营引用、发布清单摘要和版本，以及配置摘要。治理部分保留审计读取者、审计审核者、建设者评估者、内容管理者的Galaxy ID名单和增删差异；政策摘要仍保留。API的 honorRegistry 另列规则ID、版本、定义摘要及撤销标记，完整Honor定义放在受限的 honor_rule_versions 表。停服政策保留编号、期限及摘要，省略运营说明等自由文本。签名键只记录公开键ID与已验证Keyring序号，不读取私钥正文到审计。

同一端点和组件的记录串联前一事件哈希。记录与 `audit_events` 中的 `runtime.config.observe` 在同一事务提交；相同操作ID和内容重试不会重复记录。每次真正重新启动使用新ID，即使配置相同也有记录。并行实例按数据库记录顺序排列，不能把最后一条等同于所有实例的唯一生效配置。

API与Worker数据库角色只能查询和新增配置记录，不能更新或删除。无公开HTTP读取入口，主体审计查询不会将没有主体关联的运营记录猜测为该主体所有。记录属于受限运营历史，不纳入本人28类数据导出；管理者ID历史也不会随普通主体删除一起清理，需按实际运营保留政策处理。数据库备份会包含此表。

`GALAXY_OPERATOR_REF` 可提供不超过80字符的稳定事项/运营引用（字母数字、点、下划线、短横线）；缺失时明确记录 `unattributed-runtime`。这是部署进程提供的引用，不是身份认证或独立审核签名。现有审计 `context_version:0` 的运营记录不会冒充主体会话的完整认证上下文。

## 分页归档

沿用已隔离的migration运行环境和维护数据库连接：

```text
node packages/galaxy-official/scripts/runtime-config-audit.mjs <绝对命令路径.json> <新归档页绝对路径.json>
```

命令字段为 `endpoint`、`component`（api或worker）、`after`（默认0）、`limit`（默认100，最多1000）及可选 `operatorRef`。工具只查询指定端点和组件。保存 `sha256`、`lastHash`、`nextCursor`；`hasMore:true` 时用该游标继续到新文件，并检查下一页 `previousHash` 等于上一页 `lastHash`。每页验证事件摘要和前后链，错误游标或缺失锚点会失败。

每页准备与 `runtime.config.export` 审计记录在同一事务提交，关联页摘要及 `archiveId`。文件写入可能在事务之后失败，因此 `archive-prepared` 不代表文件已送达。归档命令不覆盖现有文件；重新导出会生成新的归档事项记录。页内记录有序，跨页不是冻结数据库快照；写入持续发生时，只能声称已覆盖最后游标。

归档文件可列入现有restic备份的显式文件清单，再复制到独立仓库。哈希及链提供一致性核对，不提供独立签名、防超级管理员篡改或最新性证明。生产异地存储与定时归档尚未配置。

## AI agent部署与回退

1. 先用当前代码迁移到Schema39，随后重新应用api-role.sql与worker-role.sql；运行时不自动迁移或提权。
2. 使用已经确定的治理配置、停服政策和运营引用。不要把测试身份填为实际管理员。
3. 启动后分别核对API/Worker配置事件与真实进程状态；角色变更需按现有启动加载规则重启，文件编辑本身不会热更新，也不会立即产生生效记录。
4. 若归档失败，保留原库和页，按明确游标重试。停止服务可停止新启动记录；历史表不删除。应用回退必须支持当前Schema和新增配置快照字段，恢复库仍按原隔离及补删流程处理。

治理配置的独立复核/受控应用流程已接入，见[治理审核](governance-review-v1.md)。记录实际加载并不阻止主机管理员直接修改配置，也不覆盖所有主机命令、数据库所有者的直接修改或停机期间未加载的文件版本。C16完整验收尚未完成；动态服务未部署。

配置观察新增可选治理摘要和审核信息，旧记录缺失字段保持原样。已进入审核流程的端点不能在下一次启动时移除审核；变更版本及前一配置摘要在同一留痕事务中检查。

HTTP额度文件由GALAXY_REQUEST_QUOTA_FILE选择，实际加载摘要写入requestQuotaHash；字段对旧记录保持可选。额度调优与治理双签包的范围分开。[HTTP分类额度](request-quotas-v1.md)。

API/Worker的GALAXY_RESOURCE_BUDGET_FILE实际加载摘要写入resourceBudgetHash，旧记录保持字段可选。见[资源预算](resource-budgets-v1.md)。

2026-09-10事故处置：事故配置接通API写入/分享暂停、Worker新任务暂停、公开状态和明确恢复；复用撤销处理，配置版本与恢复引用留痕。显式配置 `GALAXY_INCIDENT_FILE`，API和Worker重启后生效。7项相关测试/lint通过，未运行真实多实例切换或外部通知。详见 `docs/incident-response-v1.md`。

2026-09-10事故通知：事故私有站内通知接通运营显式投递、本人分页/已读/偏好、原生收件箱及导出/删除清单；真实API/Worker暂停恢复已验证。当前Schema29/38表，迁移后重应用api-role.sql；新客户端包含incident通知ID和偏好以及新增本人导出集。23项相关测试、隔离PG2项、lint/严格tsc及离线安装通过。详见 `docs/incident-notifications-v1.md`。
