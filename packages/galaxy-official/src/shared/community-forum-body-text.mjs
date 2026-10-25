export function forumBodyParagraphs(body) {
  return body.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/).map(value => value.trim()).filter(Boolean);
}

/**
 * Only explicit public post/reply consumers use closed code fences. All other
 * text keeps the existing paragraph presentation; this is not a Markdown parser.
 * @param {string} body
 * @returns {Array<{kind: 'paragraph', text: string}|{kind: 'code', text: string, language: string|null}>}
 */
export function forumBodyBlocks(body) {
  /** @type {Array<{kind: 'paragraph', text: string}|{kind: 'code', text: string, language: string|null}>} */
  const blocks = [];
  const lines = [...body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match => match[0].length > 0)
    .map(match => ({ start: match.index, end: match.index + match[0].length, text: match[0].replace(/(?:\r\n|\r|\n)$/, '') }));
  /** @param {string} text */
  const paragraphs = text => blocks.push(...forumBodyParagraphs(text).map(text => ({ kind: /** @type {const} */ ('paragraph'), text })));
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    const opening = /^[\t ]{0,3}```([A-Za-z0-9_+#.-]{1,32})?[\t ]*$/.exec(lines[index].text);
    if (!opening) continue;
    let closing = index + 1;
    while (closing < lines.length && !/^[\t ]{0,3}```[\t ]*$/.test(lines[closing].text)) closing++;
    if (closing === lines.length) break; // Preserve an unclosed fence as ordinary text.
    paragraphs(body.slice(start, lines[index].start));
    blocks.push({ kind: 'code', text: body.slice(lines[index].end, lines[closing].start), language: opening[1] ?? null });
    start = lines[closing].end;
    index = closing;
  }
  paragraphs(body.slice(start));
  return blocks;
}

/** Plain summary of the same closed-fence post/reply text; no Markdown or HTML interpretation.
 * @param {string} body
 */
export function forumBodyExcerpt(body) {
  return forumBodyBlocks(body).map(block => block.text).join(' ').replace(/\s+/g, ' ').trim();
}
