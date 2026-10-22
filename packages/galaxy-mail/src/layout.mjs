// The selected brand letterhead is shared by previews, ordinary message renderers and
// the generated Keycloak templates. This module has no transport or storage.
import {EMAIL_TEAM_ADDRESS} from './identities.mjs';
export {EMAIL_TEAM_ADDRESS, OFFICIAL_MAIL_IDENTITIES, officialMailIdentity} from './identities.mjs';
export const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif";
export const EMAIL_MONO = "'SFMono-Regular',Consolas,'Liberation Mono',monospace";
export const EMAIL_LOGO_URL = 'https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020';
export const escapeEmailText = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const table = (content, style = '', attributes = '') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${attributes} style="border-collapse:collapse;${style}">\n${content}\n</table>`;
const row = (content, style = '', attributes = '') => `<tr><td${attributes} style="${style}">${content}</td></tr>`;
const paragraph = (html, style = '') => `<p style="margin:0;font-family:${EMAIL_FONT};font-size:15px;line-height:26.25px;color:#505361;${style}">${html}</p>`;
const heading = html => `<h1 class="galaxy-mail-title" style="margin:0;font-family:${EMAIL_FONT};font-size:24px;line-height:35px;font-weight:600;letter-spacing:-.45px;color:#282a34;">${html}</h1>`;
const emailLabels = language => String(language).toLowerCase().startsWith('en')
  ? {category: 'Notification', accountCategory: 'Account services', code: 'Verification code', about: 'About Galaxy', privacy: 'Privacy', guide: 'User guide',
    automatedNotice: 'This is an automated system email. Please do not reply directly.', contactTeam: 'Contact the Galaxy team', teamReply: 'You can reply to this email to continue the conversation.'}
  : {category: '系统通知', accountCategory: '账户服务', code: '验证码', about: '关于银河', privacy: '隐私', guide: '使用说明',
    automatedNotice: '系统邮件，请勿直接回复。', contactTeam: '联系银河团队', teamReply: '如需继续沟通，可直接回复本邮件。'};
const responsiveStyles = `@media only screen and (max-width:480px){
  .galaxy-mail-outer{padding:19px 8px!important}
  .galaxy-mail-paper{padding:32px 23px!important}
  .galaxy-mail-brand{font-size:16px!important}
  .galaxy-mail-mark{padding-right:8px!important}
  .galaxy-mail-category{max-width:60px!important;padding-left:8px!important}
  .galaxy-mail-title{font-size:22px!important;line-height:32px!important}
  .galaxy-mail-code-cell{padding:17px!important}
}`;

// All values here are escaped by the public renderer or are controlled FTL
// expressions produced below. The content slot is not an untrusted HTML input.
function htmlLayout({language, direction, brand, category, title, preheader, body, aboutLabel, privacyLabel, guideLabel, replyNotice, contactLabel, copyrightYear = new Date().getUTCFullYear()}) {
  const wordmark = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td class="galaxy-mail-mark" width="27" style="padding-right:10px;vertical-align:middle;"><img src="${EMAIL_LOGO_URL}" width="27" height="27" alt="" style="display:block;width:27px;height:27px;border:0;outline:none;text-decoration:none;"></td><td class="galaxy-mail-brand" style="font-family:${EMAIL_FONT};font-size:17px;line-height:26px;font-weight:600;letter-spacing:-.3px;color:#282a34;white-space:nowrap;vertical-align:middle;">${brand}</td></tr></table>`;
  const header = table(`<tr><td style="padding-bottom:22px;vertical-align:middle;">${wordmark}</td><td class="galaxy-mail-category" align="right" style="padding:0 0 22px 12px;vertical-align:middle;font-family:${EMAIL_FONT};font-size:11.5px;line-height:18px;color:#6d6e7b;">${category}</td></tr>`);
  const link = (url, label) => `<a href="${url}" style="color:#747481;text-decoration:none;white-space:nowrap;">${label}</a>`;
  const footerLinks = [link('https://agigalaxy.org/how-it-works/', aboutLabel), link('https://agigalaxy.org/privacy/', privacyLabel), link('https://agigalaxy.org/docs/', guideLabel)].join('<span style="padding:0 7px;color:#b7b5bf;">·</span>');
  const contact = `${contactLabel}：<a href="mailto:${EMAIL_TEAM_ADDRESS}" style="color:#84516b;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere;">${EMAIL_TEAM_ADDRESS}</a>`;
  const contactDetails = paragraph(replyNotice, 'font-size:12px;line-height:21px;color:#6d6e7b;') +
    paragraph(contact, 'padding-top:3px;font-size:12px;line-height:21px;color:#6d6e7b;');
  const footer = paragraph(footerLinks, 'font-size:11.5px;line-height:20px;color:#747481;text-align:center;') +
    paragraph(`© ${copyrightYear} ${brand}`, 'padding-top:6px;font-size:11.5px;line-height:20px;color:#747481;text-align:center;');
  const inner = table(row(header, 'border-bottom:2px solid #ead3df;') +
    row(body, `padding:27px 0 0;font-family:${EMAIL_FONT};font-size:15px;line-height:26.25px;color:#505361;overflow-wrap:anywhere;`) +
    row(contactDetails, 'padding:25px 0;', ' class="galaxy-mail-contact"') +
    row(footer, 'padding-top:19px;border-top:1px solid #eee9ef;text-align:center;', ' class="galaxy-mail-footer" align="center"'));
  const frame = table(row(inner, 'padding:32px;', ' class="galaxy-mail-paper"'), 'max-width:600px;margin:0 auto;background-color:#ffffff;border:1px solid #e5e5eb;border-radius:5px;border-collapse:separate;border-spacing:0;');
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

function textLayout({brand, category, body, aboutLabel, privacyLabel, guideLabel, replyNotice, contactLabel, copyrightYear = new Date().getUTCFullYear()}) {
  return [brand, category, body, replyNotice + '\n' + contactLabel + ': ' + EMAIL_TEAM_ADDRESS,
    aboutLabel + ': https://agigalaxy.org/how-it-works/\n' + privacyLabel + ': https://agigalaxy.org/privacy/\n' + guideLabel + ': https://agigalaxy.org/docs/\n© ' + copyrightYear + ' ' + brand].filter(Boolean).join('\n\n') + '\n';
}

/** Trusted body slot; ordinary user text should use renderGalaxyEmail instead. */
export function renderEmailLayout({bodyHtml, bodyText, brand = 'AGI Galaxy', language = 'zh-CN', category = emailLabels(language).category, title = '', preheader = '', automated = true}) {
  const labels = emailLabels(language);
  const replyNotice = automated ? labels.automatedNotice : labels.teamReply;
  return {
    html: htmlLayout({language: escapeEmailText(language), direction: 'ltr', brand: escapeEmailText(brand),
      category: escapeEmailText(category), title: escapeEmailText(title || brand), preheader: escapeEmailText(preheader), body: bodyHtml, aboutLabel: escapeEmailText(labels.about), privacyLabel: escapeEmailText(labels.privacy), guideLabel: escapeEmailText(labels.guide), replyNotice: escapeEmailText(replyNotice), contactLabel: escapeEmailText(labels.contactTeam)}),
    text: textLayout({brand, category, body: bodyText, aboutLabel: labels.about, privacyLabel: labels.privacy, guideLabel: labels.guide, replyNotice, contactLabel: labels.contactTeam}),
  };
}

/** Render plain content with the selected header/footer. Does not send mail. */
export function renderGalaxyEmail({subject, title, paragraphs, note = '', brand = 'AGI Galaxy', language = 'zh-CN', category = emailLabels(language).category, preheader = '', automated = true}) {
  const body = table(row(heading(escapeEmailText(title)), 'padding-bottom:21px;') +
    paragraphs.map((value, index) => row(paragraph(escapeEmailText(value)), index < paragraphs.length - 1 ? 'padding-bottom:13px;' : '')).join('') +
    (note ? row(paragraph(escapeEmailText(note), 'font-size:12px;line-height:21px;color:#6d6e7b;'), 'padding-top:23px;') : ''));
  const plain = [title, ...paragraphs, note].filter(Boolean).join('\n\n');
  return {subject: subject.replaceAll('\r', ' ').replaceAll('\n', ' '), ...renderEmailLayout({bodyHtml: body, bodyText: plain, brand, category, title, preheader, language, automated})};
}

function codeBody({title, eyebrow, introduction, instruction, code, expiry, continuation = '', safety}) {
  const codePanel = table(row(paragraph(eyebrow, 'font-size:11.5px;line-height:19px;color:#6d6e7b;') +
    `<span dir="ltr" style="display:block;margin:3px 0 4px;font-family:${EMAIL_MONO};font-size:33px;line-height:46px;font-weight:600;letter-spacing:3px;white-space:nowrap;color:#282a34;user-select:all;-webkit-user-select:all;">${code}</span>` +
    paragraph(expiry, 'font-size:12px;line-height:20px;color:#6d6e7b;'), 'padding:18px 20px;', ' class="galaxy-mail-code-cell"'),
    'background-color:#fcf5f8;border-left:2px solid #d9b1c5;border-radius:0 4px 4px 0;');
  return table(row(heading(title), 'padding-bottom:21px;') + row(paragraph(introduction) + paragraph(instruction, 'padding-top:13px;')) +
    row(codePanel, 'padding:23px 0;') +
    (continuation ? row(paragraph(continuation), 'padding-bottom:12px;') : '') +
    row(paragraph(safety, 'font-size:12px;line-height:21px;color:#6d6e7b;')));
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
      preheader: expression('preheader'), body: '<#nested>', aboutLabel: message('galaxyMailAbout'), privacyLabel: message('galaxyMailPrivacy'), guideLabel: message('galaxyMailGuide'), copyrightYear: expression('.now?string("yyyy")'),
      replyNotice: message('galaxyMailAutomatedNotice'), contactLabel: message('galaxyMailContactTeam'),
    }) + '\n</#macro>\n',
    text: '<#ftl output_format="plainText">\n' + macro + textLayout({brand: expression('brandName'), category,
      body: '<#nested>', aboutLabel: message('galaxyMailAbout'), privacyLabel: message('galaxyMailPrivacy'), guideLabel: message('galaxyMailGuide'), copyrightYear: expression('.now?string("yyyy")'), replyNotice: message('galaxyMailAutomatedNotice'), contactLabel: message('galaxyMailContactTeam')}) + '</#macro>\n',
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
