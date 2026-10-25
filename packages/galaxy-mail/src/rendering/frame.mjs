import {EMAIL_FONT, EMAIL_LOGO_URL, table, row, paragraph} from './common.mjs';
import {EMAIL_TEAM_ADDRESS} from '../identities.mjs';

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
export function htmlLayout({language, direction, brand, category, title, preheader, body, aboutLabel, privacyLabel, guideLabel, replyNotice, contactLabel, copyrightYear = new Date().getUTCFullYear()}) {
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

export function textLayout({brand, category, body, aboutLabel, privacyLabel, guideLabel, replyNotice, contactLabel, copyrightYear = new Date().getUTCFullYear()}) {
  return [brand, category, body, replyNotice + '\n' + contactLabel + ': ' + EMAIL_TEAM_ADDRESS,
    aboutLabel + ': https://agigalaxy.org/how-it-works/\n' + privacyLabel + ': https://agigalaxy.org/privacy/\n' + guideLabel + ': https://agigalaxy.org/docs/\n© ' + copyrightYear + ' ' + brand].filter(Boolean).join('\n\n') + '\n';
}

