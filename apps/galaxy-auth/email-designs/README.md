# AGI Galaxy 邮件布局

用户已选择 B“精细账笺”及 AGI Galaxy 品牌，并要求保留头尾供其他银河邮件复用。A、C 保留为历史设计预览。正式主题为 `galaxy-mail-editorial`；模板交付不表示已经部署。正常登录继续使用密码；正式邮件码用于注册邮箱验证、找回密码。邮箱变更只提供历史设计预览，当前 Provider 合同未包含该用途。

| 方案 | HTML 预览 | 独立 Keycloak email theme |
|---|---|---|
| A 品牌简洁（历史） | [a-brand.html](a-brand.html) | `galaxy-mail-brand` |
| B 精细账笺（已选） | [b-editorial.html](b-editorial.html) | `galaxy-mail-editorial` |
| C 柔和服务（历史） | [c-service.html](c-service.html) | `galaxy-mail-service` |

品牌与署名采用 `AGI Galaxy`。发件人显示名由发件配置决定，正文品牌由 Provider 的 `brand` 提供，模板不自行修改发件配置。

## 预览调用

`render-email.mjs` 为浏览器和 Node 都可直接导入的纯模块：

```js
import {renderEmailPreview, EMAIL_DESIGNS, EMAIL_SCENARIOS, SENDER_NAME_CHOICES} from './render-email.mjs';
const email = renderEmailPreview({
  design: 'b', // 已选 B；a、c 可用于回看历史候选
  scenario: 'register', // register | reset-password | system | service
  senderName: 'AGI Galaxy',
});
// {html, text, subject, senderName, design, scenario, preview: true}
```

预览仅使用固定示例码 `482913` 和示例有效期，并明确标示预览，不接收真实验证码。已选 B 另有 [系统通知](b-editorial-system.html) 与 [服务通知](b-editorial-service.html) 的中性内容样例，不虚构个人请求、服务变更或运行结果。两类通知没有验证码块或验证码防误用提示。默认文件为注册场景，其他文件加用途后缀；`change-email` 仅保留原设计预览。TXT 使用真实 LF 换行，正式纯文本 FTL 也直接保留段落换行。

需要更新预览文件时，在本目录执行 `node write-previews.mjs`；仅重新产出纯文本用 `node write-previews.mjs --text-only`。这两个入口只写固定示例文件，不发送邮件。

## 正式模板合同

已与认证实现确认调用：`EmailTemplateProvider.send(subjectKey, 'galaxy-email-code.ftl', attrs)`。

| 字段 | 含义 |
|---|---|
| `code` | 真实六位验证码字符串，仅在内存及邮件正文渲染中使用，保留前导零 |
| `purpose` | `register` 或 `reset-password` |
| `expiresInMinutes` | 实际有效分钟数，Provider 默认 10，按当前策略计算 |
| `expiresInSeconds` | 实际有效秒数，Provider 默认 600；模板显示分钟数 |
| `brand` | 当前为 `AGI Galaxy` |

注册 subject key 为 `galaxyEmailCodeSubjectRegister`，找回密码为 `galaxyEmailCodeSubjectReset`。验证码不进入标题。realm 默认语言为 `zh-CN`，支持 `zh-CN` 与 `en`；按 Keycloak 约定分别使用 `messages_zh_CN.properties`、`messages_en.properties`。

正式模板位于 `../theme/galaxy-mail-editorial/email/`，包含 HTML/text 公共 `template.ftl`、导入公共壳的 `galaxy-email-code.ftl`、两个语言包和默认纯文本事件的薄包装。HTML 自动转义变量，使用表格和内联样式；不请求外部资源、不依赖图片。验证码正文没有确认链接。主题继承 `keycloak`，原系统事件内容与参数继续按 Keycloak 处理。

## 同一头尾与正文插槽

唯一布局源为共享包 [`packages/galaxy-mail/src/layout.mjs`](../../../packages/galaxy-mail/src/layout.mjs)。B 预览、普通通知渲染和正式 FreeMarker 模板均消费此源，注册、重置、系统通知和服务邮件复用同一品牌头尾与排版。旧 [`common/email-layout.mjs`](common/email-layout.mjs) 仅作 re-export bridge，不是第二份布局实现。公共头尾只包含 AGI Galaxy、用途栏目和域名；标题、段落、验证码及对应提醒属于正文。

本目录中的模块可直接导入共享包的纯文本参数渲染器，生成普通系统/服务内容，无传输或存储副作用：

```js
import {renderGalaxyEmail} from '../../../packages/galaxy-mail/src/layout.mjs';
const email = renderGalaxyEmail({
  subject, title,
  paragraphs: ['由实际业务提供的正文'],
  category: '服务通知',
  brand: 'AGI Galaxy',
  language: 'zh-CN', // 或 en，正文由调用方提供对应语言
  preheader: '',
  note: '',
});
// {subject, html, text}；全部正文文本经过 HTML 转义，无发送器或队列
```

`renderEmailLayout({bodyHtml,bodyText,...})` 另提供受信任正文模板的插槽；原始用户文字使用上面的 `renderGalaxyEmail`，不直接作为 `bodyHtml`。当前实际出站邮件仍由 Keycloak 发送，没有新增其他传输服务。

已实际读取本地 `org.keycloak.keycloak-themes-26.7.3.jar`：base HTML `template.ftl` 的合同是无参数 `emailLayout` 包含 `<#nested>`。本主题保留无参兼容，同时支持 `title`、`category`、`preheader`、`brandName` 可选参数：

```ftl
<#import "template.ftl" as layout>
<@layout.emailLayout title=title category=category>
  ...正文...
</@layout.emailLayout>
```

Keycloak 26.7.3 的默认 HTML 事件本身导入该宏，可直接复用。其 base 没有 text `template.ftl`，默认纯文本事件直接调用消息函数；本主题为这些纯文本模板加相同宏包装，保留原消息键、参数与条件，不把新增宏误当已经自动接入。码模板只提供中间注册/找回正文；普通事件不附加验证码提示。

## 构建复制路径

当前认证构建只收录已选 `galaxy-mail-editorial`。`apps/galaxy-auth/build.mjs` 直接从共享包取得四份 FTL，复制主题后写入产物；A、C 仅留作设计参考：

```js
import {keycloakEmailThemeTemplates} from '../../packages/galaxy-mail/src/layout.mjs';
await copyTree('theme/galaxy-mail-editorial/email', 'themes/galaxy-mail-editorial/email');
for (const [name, source] of Object.entries(keycloakEmailThemeTemplates())) {
  await write('themes/galaxy-mail-editorial/email/' + name, source);
}
```

准确复制路径为 `apps/galaxy-auth/theme/galaxy-mail-editorial/email/` → `<auth-output>/themes/galaxy-mail-editorial/email/`。`keycloakEmailThemeTemplates()` 返回 `html/template.ftl`、`text/template.ftl`、`html/galaxy-email-code.ftl`、`text/galaxy-email-code.ftl` 四项；`keycloakEmailLayoutTemplates()` 可单独取得公共壳。

源码中的四份 FTL 是同源生成产物；需要刷新源码文件时可用本目录 `write-shared-templates.mjs`。构建仍直接调用同一导出，避免依赖人工刷新。邮件目录沿既有只读 themes 挂载提供给 Keycloak，realm 的 `emailTheme` 使用已选 `galaxy-mail-editorial`，`loginTheme=galaxy` 保持。

选定的共用主题已完成两语言、两用途、HTML/纯文本的 8 个验证码渲染组合，以及 104 个既有 Keycloak 邮件模板组合；共用预览在 320 与 736 宽度检查注册、找回、系统和服务四个场景。三款早期候选另保留原 24 个渲染组合的历史结果。渲染检查不发送邮件，真实 Provider、浏览器流程、SMTP 与发布观察分别保留在项目运行记录中。
