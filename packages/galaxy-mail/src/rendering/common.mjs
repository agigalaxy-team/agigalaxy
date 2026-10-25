export const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif";
export const EMAIL_MONO = "'SFMono-Regular',Consolas,'Liberation Mono',monospace";
export const EMAIL_LOGO_URL = 'https://auth.agigalaxy.org/assets/img/galaxy-mail-logo.png?v=mail-letterhead-20261020';
export const escapeEmailText = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
export const table = (content, style = '', attributes = '') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${attributes} style="border-collapse:collapse;${style}">\n${content}\n</table>`;
export const row = (content, style = '', attributes = '') => `<tr><td${attributes} style="${style}">${content}</td></tr>`;
export const paragraph = (html, style = '') => `<p style="margin:0;font-family:${EMAIL_FONT};font-size:15px;line-height:26.25px;color:#505361;${style}">${html}</p>`;
export const heading = html => `<h1 class="galaxy-mail-title" style="margin:0;font-family:${EMAIL_FONT};font-size:24px;line-height:35px;font-weight:600;letter-spacing:-.45px;color:#282a34;">${html}</h1>`;
export const emailLabels = language => String(language).toLowerCase().startsWith('en')
  ? {category: 'Notification', accountCategory: 'Account services', code: 'Verification code', about: 'About Galaxy', privacy: 'Privacy', guide: 'User guide',
    automatedNotice: 'This is an automated system email. Please do not reply directly.', contactTeam: 'Contact the Galaxy team', teamReply: 'You can reply to this email to continue the conversation.'}
  : {category: '系统通知', accountCategory: '账户服务', code: '验证码', about: '关于银河', privacy: '隐私', guide: '使用说明',
    automatedNotice: '系统邮件，请勿直接回复。', contactTeam: '联系银河团队', teamReply: '如需继续沟通，可直接回复本邮件。'};
export function codeBody({title, eyebrow, introduction, instruction, code, expiry, continuation = '', safety}) {
  const codePanel = table(row(paragraph(eyebrow, 'font-size:11.5px;line-height:19px;color:#6d6e7b;') +
    `<span dir="ltr" style="display:block;margin:3px 0 4px;font-family:${EMAIL_MONO};font-size:33px;line-height:46px;font-weight:600;letter-spacing:3px;white-space:nowrap;color:#282a34;user-select:all;-webkit-user-select:all;">${code}</span>` +
    paragraph(expiry, 'font-size:12px;line-height:20px;color:#6d6e7b;'), 'padding:18px 20px;', ' class="galaxy-mail-code-cell"'),
    'background-color:#fcf5f8;border-left:2px solid #d9b1c5;border-radius:0 4px 4px 0;');
  return table(row(heading(title), 'padding-bottom:21px;') + row(paragraph(introduction) + paragraph(instruction, 'padding-top:13px;')) +
    row(codePanel, 'padding:23px 0;') +
    (continuation ? row(paragraph(continuation), 'padding-bottom:12px;') : '') +
    row(paragraph(safety, 'font-size:12px;line-height:21px;color:#6d6e7b;')));
}

