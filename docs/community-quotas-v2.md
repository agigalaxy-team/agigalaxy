# 账号验证与公开写入额度 v2

2026-09-13：当前源码实现及本地集成证据，尚未部署；真实Keycloak、邮箱和官网体验仍待接入。

公开任务及任务邀请由HTTP和MCP共用Assistance用例。当前OIDC提供者必须完成ID Token核验，且提供email_verified=true；第三方登录后还需当前银河主体签署关联意图。登录本身不能接管GUID或发表内容。已关联的同一issuer/sub Account跨GUID共享额度，不因换设备、解绑或重绑重置。旧关联没有已验证邮箱事实时保持未验证，重新认证后取得真实事实，不回填伪造结论。

| Account层级 | 公开任务/日 | 评论/日 | 邀请/日 |
|---|---:|---:|---:|
| 新账号 | 2 | 20 | 5 |
| 正常账号 | 10 | 100 | 20 |

UTC自然日重置。正常级要求账号满7天及有效的非自身互动依据；年龄或同账号不同GUID互相确认不足以升级。未回应的同对象邀请冷却7天。是否有专业资格由独立资格规则判断。TaskComment后续接入同一账簿；当前仅账簿具备comment类别，不能声称评论模块已交付。

POST /v2/account/quotas 需要当前binding权限，返回验证状态、实际账号组ID、限制原因及各类别used/limit/remaining/resetAt/policyVersion；未验证返回accountVerified=false和reason，不泄露外部账号标识。公开写入失败返回account_verification_required、community_quota_exceeded、invitation_cooldown或community_restricted；限额及冷却包含Retry-After。必要收尾和私有Task不套用公开发布日额，普通私聊不使用评论日额。

配额检查和成功动作写入使用同一数据库事务与Account行锁。相同操作重试复用原ID/载荷，业务失败回滚不扣额。生产createServices始终启用验证，旧领域测试的显式quota替身仅用于隔离既有场景，不能当真实账号验证证据。

API运行可设置绝对路径GALAXY_COMMUNITY_QUOTA_FILE，内容结构同public-writes.mjs中defaultCommunityPolicy；未设置采用表中默认值。配置version随政策调整，加载摘要写入runtime_config_events。修改文件后需重启API并核对实际加载记录；写入配置不等于运行生效。

迁移44追加账号/关联/日额/回执/互动表，旧迁移不改写。API角色只获得必需读写与特定列更新；等级与限制的运营纠正入口仍属于后续治理集成。不可把测试管理员直接更新数据库当成已交付运营功能。

核验：独立本地OIDC授权码/PKCE/签名与真实HTTP任务联调通过；合成账号未冒充真实用户。真实PostgreSQL业务角色下跨GUID并发最后额度、准确重试、业务回滚、UTC重置、重绑保持限制均通过。详见account-public-http.test.mjs、public-writes-workflow.mjs与test/postgres/public-writes.test.mjs。

采用依据：PWP-M13、CUR-11/26–29/33；技术事实：[OIDC Core标准声明](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims)，核验日期2026-09-13。email不是稳定主体主键，持久账号组以受信issuer/sub标识。
