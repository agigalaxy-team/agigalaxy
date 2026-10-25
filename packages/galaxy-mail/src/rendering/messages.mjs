import {emailLabels, escapeEmailText, table, row, paragraph, heading, codeBody} from './common.mjs';
import {htmlLayout, textLayout} from './frame.mjs';

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

/** Pure code-message body renderer; callers retain responsibility for transport. */
export function renderCodeEmail({title, introduction, instruction, code, expiry, continuation = '', safety, brand = 'AGI Galaxy', language = 'zh-CN', codeLabel = emailLabels(language).code, category = emailLabels(language).accountCategory, preheader = ''}) {
  const fields = {title, introduction, instruction, code, expiry, continuation, safety, eyebrow: codeLabel};
  const htmlFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, escapeEmailText(value)]));
  return renderEmailLayout({brand, category, title, language, preheader, bodyHtml: codeBody(htmlFields),
    bodyText: [title, introduction, instruction, codeLabel + ': ' + code, expiry, continuation, safety].filter(Boolean).join('\n\n')});
}

