# 银河认证页面

本目录提供 `auth.agigalaxy.org` 的静态入口和 Keycloak `galaxy` 登录主题，针对实际运行的 **Keycloak 26.7.3**。主题继承该版本的表单、校验和认证状态，替换共同外壳、布局、样式及相关说明。升级 Keycloak 时同步处理 `src/head.ftl` 与上游 `template.ftl` 的变化。

认证站负责官方线上账户的登录、注册、邮箱确认、密码设置及找回。直接访问入口后回官网账户中心；从银河账户关联进入时继续原有关联事务。银河 ID 由已安装的本地银河客户端插件创建，关联由当前设备的插件接洽。一个官方账户可关联多个 ID，身份、历史和控制权分别保留。认证表单不承载身份架构讲解；具体关联关系在官网相应操作中呈现。

## 源码与构建

- `../../packages/galaxy-web/src/site-chrome.mjs`：官网、公开页与认证页直接调用的顶栏、六项导航、搜索、图标与品牌。构建时用 ReactDOMServer 输出认证外壳，不加载网页业务运行时。
- `src/layout.html`：静态入口与真实 Keycloak 页面共用的认证内容区，保留语言选择、表单位置与页脚。
- `src/head.ftl`、`src/form.ftl`：主题宏。保留 Keycloak 会话检查、原生表单 action、隐藏字段、错误及可选认证入口。
- `shared/`：认证表单布局与提交等待的渐进增强。字体、主题、顶栏与响应式导航直接取共用 `site-foundation.css` 和 `selected-shell.css`；品牌与等待图标从共用 `GalaxyMark` 输出，不维护第二套 SVG。
- `theme/galaxy/login/`：主题继承、中文与英文文案。
- `providers/email-code/`：Keycloak 26.7.3 邮件验证码扩展及保留原密码动作的找回流程规划器；包含显式重填邮箱时的账户选择适配。
- `theme/galaxy-mail-editorial/email/`：用户选定的“精细账笺”中文、英文邮件主题，HTML 与纯文本共用品牌头尾。其余两款仅保留设计参考。
- `email-designs/`：三款邮件的静态设计预览；其中固定示例码不用于正式模板。
- `client-contract.json`：独立官方账户登录的公开客户端契约，不含凭据。

在仓库根目录使用已经配置的 Node.js，无需为本目录新增依赖：

```sh
node apps/galaxy-auth/build.mjs --out /absolute/new/galaxy-auth-release
```

输出目录必须新建或为空。构建器不清空已有目录。产物为 `themes/galaxy/login/`、已选择的 `themes/galaxy-mail-editorial/email/`、`site/` 与记录文件路径、大小的 `manifest.json`。唯一邮件布局源为共享包 [`packages/galaxy-mail/src/layout.mjs`](../../packages/galaxy-mail/src/layout.mjs)：注册、重置、系统通知和服务邮件复用同一品牌头尾与排版，各自提供正文。`email-designs/common/email-layout.mjs` 只是该模块的 re-export bridge，不维护第二套布局。构建不会自动启用服务器的新认证流程。主题与静态入口不包含注册用户、邮件、会话 Cookie、OAuth 请求内容或账户凭据。`site/` 可由静态服务器呈现；登录表单由 Keycloak 会话和原生 action 驱动。

邮件验证码扩展按[扩展说明](providers/email-code/README.md)单独离线编译。需要完整验证码候选时，在上述构建命令加 `--provider-jar /absolute/provider-candidate/galaxy-email-code-26.7.3.jar`。构建器将它复制到 `providers/galaxy-email-code.jar` 并记录 SHA-256；不自动安装到认证服务器。

构建会为样式、脚本、品牌图片及样式和脚本的相对依赖添加同一内容版本链接，更新后不继续使用认证服务器长缓存中的旧资源。

顶栏搜索调用与官网共用的 `site-search.mjs`，认证产物以 `.js` 扩展名提供同一 ESM 内容，适配 Keycloak 的 JavaScript 媒体类型。搜索只将文字带到固定官网搜索页，不转递当前认证地址的参数。认证提交的等待反馈只绑定内容区内的 Keycloak 表单。顶栏、导航和搜索不需要加载官网的账户或身份运行时；Keycloak 表单与会话检查沿原流程执行。

## 官方账户接续契约

入口使用普通链接，无浏览器 OIDC SDK、令牌存储或浏览器完成页：

| 动作 | 固定导航目标 |
|---|---|
| 登录 | `https://official.agigalaxy.org/v1/account/login?mode=login` |
| 注册 | `https://official.agigalaxy.org/v1/account/login?mode=register` |
| 官方账户回调 | `https://official.agigalaxy.org/v1/account/callback` |
| 默认完成落点 | `https://agigalaxy.org/app/account` |

API 服务器管理 state、nonce、S256 verifier、代码交换、签名校验与 HttpOnly 账户会话，令牌不传给网站。`client-contract.json` 对应独立 public client `galaxy-account-entry`，不启用 implicit、password grant、service account 或 API 权限。生产回调只能精确登记上表 API 地址，不能登记旧的 `auth/complete` 或通配符。若使用可选 `returnTo`，由 API 严格约束到官网 `/app/` 路径；认证入口本身不接受任意外部返回地址。

当前官方账户会话在 API 进程内保留一小时，进程重启后需重新登录。官网退出清理该官网会话；Keycloak SSO 会话继续由认证服务器管理。因此再次点击登录可能直接接回仍有效的 SSO，这不能表述为已实现全局账户登出。

`mode=register` 保留一次授权请求的全部参数，只将同 issuer 的 `/protocol/openid-connect/auth` 路径改为 `/protocol/openid-connect/registrations`。这条路径已在真实 26.7.3 隔离实例完成邮件确认与密码设置。当前 realm 的 `verifyEmail=true` 对应先确认邮箱再设置密码，注册首屏不出现密码是该流程的正常行为，主题不得绕过该要求。

本批邮件验证码候选保留正常密码登录。启用后，注册/未验证邮箱的 `VERIFY_EMAIL` 和找回密码的发邮件步骤使用六位一次性邮件码，默认有效期 **600 秒、60 秒重发、每事务最多 5 次错误**。验证码在原认证页面输入，随后继续原密码设置与 OIDC 返回；不会以点击邮件链接代替输入验证码。后端保留过期、限次、重发后旧码作废和一次消费检查，前端倒计时只帮助显示。

扩展默认不启用注册验证码：只有 `galaxy` realm 的 `VERIFY_EMAIL.config` 中 `email-code-enabled` 精确为字符串 `true` 时才启用，缺失、关闭或其他值沿用原 Keycloak 实现。新流程需要同时安装扩展、提供登录与邮件模板，并为目标 realm 选择相应流程及邮件主题；仅部署 CSS 或静态页面不会启用它。正常密码登录的 browser flow 不属于本次替换范围。邮箱变更等其他事件的模板预览不代表其后端已接入数字验证码。

用户已选择第二款“精细账笺” `galaxy-mail-editorial` 与 AGI Galaxy 发件人/署名。部署者按下述顺序安装、验证和回退；具体服务器状态与观察范围保留在项目发行指针及运行记录中。

原 `galaxy-official` 客户端和身份签名关联接口继续处理既有事务。账户登录成功后，关联仍需当前设备的插件完成本机确认；官方账户 Cookie 不代替 subject Bearer、设备授权或签名。

## 部署顺序与回滚

由拥有本次发布职责的执行者操作生产，主题构建脚本不执行发布。

下面六步说明首次建立静态认证入口和独立账户客户端时的配置。已有这些入口的邮件验证码更新保留原客户端、browser flow、数据库和安全策略；新 JAR 与主题可用后，先选择 `emailTheme=galaxy-mail-editorial`、绑定复制后的 reset flow，最后合并 `VERIFY_EMAIL` 的三项策略及 `email-code-enabled=true`。具体执行与恢复顺序见[验证码扩展说明](providers/email-code/README.md)。

1. 确认目标 Keycloak 版本、realm 与现有路由。主题更新保留数据库、账户、凭据、注册策略及已有客户端。
2. 构建到新的版本目录，将 `themes/galaxy` 作为只读主题目录交给相同版本的 Keycloak；保留前一主题目录与先前 `loginTheme` 值，不编辑镜像中的内置主题。
3. 先发布服务器官方账户会话接口及其受保护配置；再精确登记 `client-contract.json` 中的新客户端。新客户端只服务独立官方账户登录，原关联客户端不改。新客户端的固定 `baseUrl` 为官网账户中心，供原生错误页面返回；不开放任意外部返回地址。
4. 仅为目标 `galaxy` realm 选择 `loginTheme=galaxy`。保留现有注册、找回、邮箱确认、密码和安全策略。不要把主题设置扩散到 master realm 或管理控制台。
5. 将 `site/` 发布到新的静态版本目录。auth 域名已存在的 `/realms/galaxy`、`/realms/galaxy/*` 和 `/resources/*` 继续反代原 Keycloak。为剩余请求增加静态根目录和 `file_server`；找不到的路径返回 404，不把任意路径改写成成功首页。
6. 将下列响应头仅用于静态入口分支；Keycloak 响应继续采用自己的 CSP 与认证头。原子切换发布指针并 reload。

静态入口响应头建议：

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

仅更新静态页或登录主题时，故障回退为前一静态发布目录与先前 realm `loginTheme` 值。涉及邮件验证码扩展时，先按 checkpoint 恢复启用开关和策略，再恢复原 email theme/reset flow，确认恢复后才能撤下 JAR 或切回旧挂载；恢复失败时保留当前候选供重试。账户数据与既有客户端不属于主题回滚内容。

## AI-agent 操作说明

部署目标和凭据引用从实际配置及项目资产路由取得；原始秘密不进入 workspace、命令参数、输出或报告。生产写入和外部邮件使用实际获准的数据范围，调试记录不保存 Cookie、邮件 token、authorization code、state、nonce、verifier 或用户密码。

开发方法见[项目工作规则](../../../../../02-architecture/current/WORK_RULES.md)，工具入口见[开发检查参考](../../docs/development-checks.md)。

上游主题使用方法见 [Keycloak themes](https://www.keycloak.org/ui-customization/themes)。本主题源头及改动说明见 `NOTICE`；上游许可副本见 `licenses/KEYCLOAK-APACHE-2.0.txt`。
