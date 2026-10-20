# @galaxy/mail

银河邮件的唯一共享展示源 [`src/layout.mjs`](src/layout.mjs)，采用用户已选定的第二款 B“精细账笺”和 AGI Galaxy 品牌。对应 Keycloak email theme 为 `galaxy-mail-editorial`。注册、重置、系统通知和服务邮件复用同一品牌头尾与排版，各自提供正文；模块同时供 HTML / 纯文本预览、普通通知渲染和 Keycloak 邮件主题生成使用，不发送邮件，也不保存内容。

| API | 用途与返回值 |
| --- | --- |
| `renderGalaxyEmail({subject, title, paragraphs, note?, category?, brand?, language?, preheader?})` | 普通文本内容自动转义，返回 `{subject, html, text}`。 |
| `renderCodeEmail({title, introduction, instruction, code, expiry, continuation, safety, codeLabel?, category?, brand?, language?, preheader?})` | 在同一头尾内渲染验证码正文，返回 `{html, text}`；验证码由调用者传入。 |
| `renderEmailLayout({bodyHtml, bodyText, brand?, category?, title?, preheader?, language?})` | 可信 HTML 正文插槽，返回 `{html, text}`；普通用户文本应使用 `renderGalaxyEmail`。 |
| `keycloakEmailThemeTemplates()` | 构建时返回路径到 FTL 内容的映射：`html/template.ftl`、`text/template.ftl`、`html/galaxy-email-code.ftl`、`text/galaxy-email-code.ftl`。 |
| `keycloakEmailLayoutTemplates()` / `keycloakEmailCodeTemplates()` | 分别返回布局或验证码正文的 `{html, text}` FTL 源。 |

另导出 `EMAIL_FONT`、`EMAIL_MONO` 和 `escapeEmailText`。默认品牌为 `AGI Galaxy`，默认语言为 `zh-CN`。正式验证码模板仅接受 `register` / `reset-password` 两种目的。

仓库内构建器可直接导入 `packages/galaxy-mail/src/layout.mjs`；包被解析为依赖时使用 `@galaxy/mail`。旧 `apps/galaxy-auth/email-designs/common/email-layout.mjs` 仅保留 re-export，布局维护在本包这一处。

布局渲染不启用认证流程。正常登录仍用密码，验证码参数与注册验证码默认关闭的启用开关由[认证扩展](../../apps/galaxy-auth/providers/email-code/README.md)处理；本包存在不表示主题或 Provider 已部署。
