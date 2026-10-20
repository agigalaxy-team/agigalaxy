import {EMAIL_DESIGNS, EMAIL_SCENARIOS, SENDER_NAME_CHOICES, EMAIL_PREVIEW} from './email-data.mjs';
import {renderCodeEmail, renderGalaxyEmail} from './common/email-layout.mjs';
export {EMAIL_DESIGNS, EMAIL_SCENARIOS, SENDER_NAME_CHOICES, EMAIL_PREVIEW};
export {renderEmailLayout, renderGalaxyEmail} from './common/email-layout.mjs';

const font = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif";
const mono = "'SFMono-Regular',Consolas,'Liberation Mono',monospace";
const escape = text => String(text).replace(/[&<>"']/g, value => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[value]));
const table = (content, style = '', attributes = '') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${attributes} style="border-collapse:collapse;${style}">${content}</table>`;
const row = (content, style = '', attributes = '') => `<tr><td${attributes} style="${style}">${content}</td></tr>`;
const text = (value, style = '') => `<p style="margin:0;font-family:${font};font-size:15px;line-height:26px;color:#605a60;${style}">${escape(value)}</p>`;
const title = (value, style = '') => `<h1 style="margin:0;font-family:${font};font-size:27px;line-height:38px;font-weight:650;letter-spacing:-.5px;color:#29242a;${style}">${escape(value)}</h1>`;
const brand = (style = '') => `<span style="font-family:${font};font-size:20px;line-height:28px;font-weight:650;letter-spacing:-.5px;color:#29242a;${style}">AGI Galaxy</span>`;
const safety = '请勿将验证码告知他人。若非本人操作，可忽略这封邮件。';
const code = (style = '') => `<span dir="ltr" style="display:inline-block;font-family:${mono};font-size:38px;line-height:54px;font-weight:600;letter-spacing:7px;white-space:nowrap;color:#392d36;user-select:all;-webkit-user-select:all;${style}">${EMAIL_PREVIEW.code}</span>`;
const expiry = `${EMAIL_PREVIEW.expiresInMinutes} 分钟内有效`;

function footer(sender, align = 'left') {
  return table(row(`${text(sender, 'font-size:13px;line-height:23px;font-weight:600;color:#63545f;')}${text('agigalaxy.org', 'font-size:12px;line-height:22px;color:#91898f;')}`, `padding-top:24px;text-align:${align};`));
}

function brandLayout(scene, sender) {
  const header = table(`<tr><td style="padding:0 0 22px;border-bottom:1px solid #eee8ec;">${brand()}</td><td align="right" style="padding:0 0 22px;border-bottom:1px solid #eee8ec;font-family:${font};font-size:12px;color:#8b7d86;white-space:nowrap;">账户服务</td></tr>`);
  const panel = table(
    row(text('验证码', 'font-size:12px;line-height:20px;color:#8d667c;'), 'padding:19px 24px 2px;') +
    row(code(), 'padding:0 24px 5px;') +
    row(text(expiry, 'font-size:13px;line-height:21px;color:#8a727f;'), 'padding:0 24px 19px;'),
    'background-color:#fdf5f9;border:1px solid #f5e8ef;border-radius:10px;',
  );
  return table(
    row(header) + row(title(scene.title), 'padding:30px 0 13px;') +
    row(text(scene.introduction) + text(scene.instruction), 'padding:0 0 23px;') +
    row(panel) + row(text(scene.continuation), 'padding:19px 0 28px;') +
    row(text(safety, 'font-size:12px;line-height:22px;color:#8e858d;'), 'border-top:1px solid #eee8ec;padding:20px 0 0;') +
    row(footer(sender)),
  );
}

function serviceLayout(scene, sender) {
  const panel = table(
    row(text('验证码', 'font-size:12px;line-height:20px;color:#96708a;text-align:center;'), 'padding:20px 10px 2px;') +
    row(code('font-size:37px;letter-spacing:6px;'), 'padding:0 10px 4px;text-align:center;') +
    row(text(expiry, 'font-size:12px;line-height:21px;text-align:center;color:#947e8c;'), 'padding:0 10px 20px;'),
    'max-width:320px;background-color:#fdf4f9;border:1px solid #f4e6ee;border-radius:12px;margin:0 auto;',
  );
  return table(
    row(brand('font-size:22px;'), 'padding:1px 0 31px;text-align:center;') +
    row(`<span style="display:inline-block;border:1px solid #f0dfe9;background-color:#fff9fc;border-radius:24px;padding:4px 13px;font-family:${font};font-size:11px;line-height:18px;color:#a37891;">账户安全</span>`, 'text-align:center;padding-bottom:16px;') +
    row(title(scene.title, 'font-size:26px;text-align:center;'), 'padding-bottom:15px;') +
    row(text(scene.introduction, 'text-align:center;') + text(scene.instruction, 'text-align:center;'), 'padding-bottom:27px;') +
    row(panel, 'text-align:center;', ' align="center"') +
    row(text(scene.continuation, 'text-align:center;font-size:14px;'), 'padding:20px 0 27px;') +
    row(text(safety, 'font-size:12px;line-height:22px;text-align:center;color:#968b93;'), 'border-top:1px solid #f0e9ed;padding-top:21px;') +
    row(footer(sender, 'center')),
  );
}

/**
 * Pure browser/Node preview contract. Fixed synthetic code only; no transport,
 * real-code input, remote resources, JavaScript email content or storage.
 * @param {{design?:'a'|'b'|'c',scenario?:'register'|'reset-password'|'change-email'|'system'|'service',senderName?:string}} options
 */
export function renderEmailPreview({design = 'b', scenario = 'register', senderName = 'AGI Galaxy'} = {}) {
  const selectedDesign = EMAIL_DESIGNS.find(item => item.id === design);
  const scene = EMAIL_SCENARIOS.find(item => item.id === scenario);
  if (!selectedDesign || !scene || !SENDER_NAME_CHOICES.some(item => item.value === senderName)) throw new Error('Unknown email preview option.');
  if (scene.designs && !scene.designs.includes(design)) throw new Error('This preview uses the selected email layout.');
  if (design === 'b') {
    const rendered = scene.kind === 'notice'
      ? renderGalaxyEmail({subject: scene.subject, title: scene.title, paragraphs: scene.paragraphs, note: scene.note, category: scene.purpose, brand: senderName, preheader: scene.preheader})
      : renderCodeEmail({title: scene.title, introduction: scene.introduction, instruction: scene.instruction, code: EMAIL_PREVIEW.code,
        expiry, continuation: scene.continuation, safety, category: scene.purpose, brand: senderName, preheader: scene.preheader});
    const label = '<div style="padding:16px 12px 0;font-family:' + font + ';font-size:11px;line-height:20px;text-align:center;color:#a398a1;">预览样例</div>';
    const sampleNote = scene.kind === 'notice' ? '内容为预览样例，未发送邮件。' : '示例验证码，仅用于设计预览。有效期为示例值。';
    const html = rendered.html.replace(/(<body\b[^>]*>)/, '$1' + label).replace('</body>', text(sampleNote, 'padding:0 12px 20px;font-size:11px;line-height:20px;text-align:center;color:#a398a1;') + '\n</body>');
    return {html, text: '【预览样例】\n\n' + rendered.text + '\n' + sampleNote + '\n', subject: scene.subject, senderName, design, scenario, preview: true};
  }
  const content = ({a: brandLayout, c: serviceLayout})[design](scene, senderName);
  const frame = design === 'c' ? 'border:1px solid #eee7ec;border-radius:18px;' : 'border:1px solid #eee8ec;border-radius:12px;';
  const body = table(row(
    text('预览示例', 'font-size:11px;line-height:20px;text-align:center;color:#a398a1;') +
    '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
    table(row(content, `padding:${design === 'b' ? '29px 32px 28px' : design === 'c' ? '32px 26px 27px' : '30px 30px 27px'};`), `max-width:600px;margin:12px auto 0;background-color:#ffffff;${frame}`) +
    '<!--[if mso]></td></tr></table><![endif]-->' +
    text('示例验证码，仅用于设计预览。有效期为示例值。', 'font-size:11px;line-height:20px;color:#a398a1;text-align:center;margin-top:14px;'),
    'padding:24px 12px 32px;', ' align="center"'), 'background-color:#f8f7f9;');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(scene.subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f8f7f9;font-family:${font};-webkit-text-size-adjust:100%;">
<div style="display:none!important;font-size:1px;line-height:1px;color:#f8f7f9;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escape(scene.preheader)}</div>
${body}
</body></html>`;
  const plainText = ['【预览示例】', 'AGI Galaxy', '', scene.title, '', scene.introduction, scene.instruction, '',
    `验证码：${EMAIL_PREVIEW.code}`, `${expiry}（示例有效期）`, '', scene.continuation, '', safety, '', senderName, 'agigalaxy.org', '',
    '此为设计预览。验证码与有效期均为示例值，不可用于真实操作。'].join('\n');
  return {html, text: plainText, subject: scene.subject, senderName, design, scenario, preview: true};
}
