// The selected brand letterhead is shared by previews, ordinary message renderers and
// the generated Keycloak templates. This module has no transport or storage.
export const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif";
export const EMAIL_MONO = "'SFMono-Regular',Consolas,'Liberation Mono',monospace";
export const EMAIL_LOGO_URL = 'https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020';
export const escapeEmailText = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const table = (content, style = '', attributes = '') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${attributes} style="border-collapse:collapse;${style}">\n${content}\n</table>`;
const row = (content, style = '', attributes = '') => `<tr><td${attributes} style="${style}">${content}</td></tr>`;
const paragraph = (html, style = '') => `<p style="margin:0;font-family:${EMAIL_FONT};font-size:15px;line-height:25px;color:#495363;${style}">${html}</p>`;
const heading = html => `<h1 class="galaxy-mail-title" style="margin:0;font-family:Georgia,'Songti SC','SimSun',serif;font-size:27px;line-height:39px;font-weight:500;letter-spacing:-.4px;color:#202735;">${html}</h1>`;
const emailLabels = language => String(language).toLowerCase().startsWith('en')
  ? {category: 'Notification', accountCategory: 'Account services', code: 'Verification code', privacy: 'Privacy and data'}
  : {category: '通知', accountCategory: '账户服务', code: '验证码', privacy: '隐私与数据'};
const responsiveStyles = `@media only screen and (max-width:480px){
  .galaxy-mail-outer{padding:20px 8px 32px!important}
  .galaxy-mail-paper{padding:26px 22px!important}
  .galaxy-mail-brand{font-size:17px!important}
  .galaxy-mail-mark{padding-right:9px!important}
  .galaxy-mail-category{max-width:60px!important;padding-left:8px!important}
  .galaxy-mail-title{font-size:25px!important;line-height:36px!important}
  .galaxy-mail-code-cell{padding:17px!important}
}`;

// All values here are escaped by the public renderer or are controlled FTL
// expressions produced below. The content slot is not an untrusted HTML input.
function htmlLayout({language, direction, brand, category, title, preheader, body, privacyLabel}) {
  const wordmark = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td class="galaxy-mail-mark" width="32" style="padding-right:11px;vertical-align:middle;"><img src="${EMAIL_LOGO_URL}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0;outline:none;text-decoration:none;"></td><td class="galaxy-mail-brand" style="font-family:${EMAIL_FONT};font-size:18px;line-height:28px;font-weight:600;letter-spacing:-.3px;color:#202735;white-space:nowrap;vertical-align:middle;">${brand}</td></tr></table>`;
  const header = table(`<tr><td style="padding-bottom:21px;vertical-align:middle;">${wordmark}</td><td class="galaxy-mail-category" align="right" style="padding:0 0 21px 12px;vertical-align:middle;font-family:${EMAIL_FONT};font-size:12px;line-height:20px;color:#68717f;">${category}</td></tr>`);
  const footerLinks = `<a href="https://agigalaxy.org/" style="color:#8f4363;text-decoration:underline;">agigalaxy.org</a><span style="padding:0 9px;color:#68717f;">·</span><a href="https://agigalaxy.org/privacy/" style="color:#8f4363;text-decoration:underline;">${privacyLabel}</a>`;
  const footer = paragraph(brand, 'font-size:13px;line-height:20px;font-weight:600;color:#495363;') + paragraph(footerLinks, 'padding-top:7px;font-size:12px;line-height:20px;color:#68717f;');
  const inner = table(row(header, 'border-bottom:2px solid #eccfdc;') +
    row(body, `padding:28px 0;font-family:${EMAIL_FONT};font-size:15px;line-height:25px;color:#495363;overflow-wrap:anywhere;`) +
    row(footer, 'padding-top:20px;border-top:1px solid #e9ecf0;'));
  const frame = table(row(inner, 'padding:30px 32px;', ' class="galaxy-mail-paper"'), 'max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e4e7eb;border-radius:4px;border-collapse:separate;border-spacing:0;');
  const shell = table(row('<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->\n' + frame + '\n<!--[if mso]></td></tr></table><![endif]-->', 'padding:24px 12px 32px;', ' class="galaxy-mail-outer" align="center"'), 'background-color:#f7f8fa;');
  return `<!doctype html>
<html lang="${language}" dir="${direction}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title><style>${responsiveStyles}</style></head>
<body style="margin:0;padding:0;background-color:#f7f8fa;font-family:${EMAIL_FONT};-webkit-text-size-adjust:100%;">
<div style="display:none!important;font-size:1px;line-height:1px;color:#f7f8fa;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
${shell}
</body>
</html>`;
}

function textLayout({brand, category, body, privacyLabel}) {
  return [brand, category, body, brand + '\nhttps://agigalaxy.org/\n' + privacyLabel + ': https://agigalaxy.org/privacy/'].filter(Boolean).join('\n\n') + '\n';
}

/** Trusted body slot; ordinary user text should use renderGalaxyEmail instead. */
export function renderEmailLayout({bodyHtml, bodyText, brand = 'AGI Galaxy', language = 'zh-CN', category = emailLabels(language).category, title = '', preheader = ''}) {
  const labels = emailLabels(language);
  return {
    html: htmlLayout({language: escapeEmailText(language), direction: 'ltr', brand: escapeEmailText(brand),
      category: escapeEmailText(category), title: escapeEmailText(title || brand), preheader: escapeEmailText(preheader), body: bodyHtml, privacyLabel: escapeEmailText(labels.privacy)}),
    text: textLayout({brand, category, body: bodyText, privacyLabel: labels.privacy}),
  };
}

/** Render plain content with the selected header/footer. Does not send mail. */
export function renderGalaxyEmail({subject, title, paragraphs, note = '', brand = 'AGI Galaxy', language = 'zh-CN', category = emailLabels(language).category, preheader = ''}) {
  const body = table(row(heading(escapeEmailText(title)), 'padding-bottom:18px;') +
    paragraphs.map(value => row(paragraph(escapeEmailText(value)), 'padding-bottom:12px;')).join('') +
    (note ? row(paragraph(escapeEmailText(note), 'font-size:12px;line-height:22px;color:#68717f;'), 'padding-top:13px;') : ''));
  const plain = [title, ...paragraphs, note].filter(Boolean).join('\n\n');
  return {subject: subject.replaceAll('\r', ' ').replaceAll('\n', ' '), ...renderEmailLayout({bodyHtml: body, bodyText: plain, brand, category, title, preheader, language})};
}

function codeBody({title, eyebrow, introduction, instruction, code, expiry, continuation = '', safety}) {
  const codePanel = table(row(paragraph(eyebrow, 'font-size:12px;line-height:20px;color:#6e5362;') +
    `<span dir="ltr" style="display:block;font-family:${EMAIL_MONO};font-size:36px;line-height:54px;font-weight:600;letter-spacing:4px;white-space:nowrap;color:#202735;user-select:all;-webkit-user-select:all;">${code}</span>` +
    paragraph(expiry, 'padding-top:1px;font-size:13px;line-height:22px;color:#68717f;'), 'padding:18px 22px;', ' class="galaxy-mail-code-cell"'),
    'background-color:#fff5f8;border-left:3px solid #e1b8ca;border-radius:0 4px 4px 0;');
  return table(row(heading(title), 'padding-bottom:18px;') + row(paragraph(introduction) + paragraph(instruction, 'padding-top:8px;')) +
    row(codePanel, 'padding:25px 0 21px;') +
    (continuation ? row(paragraph(continuation), 'padding-bottom:12px;') : '') +
    row(paragraph(safety, 'font-size:12px;line-height:22px;color:#68717f;')));
}

/** Pure code-message body renderer; callers retain responsibility for transport. */
export function renderCodeEmail({title, introduction, instruction, code, expiry, continuation = '', safety, brand = 'AGI Galaxy', language = 'zh-CN', codeLabel = emailLabels(language).code, category = emailLabels(language).accountCategory, preheader = ''}) {
  const fields = {title, introduction, instruction, code, expiry, continuation, safety, eyebrow: codeLabel};
  const htmlFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, escapeEmailText(value)]));
  return renderEmailLayout({brand, category, title, language, preheader, bodyHtml: codeBody(htmlFields),
    bodyText: [title, introduction, instruction, codeLabel + ': ' + code, expiry, continuation, safety].filter(Boolean).join('\n\n')});
}

const expression = value => '${' + value + '}';
const message = key => expression('msg("' + key + '")');
const actionMessage = (key, withBrand = false) => expression('msg("galaxyEmailCode' + key + '" + actionSuffix' + (withBrand ? ', brand' : '') + ')');
const purpose = '<#if purpose != "register" && purpose != "reset-password"><#stop "Unsupported account email purpose"></#if>\n<#assign actionSuffix = (purpose == "register")?then("Register", "Reset")>\n';

/** Compatible with the no-argument emailLayout macro in Keycloak 26.7.3. */
export function keycloakEmailLayoutTemplates() {
  const macro = '<#macro emailLayout title="" category="" preheader="" brandName=(brand!"AGI Galaxy")>\n';
  const category = expression('category?has_content?then(category, msg("galaxyMailDefaultCategory"))');
  return {
    html: '<#ftl output_format="HTML" auto_esc=true>\n' + macro + htmlLayout({
      language: expression('(locale.language)!msg("galaxyMailLanguage")'), direction: expression('(ltr!true)?then("ltr", "rtl")'),
      brand: expression('brandName'), category, title: expression('title?has_content?then(title, brandName)'),
      preheader: expression('preheader'), body: '<#nested>', privacyLabel: message('galaxyMailPrivacy'),
    }) + '\n</#macro>\n',
    text: '<#ftl output_format="plainText">\n' + macro + textLayout({brand: expression('brandName'), category,
      body: '<#nested>', privacyLabel: message('galaxyMailPrivacy')}) + '</#macro>\n',
  };
}

/** Build-time source for the selected theme, never real verification values. */
export function keycloakEmailCodeTemplates() {
  const call = '<#import "template.ftl" as layout>\n<@layout.emailLayout title=msg("galaxyEmailCodeTitle" + actionSuffix) category=msg("galaxyEmailCodePurpose" + actionSuffix) preheader=msg("galaxyEmailCodePreheader" + actionSuffix, brand) brandName=brand>\n';
  const body = codeBody({title: actionMessage('Title'), eyebrow: message('galaxyEmailCodeCodeLabel'),
    introduction: actionMessage('Introduction', true), instruction: actionMessage('Instruction'),
    code: expression('code'), expiry: expression('msg("galaxyEmailCodeExpiry", expiresInMinutes?c)'),
    safety: actionMessage('Safety')});
  const plain = [actionMessage('Title'), actionMessage('Introduction', true), actionMessage('Instruction'),
    expression('msg("galaxyEmailCodeTextCode", code)'), expression('msg("galaxyEmailCodeExpiry", expiresInMinutes?c)'),
    actionMessage('Safety')].join('\n\n');
  return {html: '<#ftl output_format="HTML" auto_esc=true>\n' + purpose + call + body + '\n</@layout.emailLayout>\n',
    text: '<#ftl output_format="plainText">\n' + purpose + call + plain + '\n</@layout.emailLayout>\n'};
}

/** Exact relative paths for the auth builder's selected email theme output. */
export function keycloakEmailThemeTemplates() {
  const layout = keycloakEmailLayoutTemplates(), code = keycloakEmailCodeTemplates();
  return {'html/template.ftl': layout.html, 'text/template.ftl': layout.text,
    'html/galaxy-email-code.ftl': code.html, 'text/galaxy-email-code.ftl': code.text};
}
