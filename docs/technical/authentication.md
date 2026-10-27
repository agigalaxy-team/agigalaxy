# Keycloak主题、邮件码与管理邮箱扩展

目标原生API为Keycloak26.7.3 / Java21。主题/Provider与realm配置分别发行，业务身份权威见[接口](interfaces.md#管理身份与原操作)。本页维护接线、原生状态与启停合同，不记录某次服务器或邮件验收。

## 主题构建与账户接续

`apps/galaxy-auth/` 的build复用Web `site-chrome.mjs`、site-foundation/selected-shell、GalaxyMark与 `packages/galaxy-mail/src/layout.mjs`，通过ReactDOMServer生成认证外壳，不加载Web业务runtime。FTL保留原Keycloak form action、会话检查、隐藏字段、错误与可选入口；升级须对照head.ftl与上游template.ftl。layout.html/shared负责渐进增强，JS使用Keycloak可识别的.js ESM类型，搜索仅带文字至固定官网，不转递认证query。资源及相对依赖使用一致内容版本链接。

```sh
node apps/galaxy-auth/build.mjs --out <全新或空的绝对目录> [--provider-jar <准确JAR绝对路径>]
```

产物为themes/galaxy/login、选定galaxy-mail-editorial/email、site、manifest；可选JAR复制为providers/galaxy-email-code.jar并记SHA256。build不修改realm。验证码数据由JAR提供，品牌邮件HTML/plaintext头尾唯一源是galaxy-mail/layout，旧email-designs/common仅re-export。账户发件人/Reply-To按共享身份配置，静态预览示例码不进入正式模板。

公开客户端 `client-contract.json` 定义galaxy-account-entry：登录/注册进API `/v1/account/login?mode=login|register`，回调 `/v1/account/callback`，默认官网 `/app/account`。目标origin取选定服务，API管理state/nonce/S256/code exchange/签名与HttpOnly会话；浏览器不存令牌、不设浏览器complete页。public client禁implicit/password/service account/API权限，回调精确登记，不用旧auth/complete或通配。returnTo仅官网/app/范围；mode=register只把同issuer授权路径换registrations，保原参数。门户使用数据库持久会话；未启用刷新凭据时沿用原一小时期限。官网退出不等于 Keycloak SSO 退出。

galaxy realm邮箱优先注册、verifyEmail=true，firstName/lastName由 `realm-profile.mjs` 在完整profile上变可选，保校验/权限/已有值，注册模板仅过滤这两个字段。UID/公开资料合同归产品与账户服务，不在认证模板造第二套身份。

## 管理realm与资料规划器

`apps/galaxy-auth/operations/realm-plan.mjs` 的createOperationsRealmPlan只生成galaxy-operations精简realm与roles/clientScope/clients计划，不克隆普通realm或建用户/凭据。先POST /admin/realms创建realm，保原生密码/reset与profile/email/roles scopes，再依次建计划roles、client-scopes、clients；既有同名域只合相关设置，不覆盖用户。两个非composite管理角色不作default；galaxy-operations-roles mapper把真实角色放签名ID token的realm_access.roles，web/Grafana的fullScopeAllowed=false且realm scope mapping仅这两个角色。

galaxy-operations-web为public code+S256，回调仅所选admin origin的/v1/operations/callback；Grafana独立confidential code，回调/monitoring/login/generic_oauth。目录client仅service account，其role mappings和client scope mappings都只给本realm的view-users/query-users，不给manage-users/realm-admin/impersonation；可写管理邮箱client另见下节。分配用当前返回client/user/role UUID及原生role representation：`/clients/{id}/scope-mappings/realm`、`/users/{serviceUser}/role-mappings/clients/{realmManagement}`、`/clients/{directory}/scope-mappings/clients/{realmManagement}`。普通业务目录由createBusinessDirectoryPlan单独生成，不属于管理realm plan。管理域不注册、不关联普通IdP/同邮箱账户，规划器关闭自助reset；后台原生管理员reset独立。

管理子主题命令 `node apps/galaxy-auth/operations/build-theme.mjs --auth-root <auth候选>`，可选--out-root/--admin-origin，只新建themes/galaxy-operations/login，父galaxy主题须随包。复用同一React外壳与FTL，仅管理文案/返回位置不同。

普通realm资料 `realm-profile.mjs --input <原完整UPConfig.json> --output <新profile.json>` 只移firstName/lastName的required；management的planOperationsUserProfile亦只调整同域姓名必填。对当前完整GET /admin/realms/<realm>/users/profile结果规划，再以完整PUT回写，不是Merge Patch；保原profile可回退。26.7.3 permissions.user同时管注册和本人资料，required:{}意味着始终必填，required.scopes/selector.scopes是OIDC scopes而非页面。不能用假scope、管理员专用权限或CSS隐藏替代后台必填修正。

## 共享邮件渲染与模板生成

唯一公共API为 `packages/galaxy-mail/src/layout.mjs`，实现分rendering/common、frame、messages与keycloak/templates；封包须包含所有相对实现。它只生成HTML/text，不存内容或投递。普通内容使用renderGalaxyEmail({subject,title,paragraphs,note?,category?,brand?,language?,preheader?,automated?})→subject/html/text；文本自动转义。renderCodeEmail接受title/introduction/instruction/code/expiry/safety及可选continuation/codeLabel/category/brand/language/preheader→html/text；真实码/期限由调用方提供。renderEmailLayout的bodyHtml/bodyText只接可信模板，不能喂原始用户HTML。

keycloakEmailThemeTemplates返回html/text的template.ftl与galaxy-email-code.ftl四项；LayoutTemplates/CodeTemplates分别取公共壳/码正文。另导EMAIL_FONT/MONO/LOGO_URL和escapeEmailText。language默认zh-CN，en替默认类别/标签，正文语言由调用方给。FTL兼容无参数emailLayout/<#nested>，也收title/category/preheader/brandName；原生text事件无template宏，必须薄包装原消息键/参数/条件。主题messages包含galaxyMailAbout/Privacy/Guide/AutomatedNotice/ContactTeam和galaxyEmailCodeSafetyRegister/Reset。

共享信笺当前为白底细框、轨道Logo、淡粉分隔、左齐标题，24px桌面/22px手机标题、15px正文、12px辅助、11.5px落款；验证码连续单文本节点、期限紧随，无脚本/复制按钮。回复/团队说明在底部分隔前，末尾关于/隐私/使用说明分别指/how-it-works/、/privacy/、/docs/及实际年份版权。automated=false换可回复说明，正常通知不附验证码提醒。Logo源96px PNG显示27px，由auth build复制公开静态固定URL，无收件人/code/追踪参数，禁图仍保文字正文。

`src/identities.mjs` 的officialMailIdentity(purpose)给account/notice/community/updates/team五用途公开From，均agigalaxy.org、Reply-To team@；team为人工automated=false，其他true，无收信/转发邮箱。实际From/Return-Path由各transport配置，渲染器不更改它。

email-designs/render-email.mjs的renderEmailPreview只取固定示例，design b为已选editorial，a/c历史，scenario register/reset-password/system/service，change-email仅旧预览。源码保8份已选预览，旧候选产物外置；`node write-previews.mjs --selected-only [--text-only] [--output <目录>]`默认写仓库忽略的outputs/email-previews，省selected-only仍可生成全部设计而不写回源码。write-shared-templates.mjs可刷新源码四份FTL，auth build始终直接从共享导出生成，不依赖手动刷新。正式模板继承keycloak、HTML转义/表格inline样式，PNG HTTPS不加追踪。布局结构参考[Postmark固定模板](https://github.com/ActiveCampaign/postmark-templates/blob/fa73527acb4eb59cf673a54572d213e908f1515c/templates/basic-full/password-reset/content.html)和[React Email固定示例](https://github.com/resend/react-email/blob/e0561e164e9c28859d24373804e30b364931ee77/apps/demo/emails/Community/magic-links/linear-login-code.tsx)，未复制业务字段或加依赖。

## 邮件码Provider与构建

```sh
node apps/galaxy-auth/providers/email-code/build.mjs --keycloak-dir <固定26.7.3目录> --jdk-dir <JDK21> --out <新候选目录> --with-tests true
```

无需Maven或新依赖；输出galaxy-email-code-26.7.3.jar、classes/provider.json，只读输入。with-tests仅编译测试。集中行为入口为候选classes/test-classes加Keycloak `lib/lib/main/*` 的Java classpath，运行org.agigalaxy.keycloak.emailcode包的EmailCodeChallengeStoreTest、EmailCodeTemplateProviderTest、EmailCodeRequiredActionTest、RegistrationContinuationTest；模板/required action测试另加 `lib/lib/boot/*`，Windows分隔符`;`。realm planner测试为 `node --test apps/galaxy-auth/providers/email-code/realm-plan.test.mjs`。

同时验证两个Provider可用薄组合入口：`node scripts/ci/build-auth-providers.mjs --keycloak-dir <准确26.7.3分发目录> --jdk-dir <JDK21目录> --output <全新输出目录>`。它顺序调用原build.mjs、上述四个邮件码main及管理邮箱原native main，不下载工具或启动Keycloak/SMTP；主题构建仍单独将实际JAR经--provider-jar合入。

| 实现 | 原生接法 |
|---|---|
| GalaxyVerifyEmailCode | 保VERIFY_EMAIL、order100；仅galaxy realm的required-action config中email-code-enabled精确字符串true启用，其他情况委托原VerifyEmail |
| GalaxyResetEmailCode | authenticator galaxy-reset-email-code替换复制reset tree的reset-credential-email |
| GalaxyResetChooseUser | galaxy-reset-choose-user薄包装原Choose User；仅显式change-email后的after-reset note使SSO不跳过输入，成功选择清note，不登出SSO |
| realm-plan.mjs | planEmailCodeRealm复制完整原reset树/子树与配置、保顺序；fixture patch只供全新本机realm，不覆盖既有服务器 |

正常browser password flow、Reset Password、条件OTP/密码策略和force-login选择保持。邮件码默认6位、600秒、60秒重发、每事务5次错误；配置code-ttl-seconds范围2..900、resend-seconds 1..300、max-attempts 1..10，分别在VERIFY_EMAIL config与reset authenticator config。重发不重置错误次数、刷新不发新码，只收六位ASCII数字（允许去空白），认证会话自身过期不被code TTL延长。

SingleUseObjectProvider只存摘要/短期状态/消费标记。初始putIfAbsent立即占位+replace初始化以适配26.7.3延迟put，UUID竞争有界；随后原子remove抢占并在原事务恢复错误/重发/消费状态。摘要绑定realm/root session/tab/client/purpose/user/current email。重发最多8次排除与旧盐摘要相同数字，失败不发送并继续作废旧码；同收件者跨事务cooldown。未知/禁用/无邮箱账户同页面、不发邮件、不建账户、不能验过；SMTP同步耗时不同，不能承诺严格时间抗枚举。

### 未完成注册接续

原生先存用户再验证/设密码，中断会占邮箱。显式FormAction `galaxy-registration-user-creation` 仅接续enabled本地用户、无任何凭据/外部关联/存储关系、仍需UPDATE_PASSWORD；复用REGISTRATION UserProfile校验但不create/update旧profile，移除重填password字段。每次原AuthenticationSession绑定user/current email并重新消费本tab码，不能借旧verified。GalaxyRegistrationUpdatePassword只对本registration note核proof/无凭据/待密码后委托原密码策略，其他realm/密码动作委托原实现。原子reserve/replace串行首密码写，校验失败/rollback释放同owner，成功有界完成占位最多一小时，旧owner不清替换owner。

planRegistrationContinuationRealm只复制当前registration树，替换唯一user-creation、保requirement/priority/config/其他步骤，默认副本galaxy registration continue，幂等无IO。输入包含registrationFlow、完整树、引用config/requiredActions。要求精确galaxy、邮箱作用户名、verifyEmail/码启用，同form原native creation/password均REQUIRED且顺序正确，拒always_set_password_on_register_form=true；运行亦核延后密码note。

### 页面和邮件合同

galaxy-email-code.ftl使用原url.loginAction；action=verify带code、resend走cooldown、cancel走原协议失败、change-email仅reset作废challenge回Choose User。取消required action用context.failure，context.cancel仅AIA。模板属性galaxyCodePurpose(register/reset-password)、遮盖邮箱（reset为空）、ResendAfter/ExpiresIn秒、Blocked/CanResend；后者是冷却后能力。错误为galaxyCodeInvalid/Expired/TooMany/ResendWait/SendFailed/Unavailable。

EmailTemplateProvider.send使用realm实际email theme的html/text galaxy-email-code.ftl，subject key galaxyEmailCodeSubjectRegister/Reset，attrs为code/purpose/brand/expiresInSeconds/expiresInMinutes，传可变Map（processTemplate会补上下文）；验证码不进标题。此扩展不接UPDATE_EMAIL、管理execute-actions或IdP绑定邮件。

## 管理邮箱原生验证

独立RealmResourceProvider galaxy-management只供galaxy-operations中固定confidential enabled service-account client `galaxy-management-account-maintenance`，token须具realm-management/manage-users及client scope，body前鉴权。

| native路由 | 协议 |
|---|---|
| GET `/realms/galaxy-operations/galaxy-management/email-change-capabilities` | 无query，version1、available、mode=native-update-email、verificationBeforeChange/metadataOnly=true |
| POST `.../users/:sub/email-change` | 无query，严格operationId canonical UUID/newEmail，≤8192字节，不接clientId/redirect/外部URL |

202响应只含version/operationId/state(submitted或unknown)/code/epoch expiresAt/metadataOnly，不含地址/token/link/error。Node `management-email-changes.mjs` 的createManagementEmailChanges({issuer,privateOrigin,writer,fetch?,now?})使用HTTPS管理issuer、只准loopback HTTP的private origin、已加载writer或null，不读凭据文件；固定派生token/capability/POST URL，Host为public issuer、禁redirect、响应≤64KiB/有限timeout。available只认准确协议，request在唯一POST前调用fresh authorize；注入createKeycloakManagementAccounts的emailChanges，缺省不可用。

native调用UpdateEmail.validateEmailUpdate，用真实old email（含null/blank）生成UpdateEmailActionToken、session.tokens签署、原email-update-confirmation模板发送。有效期取realm既有update-email action lifespan，成功提交后只设EMAIL_PENDING，不改active email/emailVerified。原token handler核签名/issuer/expiry/enabled user/client/cookie/single-use，再比old与current、new与pending，最终才改资料。

Node原command ledger仍是owner/target/intent权威；SingleUseObjectProvider guards锁operation/target至native事务结束，user attribute `galaxy.management.email-change.<operationId>` 留metadata-only意图摘要/提交态/expiry，防过期链接后同操作再发，不是通用history。若unmanaged attributes可普通用户编辑或marker显式user-editable，capability拒绝。SMTP不与PG/native事务原子，commit uncertainty沿[原操作规则](interfaces.md#管理身份与原操作)处理。

## 安装、回退与局部验证

1. 主题挂新只读版本目录，保旧loginTheme；仅目标realm启theme，静态site分支保既有realms/resources反代，其他路径404。静态入口no-store/no-referrer/nosniff/DENY，CSP限self、base/frame-ancestors none；Keycloak自身CSP不覆写。
2. 邮件码先装JAR+登录/邮件模板、复制reset tree，开关缺省/关闭；选择emailTheme/绑定reset后最后合VERIFY_EMAIL策略+true。注册接续更新先装匹配JAR/template、设姓名可选、复制registration树替换action再绑定。保原完整profile/树/挂载；回退先恢复开关存在性/值/策略/theme/flow或registration profile/绑定，确认后再撤JAR，失败保候选以免绑定失效。
3. 管理邮箱JAR由其build.mjs以同Keycloak/JDK和 `--with-tests true --run-tests true` 生成新目录，测试classpath含main/boot及标准非FIPS provider。26.7.3的update-email为build-time feature，确需更改时用 `kc.sh build --feature-update-email=enabled` 保其他选择；runtime start --optimized不代替build。不能为此开realm verifyEmail或UPDATE_EMAIL defaultAction。缺feature/handler/profile/template/SMTP host、issuer不符或marker可写时capability false。
4. SMTP仅通过目标realm原生配置合并，保护checkpoint保原真实值，mask不作回退凭据；模板更新保flow/provider。主题、client、provider、SMTP变更按所改范围分开验证，不改用户/密码以绕过配置。

邮件码真实隔离路径用新H2、example.invalid合成账户、loopback回调/内存SMTP，集中覆盖注册→码→原密码→OIDC、密码登录、reset及错误/过期/重发/并发/取消/重填/SMTP失败；不持久化码/密码/Cookie/OAuth参数。管理邮箱实际送达/点击需获准测试身份与邮箱，检查fresh native user而非提交回执。检查层次见[开发](development.md#故障定位与未验证范围)。

固定上游依据：26.7.3的[VerifyEmail](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/requiredactions/VerifyEmail.java)、[SingleUseObjectProvider](https://github.com/keycloak/keycloak/blob/26.7.3/server-spi/src/main/java/org/keycloak/models/SingleUseObjectProvider.java)、[UpdateEmail](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/requiredactions/UpdateEmail.java)、[UpdateEmailActionTokenHandler](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/actiontoken/updateemail/UpdateEmailActionTokenHandler.java)。Provider不捆绑替换上游类，许可原文归组件。

## 门户会话与连续使用

网站与管理门户各自在原配置中可选 `sessionRenewal:{keyFile,idleSeconds,maximumSeconds,refreshBeforeSeconds}`。工程默认闲置 7 天、最长 30 天、提前 60 秒续期。keyFile 为源码外受保护的文件，内容为独立生成的 32 字节 base64url 密钥；前后台以用途、配置及原 token hash 绑定加密上下文。

短期凭据在服务器续期，浏览器只持稳定 HttpOnly Cookie；原账户 ID、CSRF、角色和草稿作用域不因正常续期改变。真实输入活动才延长闲置期，事件心跳、页面聚焦和后台定时器不算活动。并发续期由原表 CAS 合并，注销和撤销阻止迟到结果恢复会话。

网络/认证服务暂不可用与真正失效分别处理。交换结果未知不再次使用可能已经旋转的 refresh token，保留未确认状态并允许退出；明确 invalid_grant 才按撤销处理。未知业务写入继续查原 operation，不因认证恢复重发。

启用前须先应用技术迁移并核实际 Keycloak 客户端及 SSO idle/max 与 refresh-token 配置。未配置或上游未提供刷新凭据时不伪称长期登录；原会话必要时只做一次重新登录。源码中的默认值不表示已修改真实认证系统。
