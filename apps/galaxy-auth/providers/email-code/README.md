# Keycloak 邮件验证码

本扩展针对 **Keycloak 26.7.3 / Java 21**。正常登录仍使用 Keycloak 密码、既有 SSO 与原 OIDC/OAuth 接续；启用后替换注册/未验证邮箱的 `VERIFY_EMAIL` 动作和找回密码流程中的发邮件执行，并为明确重新填写邮箱保留一次真实选择。扩展安装后默认不启用注册验证码。它不创建第二套账户、登录令牌或本地银河 ID。

该版本内置的 `VerifyEmail` 与 `ResetCredentialEmail` 发送带 action token 的链接，不是数字验证码。扩展使用 Keycloak 支持的 provider override 和 Authentication SPI，复用认证 Cookie、AuthenticationSession、表单 action 校验、密码策略、注册创建和后续 required actions。

## 构建

在仓库根目录运行，输入为已有 Keycloak 安装目录及 JDK；无 Maven 下载和新增依赖：

```sh
node apps/galaxy-auth/providers/email-code/build.mjs --keycloak-dir /absolute/keycloak-26.7.3 --jdk-dir /absolute/jdk-21 --out /absolute/new-provider-candidate --with-tests true
```

输出 `galaxy-email-code-26.7.3.jar`、编译类与不含用户数据的 `provider.json`。构建只读输入目录，不修改 Keycloak 安装、数据库、realm 或 SMTP。`--with-tests true` 只编译测试，不执行。

独立行为测试的集中运行入口：

```sh
java -cp "/absolute/new-provider-candidate/classes:/absolute/new-provider-candidate/test-classes:/absolute/keycloak-26.7.3/lib/lib/main/*" org.agigalaxy.keycloak.emailcode.EmailCodeChallengeStoreTest
java -cp "/absolute/new-provider-candidate/classes:/absolute/new-provider-candidate/test-classes:/absolute/keycloak-26.7.3/lib/lib/main/*:/absolute/keycloak-26.7.3/lib/lib/boot/*" org.agigalaxy.keycloak.emailcode.EmailCodeTemplateProviderTest
java -cp "/absolute/new-provider-candidate/classes:/absolute/new-provider-candidate/test-classes:/absolute/keycloak-26.7.3/lib/lib/main/*:/absolute/keycloak-26.7.3/lib/lib/boot/*" org.agigalaxy.keycloak.emailcode.EmailCodeRequiredActionTest
java -cp "/absolute/new-provider-candidate/classes:/absolute/new-provider-candidate/test-classes:/absolute/keycloak-26.7.3/lib/lib/main/*:/absolute/keycloak-26.7.3/lib/lib/boot/*" org.agigalaxy.keycloak.emailcode.RegistrationContinuationTest
node --test apps/galaxy-auth/providers/email-code/realm-plan.test.mjs
```

Windows classpath 分隔符使用 `;`。8 个行为情境包含普通即时缓存，以及 26.7.3 的 `put` 延迟提交、`get` 可读己写、原子 `remove` 只见已提交、`putIfAbsent` / `replace` 立即生效的合同；另覆盖重发遇到相同数字的有界重抽。3 个真实 Provider 合同情境分别经过注册、找回及不可变 Map 对照；真实 `processTemplate` 会原地补入上下文字段，因此必须传入可变属性表，运行该测试还需 `lib/lib/boot/*` 的日志依赖。实际浏览器事务、SMTP 与 required action 渲染仍由本地真实 Keycloak 隔离用例覆盖。

## 未完成注册接续

26.7.3 原生 `RegistrationUserCreation` 在表单成功时已保存用户，邮箱验证和延后设置密码随后执行。中途失败或取消不删除用户，因此重填原生表单会遇到重复邮箱。新增显式 FormAction **`galaxy-registration-user-creation`**，正常新注册仍委托原生创建；仅接续启用的本地用户、没有任何登录凭据或外部登录/存储关系、仍需 `UPDATE_PASSWORD` 的记录。它复用原 REGISTRATION UserProfile 校验，但不调用现有用户 profile 的 create/update，不覆盖姓名、属性或已有资料；重填的 password/password-confirm 被移除。

每次接续在原 AuthenticationSession 中绑定实际用户和当前邮箱，重新消费本标签的邮件码；已验证但尚未设密码也不能凭旧 verified 标记跳过。错误、到期、重发和取消沿原邮件码规则。码通过后，薄包装 **`GalaxyRegistrationUpdatePassword`** 沿用 `UPDATE_PASSWORD`、order 100，仅对本注册 note 重核邮箱 proof、当前仍无凭据和待设密码状态，再委托原生密码策略与保存。没有本 note 的密码修改/找回和其他 realm 完全委托原实现。另以立即原子 reserve/replace 串行化首个密码写入，原生校验失败或事务回滚释放同 owner，成功保留有界完成占位；占位最多一小时，旧清理不移除替换 owner。其他标签已完成后，旧密码页不能覆盖正式账户。

`realm-plan.mjs` 另导出纯函数 `planRegistrationContinuationRealm(representation, {registrationAlias?})`，默认副本名 `galaxy registration continue`；无 CLI、相对依赖、HTTP 或写入。输入含当前 `registrationFlow`、完整 root/子流程、被引用的 `authenticatorConfig` 和 `requiredActions`。它只复制当前 registration 树并替换唯一 user-creation 执行，保留原 requirement/priority/config、验证码和条款等其余步骤，输出同类 realm representation；原树不改，再次规划幂等。要求精确 `galaxy`、唯一邮箱作用户名、verifyEmail 及邮件码启用；同一 form 中原生 user creation/password 均 REQUIRED 且顺序正确，不能配置 `always_set_password_on_register_form=true`。运行时也检查原生延后密码 note，配置不符合就不接管重复邮箱。

先使同一 JAR 内原邮件码、新 FormAction 和密码包装可用，再应用资料规则与复制注册树，最后绑定副本；回退先恢复原 registration binding/资料规则再卸新 JAR，不删除用户或改已有凭据。`/authentication/form-action-providers` 可查询新 FormAction。`createEmailCodeFixtureRealmPatch` 为全新本机夹具同时提供新注册副本和既有 reset 邮件码配置。

`RegistrationContinuationTest` 的五个情境覆盖原用户/资料保留、未完成范围、本事务 proof、旧密码页拒绝以及占位提交/回滚；native 数据库与密码策略、真实双标签和 OIDC 返回仍由本机 Keycloak 操作覆盖。

## Provider 与流程

- `GalaxyVerifyEmailCode` 沿用 **`VERIFY_EMAIL`**，`order()=100`。安装后默认不启用验证码；只有名称精确为 `galaxy` 的 realm，且该 required-action config 的 **`email-code-enabled` 精确为字符串 `true`** 时才走码页面。其他 realm、缺失/关闭/非精确值均委托原 Keycloak 实现。启用后继承原触发条件，因此 `verifyEmail=true` 的新注册和已存在但未验证邮箱的账户都走码页面，不再同时发旧验证链接。已验证邮箱的正常密码登录不插入验证码。
- `GalaxyResetEmailCode` 的 authenticator ID 为 **`galaxy-reset-email-code`**。复制正在使用的 reset-credentials flow，将 `reset-credential-email` 替换为验证码步骤，另用 **`galaxy-reset-choose-user`** 薄包装原 Choose User。Reset Password、条件 OTP、密码策略和既有 `force-login` 选择保留。不要修改 browser password flow。
- `GalaxyResetChooseUser` 正常选择与提交均委托原 `ResetCredentialChooseUser`；只有用户明确点击“重新填写邮箱”后，`resetFlow` 的 after-reset 回调写入一次 `galaxy.email-code.reset.choose` note，使原邮箱输入页不被现有 SSO Cookie 自动跳过。该选择在刷新和输入错误时保持，原选择动作成功后移除；不退出 SSO，也不改普通登录。选择步骤的原 requirement、顺序及配置沿用。
- `realm-plan.mjs` 导出纯函数 `planEmailCodeRealm(representation, {resetAlias?,policy?,emailTheme?})`。它复制原 reset flow 及其子流程、保留执行顺序与配置、更新 `VERIFY_EMAIL` 的设置；不请求服务器或写文件。输入应在内存中提供；不要为了此函数将含敏感配置的生产 realm 导出写入项目。对于现有服务器，可据其差额由发布者使用 Admin API 创建副本并绑定 `resetCredentialsFlow`。
- 同文件 `createEmailCodeFixtureRealmPatch({policy?,emailTheme?})` 只为全新本机 `galaxy` realm 提供 26.7.3 默认 reset 树的测试配置，不用于覆盖现有服务器。短时配置可传 `{'code-ttl-seconds':'40','resend-seconds':'2','max-attempts':'5'}`；无需额外 Keycloak CLI 参数。
- JAR 由发布者放入目标 Keycloak 的 `providers/` 并按该版本正常构建/重启。主题必须同时提供下面的模板。保留原 provider/theme/flow 绑定供发布者按实际需要回退，不删除用户、客户端、账户映射或已有密码。

对于已有服务器，先安装 JAR 与登录/邮件主题、创建复制的 reset flow，保持 `email-code-enabled` 缺失或关闭；再选定已安装的 `emailTheme=galaxy-mail-editorial` 并绑定新 reset flow，最后合并 `VERIFY_EMAIL` 的三项策略及 `email-code-enabled=true`。不要在邮件主题可用之前启用该开关；reset 执行配置只需三项策略，不添加此 required-action 开关。回滚先按 checkpoint 原样恢复开关的存在性和值及三项策略，再恢复原 email theme/reset flow；确认恢复后才卸除 JAR/切回旧挂载。恢复失败时保留当前候选供重试，不能先卸除仍被绑定流程引用的 Provider。纯函数 plan 的最终表示和新建 fixture 会明确写入 `true`，现有服务器的分步安装仍按此顺序处理。

验证码默认 **6 位、600 秒、60 秒重发、每事务最多 5 次错误**。`code-ttl-seconds`（2–900）、`resend-seconds`（1–300）、`max-attempts`（1–10）分别可在 `VERIFY_EMAIL.config` 与该 reset 执行的 authenticator config 设置，短值用于本地到期测试。重发不重置错误次数；刷新页面不发新码。输入接受整码粘贴，服务器只接受六位 ASCII 数字（可去除空白）。不启用免密登录。

认证会话仍受 Keycloak 自身时限约束；验证码期限不会延长已过期的会话。验证码摘要、短期状态与已使用标记存在 Keycloak 的 `SingleUseObjectProvider`，原始码只在生成及邮件渲染调用中短暂使用。初始状态通过立即原子 `putIfAbsent` 占位及 `replace` 初始化，适配 26.7.3 的延迟 `put`，使同请求首发可读到已初始化的记录；UUID 竞争有限重试。随后以原子 `remove` 抢占，正确码只允许一次消费；错误次数、重发及使用标记通过原事务恢复。摘要绑定 realm、root session、tab、client、用途、当前账户及其当前邮箱；旧码、其他标签事务、其他浏览器事务或邮箱变更不能借用。重发会与旧盐/摘要比较候选数字，最多抽取 8 次以排除重复，失败不发送并继续作废旧码。对同收件对象的重发间隔也跨事务执行。

找回未知、禁用、无邮箱账户时仍显示相同的码页面和提示，不发送邮件、不创建账户、永远不能通过码验证；SMTP 失败也不以页面状态披露账户是否存在。邮件仍由 Keycloak 同步投递，已知地址的 SMTP 耗时与未知地址跳过投递可能不同；页面和时限一致不构成严格的时间侧信道抗枚举保证。有效码成功后才继续原有密码设置。注册创建/重复邮箱的原 Keycloak 校验保留，不将找回或重新输入邮箱接成注册创建。

本扩展不更改独立 `UPDATE_EMAIL`、管理端 execute-actions 或身份提供方绑定邮件的原流程；这些动作不被伪称为本次已接入的验证码能力。

## 主题合同

登录主题模板 `galaxy-email-code.ftl` 使用原 `url.loginAction`，不拼接 OAuth 返回地址。两个普通 POST 表单：

| 操作 | 字段 | 行为 |
|---|---|---|
| 验证 | `action=verify`、`code` | 服务端检查后继续原事务 |
| 重发 | `action=resend` | 服务端冷却，旧码失效 |
| 取消 | `action=cancel` | 取消当前认证，沿原协议返回发起者 |
| 重新输入邮箱 | `action=change-email`，仅找回页 | 作废并清除原 challenge，回 Choose User 明确输入一次；保留 SSO、原 client 与返回 |

模板属性：`galaxyCodePurpose=register|reset-password`、`galaxyCodeEmail`（注册仅遮盖邮箱，找回为空）、`galaxyCodeResendAfter`（秒）、`galaxyCodeExpiresIn`（秒）、`galaxyCodeBlocked`、`galaxyCodeCanResend`。CanResend 表示冷却结束后的能力，不能把冷却状态永久锁死。错误 key：`galaxyCodeInvalid` / `galaxyCodeExpired` / `galaxyCodeTooMany` / `galaxyCodeResendWait` / `galaxyCodeSendFailed` / `galaxyCodeUnavailable`。

`EmailTemplateProvider.send(subjectKey, "galaxy-email-code.ftl", attrs)` 读取 realm 实际选择的 email theme。需要 `email/html/galaxy-email-code.ftl` 与 `email/text/galaxy-email-code.ftl`；subject key 为 `galaxyEmailCodeSubjectRegister` / `galaxyEmailCodeSubjectReset`。attrs 为 `code`、`purpose`、`brand="AGI Galaxy"`、`expiresInSeconds`、`expiresInMinutes`。验证码只出现在邮件正文，不放邮件标题。中文与英文按 Keycloak 标准 `messages_zh_CN.properties`、`messages_en.properties`。

已选主题是“品牌信笺” `galaxy-mail-editorial`，正文品牌为 AGI Galaxy；账户发件身份为 `AGI Galaxy 账户 <account@agigalaxy.org>`，Reply-To 为 `team@agigalaxy.org`。邮件唯一布局源是 [`packages/galaxy-mail/src/layout.mjs`](../../../../packages/galaxy-mail/src/layout.mjs)，共用头尾供注册、重置、系统和服务邮件复用；正文后的系统邮件／联系说明在分隔线和末尾品牌区之前。旧 `email-designs/common/email-layout.mjs` 只是 re-export bridge。JAR 提供实际验证码数据，邮件主题与 SMTP 显示名由发布配置选择，不在 JAR 中维护另一套布局。

注册 required action 的取消使用 `context.failure()`，由 Keycloak 原 LoginProtocol 返回原应用的拒绝结果；`context.cancel()` 仅适用于 AIA，不能用它取消普通注册，否则未完成的邮箱动作会再次打开。取消不完成邮箱验证或密码设置，也不拼接返回网址。

## 本地真实操作路径

集中编译后，将 JAR 和本批登录/邮件主题放到任务专属 Keycloak 副本，使用全新 H2、合成 example.invalid 账户、literal loopback 回调和只在 RAM 收件的 loopback SMTP。初始状态、码、密码、邮件正文、Cookie 和 OAuth 参数不输出、不截图、不写日志。不得使用生产 SMTP、真实账户或远端测试容器。

实际路径为注册填邮箱→收码→原页面填整码→原密码设置→原 OIDC 回调；密码登录→原回调；找回填邮箱→码→新密码→原回调。必要异常合并覆盖错误/过期、冷却/重发旧码、两标签与无 Cookie、新旧账户、重复提交、取消/重新输入、SMTP 暂不可用和原返回保持。页面截图须在输入码前或清空后取得。未运行的路径不能写成通过。

上游依据：[26.7.3 VerifyEmail](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/requiredactions/VerifyEmail.java)、[26.7.3 ResetCredentialEmail](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/authenticators/resetcred/ResetCredentialEmail.java)、[26.7.3 SingleUseObjectProvider](https://github.com/keycloak/keycloak/blob/26.7.3/server-spi/src/main/java/org/keycloak/models/SingleUseObjectProvider.java)、[官方扩展与 provider 覆写](https://www.keycloak.org/docs/latest/server_development/#_auth_spi)。
