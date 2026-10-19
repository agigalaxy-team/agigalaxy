# 银河认证页面

本目录提供 `auth.agigalaxy.org` 的静态入口和 Keycloak `galaxy` 登录主题，针对实际运行的 **Keycloak 26.7.3**。主题继承该版本的表单、校验和认证状态，替换共同外壳、布局、样式及相关说明。升级 Keycloak 时，留意 `src/head.ftl` 与上游 `template.ftl` 的变化，检查受影响的表单。

认证站负责官方线上账户的登录、注册、邮箱确认、密码设置及找回。直接访问入口后回官网账户中心；从银河账户关联进入时继续原有关联事务。银河 ID 由已安装的本地银河客户端插件创建，关联由当前设备的插件接洽。一个官方账户可关联多个 ID，身份、历史和控制权分别保留。图中的第三方 Hub 只解释可选关系，此站没有第三方接入管理。

## 源码与构建

- `src/layout.html`：静态入口与真实 Keycloak 页面共用的顶栏、固定顶级侧栏、关系图与说明。
- `src/head.ftl`、`src/form.ftl`：主题宏。保留 Keycloak 会话检查、原生表单 action、隐藏字段、错误及可选认证入口。
- `shared/`：样式、表单渐进增强与原始轨道品牌 SVG。品牌取自现行官网原始资产，不用生成近似图代替。
- `theme/galaxy/login/`：主题继承、中文与英文文案。
- `client-contract.json`：独立官方账户登录的公开客户端契约，不含凭据。

在仓库根目录使用已经配置的 Node.js，无需为本目录新增依赖：

```sh
node apps/galaxy-auth/build.mjs --out /absolute/new/galaxy-auth-release
```

输出目录必须新建或为空。构建器不清空已有目录。产物为 `themes/galaxy/login/`、`site/` 与逐文件 SHA-256 的 `manifest.json`。主题与静态入口不包含注册用户、邮件、会话 Cookie、OAuth 请求内容或账户凭据。用任意仅监听 loopback 的静态服务器查看 `site/` 只能核对入口布局；真实表单必须在隔离 Keycloak 中验证。

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

原 `galaxy-official` 客户端和身份签名关联接口继续处理既有事务。账户登录成功后，关联仍需当前设备的插件完成本机确认；官方账户 Cookie 不代替 subject Bearer、设备授权或签名。

## 部署顺序与回滚

由拥有本次发布职责的执行者操作生产，主题构建脚本不执行发布。

1. 确认目标 Keycloak 版本、realm 与现有路由。主题更新保留数据库、账户、凭据、注册策略及已有客户端。
2. 构建到新的版本目录，将 `themes/galaxy` 作为只读主题目录交给相同版本的 Keycloak；保留前一主题目录与先前 `loginTheme` 值，不编辑镜像中的内置主题。
3. 先发布服务器官方账户会话接口及其受保护配置；再精确登记 `client-contract.json` 中的新客户端。新客户端只服务独立官方账户登录，原关联客户端不改。
4. 仅为目标 `galaxy` realm 选择 `loginTheme=galaxy`。保留现有注册、找回、邮箱确认、密码和安全策略。不要把主题设置扩散到 master realm 或管理控制台。
5. 将 `site/` 发布到新的静态版本目录。auth 域名已存在的 `/realms/galaxy`、`/realms/galaxy/*` 和 `/resources/*` 继续反代原 Keycloak。为剩余请求增加静态根目录和 `file_server`；找不到的路径返回 404，不把任意路径改写成成功首页。
6. 将下列响应头仅用于静态入口分支；Keycloak 响应继续采用自己的 CSP 与认证头。先验证 Caddy 配置，再原子切换发布指针并 reload。
7. 用隔离合成账户检查受影响的登录、注册、找回或关联流程，发布后确认入口及返回路径可用。生产写入和外部邮件使用实际获准的数据范围。

静态入口响应头建议：

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

若验证失败，切回前一静态发布目录与先前 realm `loginTheme` 值。账户数据与既有客户端不属于主题回滚内容。保留新客户端或停用它，应由发布者按仍在使用的服务端会话接口状态协调，不删除其他客户端。

## AI-agent 操作说明

从项目资产路由与已核实 SSH helper 发现部署目标；仅沿凭据引用读取完成操作必需的信息，原始秘密不进入 workspace、命令参数、输出或报告。生产写入与隔离测试分开记录。

本地表单检查可使用相同 Keycloak 版本的临时实例、合成账户和临时邮件接收器。按改动检查相关表单；涉及布局时再查看窄屏和键盘操作。浏览器使用独立无头进程与临时会话，不使用用户浏览器、CDP 或 profile。

静态入口用于查看布局；登录和关联问题沿实际 API、官网及本机插件的相应流程定位。调试记录只保存所需结果，不保存 Cookie、邮件 token、authorization code、state、nonce、verifier 或用户密码。

测试后只清理本次创建的临时容器和文件，使用准确名称与路径。

上游主题使用方法见 [Keycloak themes](https://www.keycloak.org/ui-customization/themes)。本主题源头及改动说明见 `NOTICE`；上游许可副本见 `licenses/KEYCLOAK-APACHE-2.0.txt`。
