# @galaxy/mail

银河邮件的唯一共享展示源 [`src/layout.mjs`](src/layout.mjs)，采用用户选定的“清晰标准整体＋居中官方落款”和 AGI Galaxy 品牌。对应 Keycloak email theme 仍为 `galaxy-mail-editorial`。注册、重置密码、系统通知和服务邮件复用同一品牌头尾与排版，各自提供正文；模块同时供 HTML / 纯文本预览、普通通知渲染和 Keycloak 邮件主题生成使用，不发送邮件，也不保存内容。

`src/layout.mjs` 是稳定的公共导出，实际实现按用途分开：[`rendering/common.mjs`](src/rendering/common.mjs) 定义转义、字体、标签和正文构件；[`rendering/frame.mjs`](src/rendering/frame.mjs) 生成唯一 HTML／纯文本信笺框架；[`rendering/messages.mjs`](src/rendering/messages.mjs) 接收普通通知与验证码内容；[`keycloak/templates.mjs`](src/keycloak/templates.mjs) 将同一框架生成为 Keycloak FTL。模板生成器不维护第二份头尾，业务渲染器也不依赖认证主题。构建或发布邮件包时须包括这些被公共导出引用的实现文件。

布局使用白底细框、原轨道Logo与品牌横排、淡粉分隔线和左对齐无衬线标题；标题桌面24px、手机22px，正文15px，辅助说明12px，官方落款11.5px。验证码在浅粉横带中保持单个连续文本节点，有效期排在其下方；邮件不包含脚本或复制按钮。普通通知复用头尾，不附带验证码专属提醒。图片未加载时，可见文字品牌、正文和官方链接仍保留。

正文之后是左对齐的回复／联系说明，随后以细线分隔官方落款；底部第一行居中“关于银河 · 隐私 · 使用说明”，第二行居中“© 当年 AGI Galaxy”。年份由渲染时取得，Keycloak宏使用实际渲染年份。三项分别指向现有的`/how-it-works/`、`/privacy/`、`/docs/`，不把未设立的条款页或空链接放进正式邮件。自动邮件说明“系统邮件，请勿直接回复。”并给出 `team@agigalaxy.org`；人工团队邮件使用 `automated: false`，改为“如需继续沟通，可直接回复本邮件。”。HTML、纯文本及生成的 Keycloak 宏使用同一信息顺序，不把联系说明追加到官方落款之后。

发件身份由 [`src/identities.mjs`](src/identities.mjs) 的 `officialMailIdentity(purpose)` 返回公开元数据，传输服务负责实际使用 From、Reply-To；渲染器不自行发送邮件：

| purpose | 显示名 | From | automated |
| --- | --- | --- | --- |
| `account` | AGI Galaxy 账户 | `account@agigalaxy.org` | true |
| `notice` | AGI Galaxy 通知 | `notice@agigalaxy.org` | true |
| `community` | AGI Galaxy 社区 | `community@agigalaxy.org` | true |
| `updates` | AGI Galaxy 更新 | `updates@agigalaxy.org` | true |
| `team` | AGI Galaxy 团队 | `team@agigalaxy.org` | false |

五类 Reply-To 都为 `team@agigalaxy.org`；前四类没有收信邮箱／转发别名。Return-Path 与正常回复分别配置。身份表存在不代表每种业务发送流程已实现。

| API | 用途与返回值 |
| --- | --- |
| `renderGalaxyEmail({subject, title, paragraphs, note?, category?, brand?, language?, preheader?, automated?})` | 普通文本内容自动转义，返回 `{subject, html, text}`；`automated` 默认 true。 |
| `renderCodeEmail({title, introduction, instruction, code, expiry, safety, continuation?, codeLabel?, category?, brand?, language?, preheader?})` | 在同一头尾内渲染验证码正文，返回 `{html, text}`；验证码及有效期由调用者传入。`continuation` 为可选正文，正式验证码模板不生成额外继续说明。 |
| `renderEmailLayout({bodyHtml, bodyText, brand?, category?, title?, preheader?, language?, automated?})` | 可信 HTML 正文插槽，返回 `{html, text}`；普通用户文本应使用 `renderGalaxyEmail`。 |
| `keycloakEmailThemeTemplates()` | 构建时返回路径到 FTL 内容的映射：`html/template.ftl`、`text/template.ftl`、`html/galaxy-email-code.ftl`、`text/galaxy-email-code.ftl`。 |
| `keycloakEmailLayoutTemplates()` / `keycloakEmailCodeTemplates()` | 分别返回布局或验证码正文的 `{html, text}` FTL 源。 |

另导出 `EMAIL_FONT`、`EMAIL_MONO`、`EMAIL_LOGO_URL` 和 `escapeEmailText`。默认品牌为 `AGI Galaxy`，默认语言为 `zh-CN`；`language: 'en'` 使用英文默认类别、验证码标签和隐私链接名称，调用者提供相应语言的实际正文。普通文本字段按HTML转义，`bodyHtml` 仅接收可信模板内容。HTML与纯文本均保留实际用途、验证码、有效期和完整官网/隐私链接。

正式验证码模板仅接受 `register` / `reset-password` 两种目的，继续使用真实 `code`、`expiresInMinutes` 和 `brand` 参数。共用FTL宏兼容现有无参数的 `emailLayout` 调用。主题语言包需包含 `galaxyMailAbout`、`galaxyMailPrivacy`、`galaxyMailGuide`、`galaxyMailAutomatedNotice`、`galaxyMailContactTeam`、`galaxyEmailCodeSafetyRegister` 与 `galaxyEmailCodeSafetyReset`；用途说明及提示由主题语言包提供，不把预览示例值写进正式模板。

原GalaxyMark的96px PNG保存在 [`assets/galaxy-mail-logo.png`](assets/galaxy-mail-logo.png)，邮件显示尺寸27px。构建器将该文件复制到认证站静态 `assets/img/galaxy-mail-logo.png`，正式引用 `https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020`。图片URL固定，不携带收件人、验证码或追踪参数。

仓库内构建器可直接导入 `packages/galaxy-mail/src/layout.mjs`；包被解析为依赖时使用 `@galaxy/mail`。旧 `apps/galaxy-auth/email-designs/common/email-layout.mjs` 仅保留 re-export，布局维护在本包这一处。

布局渲染不启用认证流程。正常登录仍用密码，验证码参数与注册验证码默认关闭的启用开关由[认证扩展](../../apps/galaxy-auth/providers/email-code/README.md)处理；本包存在不表示主题或 Provider 已部署。

2026-10-22 的布局调整实际阅读了 [Postmark 密码重置模板](https://github.com/ActiveCampaign/postmark-templates/blob/fa73527acb4eb59cf673a54572d213e908f1515c/templates/basic-full/password-reset/content.html)与 [React Email 验证码示例](https://github.com/resend/react-email/blob/e0561e164e9c28859d24373804e30b364931ee77/apps/demo/emails/Community/magic-links/linear-login-code.tsx)，借鉴正文帮助与末尾品牌分区的结构；没有复制其业务字段、文案、外链字体或增加运行依赖，银河仍使用这一份共享布局。
