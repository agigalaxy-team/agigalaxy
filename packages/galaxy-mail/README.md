# @galaxy/mail

银河邮件的唯一共享展示源 [`src/layout.mjs`](src/layout.mjs)，采用用户最新选定的“品牌信笺”和 AGI Galaxy 品牌。对应 Keycloak email theme 仍为 `galaxy-mail-editorial`。注册、重置密码、系统通知和服务邮件复用同一品牌头尾与排版，各自提供正文；模块同时供 HTML / 纯文本预览、普通通知渲染和 Keycloak 邮件主题生成使用，不发送邮件，也不保存内容。

布局使用白底细框、原轨道Logo与品牌横排、淡粉分隔线和左对齐衬线标题。验证码在浅粉横带中保持单个连续文本节点，有效期排在其下方；邮件不包含脚本或复制按钮。普通通知复用头尾，不附带验证码专属提醒。图片未加载时，可见文字品牌、正文和官网/隐私链接仍保留。

| API | 用途与返回值 |
| --- | --- |
| `renderGalaxyEmail({subject, title, paragraphs, note?, category?, brand?, language?, preheader?})` | 普通文本内容自动转义，返回 `{subject, html, text}`。 |
| `renderCodeEmail({title, introduction, instruction, code, expiry, safety, continuation?, codeLabel?, category?, brand?, language?, preheader?})` | 在同一头尾内渲染验证码正文，返回 `{html, text}`；验证码及有效期由调用者传入。`continuation` 为可选正文，正式验证码模板不生成额外继续说明。 |
| `renderEmailLayout({bodyHtml, bodyText, brand?, category?, title?, preheader?, language?})` | 可信 HTML 正文插槽，返回 `{html, text}`；普通用户文本应使用 `renderGalaxyEmail`。 |
| `keycloakEmailThemeTemplates()` | 构建时返回路径到 FTL 内容的映射：`html/template.ftl`、`text/template.ftl`、`html/galaxy-email-code.ftl`、`text/galaxy-email-code.ftl`。 |
| `keycloakEmailLayoutTemplates()` / `keycloakEmailCodeTemplates()` | 分别返回布局或验证码正文的 `{html, text}` FTL 源。 |

另导出 `EMAIL_FONT`、`EMAIL_MONO`、`EMAIL_LOGO_URL` 和 `escapeEmailText`。默认品牌为 `AGI Galaxy`，默认语言为 `zh-CN`；`language: 'en'` 使用英文默认类别、验证码标签和隐私链接名称，调用者提供相应语言的实际正文。普通文本字段按HTML转义，`bodyHtml` 仅接收可信模板内容。HTML与纯文本均保留实际用途、验证码、有效期和完整官网/隐私链接。

正式验证码模板仅接受 `register` / `reset-password` 两种目的，继续使用真实 `code`、`expiresInMinutes` 和 `brand` 参数。共用FTL宏兼容现有无参数的 `emailLayout` 调用。主题语言包需包含 `galaxyMailPrivacy`、`galaxyEmailCodeSafetyRegister` 与 `galaxyEmailCodeSafetyReset`；用途说明及提示由主题语言包提供，不把预览示例值写进正式模板。

原GalaxyMark的96px PNG保存在 [`assets/galaxy-mail-logo.png`](assets/galaxy-mail-logo.png)，邮件显示尺寸32px。构建器将该文件复制到认证站静态 `assets/img/galaxy-mail-logo.png`，正式引用 `https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020`。图片URL固定，不携带收件人、验证码或追踪参数。

仓库内构建器可直接导入 `packages/galaxy-mail/src/layout.mjs`；包被解析为依赖时使用 `@galaxy/mail`。旧 `apps/galaxy-auth/email-designs/common/email-layout.mjs` 仅保留 re-export，布局维护在本包这一处。

布局渲染不启用认证流程。正常登录仍用密码，验证码参数与注册验证码默认关闭的启用开关由[认证扩展](../../apps/galaxy-auth/providers/email-code/README.md)处理；本包存在不表示主题或 Provider 已部署。
