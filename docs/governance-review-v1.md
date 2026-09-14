<!-- GALAXY-CURRENT-ENTRY v1 -->
> **现有实现说明，运行与决策状态以当前入口为准。** 本页于2026-09-12迁移。当前完整规范入口为[银河产品方案](../../../../02-architecture/redesign-v1/README.md)，其中候选和已确认方向分别标记。[迁移前原样快照](../../../../01-intake/traceability/snapshots/51/5166e6143527c8776f28bb8078056a3f103b152ac1ee1488aa92eeef75a5bb17.md)保留旧文字与定位。
> 本轮业务开发、部署与备份暂停。历史验证不代表当前完整动态业务上线；保留政策已确认但尚未实施。建议与用户决定以新方案逐项来源为准。
<!-- END GALAXY-CURRENT-ENTRY -->

# 治理配置独立审核与应用 v1

治理角色、Honor/资格规则和Conformance政策通过现有JWS/Ed25519库审核。申请者与审核者签署同一份变更；两个key ID对应同一公钥也会拒绝。此流程不发放能力认证，不修改业务历史，Schema仍为28/37表。

## 资料与职责

- 治理文件仍使用 `governance-config.mjs` 的严格结构。
- 独立权限文件为 `{version:1,endpoint,requesters:[pin],reviewers:[pin]}`。每个pin包含 `kid,publicKeyPem,notBefore,notAfter,revoked`，每组最多16项。密钥必须是Ed25519。它只含公钥；实际人员和权限由运营者选定，不从待审核文件内自我授权，也不自动复用审计数据读取者的权限。
- 变更包含 `version:1,changeId,endpoint,revision,previousConfigurationSha256,configurationSha256,requesterKid,reviewerKid,issuedAt,expiresAt`。时间为Unix秒，有效窗口最多30天。摘要针对严格解析、对象键排序后的治理配置，数组顺序保留。
- `signGovernanceChange` 接受调用者提供的签名密钥。两方分别通过现有密钥持有方式签署相同变更，得到 `{version:1,requestSignature,reviewSignature}`。工具不发现、生成或保存实际人员私钥。

审核者应查看完整治理配置和相对当前配置的变化，再签署摘要。签名证明该密钥授权了这份变更，不能证明两把密钥实际由不同自然人保管；独立保管仍需真实运营落实。

## 准备及选择配置包

```text
node packages/galaxy-official/scripts/governance-review.mjs <绝对命令路径.json>
```

命令包含 `configurationPath,reviewPath,authoritiesPath,endpoint,directory`，所有路径绝对，directory必须为新目录。工具验证双方签名、独立密钥、端点、期限和配置摘要，生成 `governance.json`、`review.json`、`prepared.json`。权限文件独立保管，不复制进可替换的配置包。部分写入失败时可能留下未完成目录，不能选用；用新目录重试。准备完成不代表已应用。

部署时给API设置：

```text
GALAXY_GOVERNANCE_CONFIG=<新包>/governance.json
GALAXY_GOVERNANCE_REVIEW_FILE=<新包>/review.json
GALAXY_GOVERNANCE_AUTHORITIES_FILE=<独立权限文件>
```

API只读取一次将使用的治理配置，再验证审核。pilot环境的非空治理配置要求独立审核；local/integration允许未审核配置用于开发。只设置review或authorities其中一个会失败。

应用发生在启动时。配置留痕事务将审核ID、双方key ID、签名摘要、权限文件摘要和配置摘要关联到同一加载记录。首次审核版本必须为1；`previousConfigurationSha256`匹配上一条可识别的治理配置摘要，没有该历史字段时为null。后续变更版本递增1，必须指向前一配置。相同变更可重启加载；同ID不同内容、旧版回滚、跳版本或移除审核会拒绝启动。

未改变配置但需要更新审核期限、审核人或权限文件时，也签署新变更并递增版本。审核的有效窗口在启动验证时检查；已运行进程不会在到期时自动热更新或停止。撤销审核键或修改配置文件在下一次启动时重新检查，当前运行实例需按部署流程重启。

## AI agent实施与验收

先确认实际环境、端点、上次 `runtime_config_events` 的治理摘要和审核版本，然后准备独立权限与申请/审核资料。第一份权限文件及后续轮换属于运营权限管理，不从合成测试复制。启动后检查新进程状态和加载事件，不以prepared回执宣称上线。

配置包、双方签名及独立权限文件的版本应加入既有显式备份/归档清单；数据库只保存摘要及审核元数据，单凭数据库记录不能复验已丢失的完整签名包。旧记录缺失的新字段保持缺失，不伪造历史审核。

回退治理配置应把旧内容作为新的、更高版本变更重新审核；不能直接选择旧版包。若恢复数据库，仍先隔离、补删并核对配置历史，不跳过版本检查。关闭新实例或恢复经过审核的前向配置，是本流程的回退方式；不降低Schema。

此机制覆盖应用提供的治理配置入口。数据库所有者或主机管理员仍能直接更改代码、权限和历史，摘要链不能约束超级管理员。多实例按数据库加载记录顺序检查，旧的运行实例需部署工具协调停止。当前无生产权限配置、公开部署或真实审核人员验收。
