const path = '/app/community';
const stateVersion = 1;

export function forumBrowsePath({ section = 'all', topic = '', query = '', compose = false } = {}) {
  const params = new URLSearchParams();
  if (['owned', 'reports'].includes(section)) params.set('section', section);
  if (section !== 'reports') {
    if (topic) params.set('topic', topic);
    if (query.trim()) params.set('q', query.trim());
  }
  if (compose) params.set('compose', 'post');
  return path + (params.size ? '?' + params.toString() : '');
}

export function forumBrowseSelection(search, topicIds) {
  const params = new URLSearchParams(search);
  const requestedTopic = params.get('topic') ?? '';
  return {
    topic: [...topicIds, 'unclassified'].includes(requestedTopic) ? requestedTopic : '',
    query: (params.get('q') ?? '').trim(),
  };
}

function plainFeedRoute(value) {
  if (typeof value !== 'string' || !value.startsWith(path)) return null;
  try {
    const url = new URL(value, 'https://galaxy.invalid');
    if (url.origin !== 'https://galaxy.invalid' || url.pathname !== path || url.searchParams.has('compose')) return null;
    return url.pathname + url.search;
  } catch { return null; }
}

export function forumBrowseFocus(state, route) {
  const value = state?.forumBrowseFocus;
  return value && plainFeedRoute(value.route) === route && ['topic', 'results', 'tabs'].includes(value.target) ? value.target : null;
}

export function forumBrowsePosition(value, scope, route) {
  if (!value || value.version !== stateVersion || value.endpoint !== scope.endpoint || plainFeedRoute(value.route) !== route) return null;
  const publicVisitor = value.subjectId === null && !new URL(route, 'https://galaxy.invalid').searchParams.has('section');
  if (value.subjectId !== (scope.subjectId ?? null) && !publicVisitor) return null;
  if (!Number.isSafeInteger(value.pages) || value.pages < 1 || value.pages > 200) return null;
  if (!Number.isFinite(value.y) || value.y < 0 || !Number.isFinite(value.offset)) return null;
  const anchor = typeof value.anchor === 'string' && /^forum-post-[0-9a-f-]{36}$/.test(value.anchor) ? value.anchor : null;
  return { version: stateVersion, endpoint: scope.endpoint, subjectId: value.subjectId, route, pages: value.pages, y: value.y, anchor, offset: value.offset };
}

function storageKey(scope) {
  return 'galaxy-community-browse-v1:' + scope.endpoint + ':' + (scope.subjectId ?? 'visitor');
}

export function readForumBrowsePosition({ state, storage, scope, route }) {
  if (forumBrowseFocus(state, route)) return null;
  const historyPosition = forumBrowsePosition(state?.forumBrowse, scope, route) ?? forumBrowsePosition(state?.forumBrowseReturn, scope, route);
  if (historyPosition) return historyPosition;
  // Navigation metadata only. Content is always read again under current permissions.
  for (const source of [scope, ...(scope.subjectId && !new URL(route, 'https://galaxy.invalid').searchParams.has('section') ? [{ ...scope, subjectId: null }] : [])]) {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey(source)) ?? '[]');
      if (!Array.isArray(saved)) continue;
      const position = forumBrowsePosition(saved.find(item => item?.route === route), scope, route);
      if (position) return position;
    } catch { /* History still provides an in-tab return when storage is unavailable. */ }
  }
  return null;
}

/** @param {{storage?: Storage, scope: {endpoint: string, subjectId?: string|null}, route: string, pages: number, y: number, anchor?: string|null, offset?: number}} input */
export function saveForumBrowsePosition({ storage, scope, route, pages, y, anchor = null, offset = 0 }) {
  const position = forumBrowsePosition({ version: stateVersion, ...scope, subjectId: scope.subjectId ?? null, route, pages, y, anchor, offset }, scope, route);
  if (!position) return null;
  try {
    const previous = JSON.parse(storage?.getItem(storageKey(scope)) ?? '[]');
    const rows = Array.isArray(previous) ? previous.filter(item => item?.route !== route && forumBrowsePosition(item, scope, item?.route)) : [];
    storage?.setItem(storageKey(scope), JSON.stringify([position, ...rows].slice(0, 12)));
  } catch { /* A blocked session store must not interrupt reading or publishing. */ }
  return position;
}

export {forumBodyParagraphs,forumBodyBlocks,forumBodyExcerpt} from '../../galaxy-official/src/shared/community-forum-body-text.mjs';

export function forumLinkLabel(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    let suffix = url.pathname === '/' ? '' : url.pathname;
    try { suffix = decodeURIComponent(suffix); } catch { /* Keep encoded paths readable. */ }
    suffix += url.search;
    return { host: url.hostname, detail: suffix + url.hash, href: url.href };
  } catch { return null; }
}

/**
 * @template T
 * @param {(after?: string) => Promise<{items: T[], nextAfter: string|null, order?: 'published'|'id'}>} read
 * @param {number} pages
 * @param {() => boolean} valid
 * @param {{items: T[], nextAfter: string|null, order?: 'published'|'id'}} [firstPage]
 * @param {(item: T) => boolean} [until]
 */
export async function readForumPages(read, pages, valid, firstPage, until) {
  /** @type {T[]} */
  const items = [];
  /** @type {string|undefined} */
  let after;
  /** @type {'published'|'id'|undefined} */
  let order;
  let pagesRead = 0;
  const visited = new Set();
  do {
    const result = pagesRead === 0 && firstPage ? firstPage : await read(after);
    if (!valid()) return null;
    items.push(...result.items);
    order = result.order ?? order;
    const next = result.nextAfter ?? undefined;
    if (next && visited.has(next)) throw Error('分页位置暂时无法继续，请稍后重新读取。');
    if (next) visited.add(next);
    after = next;
    pagesRead++;
  } while (after && (pagesRead < pages || items.length === 0 || until && !items.some(until)));
  return { items, nextAfter: after ?? null, pagesRead, ...(order ? { order } : {}) };
}
