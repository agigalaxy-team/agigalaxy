// The selected B layout is shared by previews, ordinary message renderers and
// the generated Keycloak templates. This module has no transport or storage.
export const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif";
export const EMAIL_MONO = "'SFMono-Regular',Consolas,'Liberation Mono',monospace";
export const escapeEmailText = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const table = (content, style = '', attributes = '') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${attributes} style="border-collapse:collapse;${style}">\n${content}\n</table>`;
const row = (content, style = '', attributes = '') => `<tr><td${attributes} style="${style}">${content}</td></tr>`;
const paragraph = (html, style = '') => `<p style="margin:0;font-family:${EMAIL_FONT};font-size:15px;line-height:26px;color:#605a60;${style}">${html}</p>`;
const heading = html => `<h1 style="margin:0;font-family:Georgia,'Songti SC','SimSun',serif;font-size:29px;line-height:41px;font-weight:500;color:#29242a;">${html}</h1>`;

// All values here are escaped by the public renderer or are controlled FTL
// expressions produced below. The content slot is not an untrusted HTML input.
function htmlLayout({language, direction, brand, category, title, preheader, body}) {
  const header = table(`<tr><td style="padding-bottom:19px;"><span style="font-family:${EMAIL_FONT};font-size:18px;line-height:28px;font-weight:650;letter-spacing:-.5px;color:#29242a;">${brand}</span></td><td align="right" style="padding-bottom:19px;font-family:${EMAIL_FONT};font-size:12px;line-height:20px;color:#8c7e87;">${category}</td></tr>`);
  const footer = paragraph(brand, 'font-size:13px;line-height:23px;font-weight:600;color:#63545f;') + paragraph('agigalaxy.org', 'font-size:12px;line-height:22px;color:#91898f;');
  const inner = table(row(header, 'border-bottom:2px solid #e6c2d6;') +
    row(body, `padding:28px 0;font-family:${EMAIL_FONT};font-size:15px;line-height:26px;color:#605a60;`) +
    row(footer, 'padding-top:22px;border-top:1px solid #eee8ec;'));
  const frame = table(row(inner, 'padding:29px 32px 28px;'), 'max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e7e2e6;');
  const shell = table(row('<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->\n' + frame + '\n<!--[if mso]></td></tr></table><![endif]-->', 'padding:24px 12px 32px;', ' align="center"'), 'background-color:#f8f7f9;');
  return `<!doctype html>
<html lang="${language}" dir="${direction}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title></head>
<body style="margin:0;padding:0;background-color:#f8f7f9;font-family:${EMAIL_FONT};-webkit-text-size-adjust:100%;">
<div style="display:none!important;font-size:1px;line-height:1px;color:#f8f7f9;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${preheader}</div>
${shell}
</body>
</html>`;
}

function textLayout({brand, category, body}) {
  return [brand, category, body, brand + '\nagigalaxy.org'].filter(Boolean).join('\n\n') + '\n';
}

/** Trusted body slot; ordinary user text should use renderGalaxyEmail instead. */
export function renderEmailLayout({bodyHtml, bodyText, brand = 'AGI Galaxy', category = '通知', title = '', preheader = '', language = 'zh-CN'}) {
  return {
    html: htmlLayout({language: escapeEmailText(language), direction: 'ltr', brand: escapeEmailText(brand),
      category: escapeEmailText(category), title: escapeEmailText(title || brand), preheader: escapeEmailText(preheader), body: bodyHtml}),
    text: textLayout({brand, category, body: bodyText}),
  };
}

/** Render plain content with the selected header/footer. Does not send mail. */
export function renderGalaxyEmail({subject, title, paragraphs, note = '', category = '通知', brand = 'AGI Galaxy', language = 'zh-CN', preheader = ''}) {
  const body = table(row(heading(escapeEmailText(title)), 'padding-bottom:18px;') +
    paragraphs.map(value => row(paragraph(escapeEmailText(value)), 'padding-bottom:12px;')).join('') +
    (note ? row(paragraph(escapeEmailText(note), 'font-size:12px;line-height:22px;color:#8f858c;'), 'padding-top:13px;') : ''));
  const plain = [title, ...paragraphs, note].filter(Boolean).join('\n\n');
  return {subject: subject.replaceAll('\r', ' ').replaceAll('\n', ' '), ...renderEmailLayout({bodyHtml: body, bodyText: plain, brand, category, title, preheader, language})};
}

function codeBody({title, eyebrow, introduction, instruction, code, expiry, continuation, safety}) {
  const codeRow = table(`<tr><td style="padding:20px 0;vertical-align:middle;">${paragraph(eyebrow, 'font-size:12px;line-height:20px;color:#8c6f80;')}<span dir="ltr" style="display:inline-block;font-family:${EMAIL_MONO};font-size:32px;line-height:48px;font-weight:600;letter-spacing:3px;white-space:nowrap;color:#392d36;user-select:all;-webkit-user-select:all;">${code}</span></td><td align="right" width="80" style="padding:20px 0;vertical-align:middle;font-family:${EMAIL_FONT};font-size:12px;line-height:22px;color:#8b7d86;">${expiry}</td></tr>`, 'border-top:1px solid #e7dce3;border-bottom:1px solid #e7dce3;');
  return table(row(heading(title), 'padding-bottom:18px;') + row(paragraph(introduction) + paragraph(instruction), 'padding-bottom:26px;') +
    row(codeRow) + row(paragraph(continuation), 'padding-top:23px;') +
    row(paragraph(safety, 'font-size:12px;line-height:22px;color:#8f858c;'), 'padding-top:19px;'));
}

/** Pure code-message body renderer; callers retain responsibility for transport. */
export function renderCodeEmail({title, introduction, instruction, code, expiry, continuation, safety, codeLabel = '验证码', category = '账户服务', brand = 'AGI Galaxy', language = 'zh-CN', preheader = ''}) {
  const fields = {title, introduction, instruction, code, expiry, continuation, safety, eyebrow: codeLabel};
  const htmlFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, escapeEmailText(value)]));
  return renderEmailLayout({brand, category, title, language, preheader, bodyHtml: codeBody(htmlFields),
    bodyText: [title, introduction, instruction, codeLabel + ': ' + code, expiry, continuation, safety].join('\n\n')});
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
      preheader: expression('preheader'), body: '<#nested>',
    }) + '\n</#macro>\n',
    text: '<#ftl output_format="plainText">\n' + macro + textLayout({brand: expression('brandName'), category,
      body: '<#nested>'}) + '</#macro>\n',
  };
}

/** Build-time source for the selected theme, never real verification values. */
export function keycloakEmailCodeTemplates() {
  const call = '<#import "template.ftl" as layout>\n<@layout.emailLayout title=msg("galaxyEmailCodeTitle" + actionSuffix) category=msg("galaxyEmailCodePurpose" + actionSuffix) preheader=msg("galaxyEmailCodePreheader" + actionSuffix, brand) brandName=brand>\n';
  const body = codeBody({title: actionMessage('Title'), eyebrow: message('galaxyEmailCodeCodeLabel'),
    introduction: actionMessage('Introduction', true), instruction: actionMessage('Instruction'),
    code: expression('code'), expiry: expression('msg("galaxyEmailCodeExpiry", expiresInMinutes?c)'),
    continuation: actionMessage('Continuation'), safety: message('galaxyEmailCodeSafety')});
  const plain = [actionMessage('Title'), actionMessage('Introduction', true), actionMessage('Instruction'),
    expression('msg("galaxyEmailCodeTextCode", code)'), expression('msg("galaxyEmailCodeExpiry", expiresInMinutes?c)'),
    actionMessage('Continuation'), message('galaxyEmailCodeSafety')].join('\n\n');
  return {html: '<#ftl output_format="HTML" auto_esc=true>\n' + purpose + call + body + '\n</@layout.emailLayout>\n',
    text: '<#ftl output_format="plainText">\n' + purpose + call + plain + '\n</@layout.emailLayout>\n'};
}

/** Exact relative paths for the auth builder's selected email theme output. */
export function keycloakEmailThemeTemplates() {
  const layout = keycloakEmailLayoutTemplates(), code = keycloakEmailCodeTemplates();
  return {'html/template.ftl': layout.html, 'text/template.ftl': layout.text,
    'html/galaxy-email-code.ftl': code.html, 'text/galaxy-email-code.ftl': code.text};
}
