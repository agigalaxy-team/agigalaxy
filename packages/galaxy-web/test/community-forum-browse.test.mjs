import test from 'node:test';
import assert from 'node:assert/strict';
import { forumBrowsePath, forumBrowseSelection, forumBrowsePosition, readForumBrowsePosition, saveForumBrowsePosition, forumBodyParagraphs, forumLinkLabel, readForumPages } from '../src/community-forum-browse.mjs';

const scope = { endpoint: 'https://galaxy.example', subjectId: 'reader-a' };
const route = forumBrowsePath({ topic: 'technology', query: '跨页 资料' });
const store = () => {
  const rows = new Map();
  return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) };
};

test('topic and search survive compose without becoming identity or content form fields', () => {
  const target = forumBrowsePath({ topic: 'technology', query: '跨页 资料', compose: true });
  assert.deepEqual(forumBrowseSelection(target.split('?')[1], ['technology', 'arts']), { topic: 'technology', query: '跨页 资料' });
  assert.equal(forumBrowseSelection('?topic=other&q=', ['technology']).topic, '');
  assert.equal(forumBrowseSelection('?topic=unclassified', ['technology']).topic, 'unclassified');
});

test('return retains loaded pages and the original card viewport position, never content', () => {
  const storage = store();
  const position = saveForumBrowsePosition({ storage, scope, route, pages: 3, y: 3120, anchor: 'forum-post-11111111-1111-4111-8111-111111111111', offset: 112 });
  assert.deepEqual(readForumBrowsePosition({ storage, scope, route, state: {} }), position);
  assert.equal(position.pages, 3);
  assert.equal(position.offset, 112);
  assert.equal('payload' in position, false);
  assert.equal(readForumBrowsePosition({ storage, scope, route: '/app/community', state: { forumBrowseReturn: position } }), null);
  assert.equal(readForumBrowsePosition({ storage, scope, route, state: { forumBrowseFocus: { route, target: 'results' } } }), null);
  assert.deepEqual(readForumBrowsePosition({ storage, scope, route, state: { forumBrowseFocus: { route: '/app/community?topic=arts', target: 'topic' } } }), position);
});

test('private browsing positions cannot cross identity or server; public visitor context can continue after login', () => {
  const storage = store();
  const ownRoute = forumBrowsePath({ section: 'owned', topic: 'arts' });
  const own = saveForumBrowsePosition({ storage, scope, route: ownRoute, pages: 2, y: 500 });
  assert.equal(forumBrowsePosition(own, { ...scope, subjectId: 'reader-b' }, ownRoute), null);
  assert.equal(forumBrowsePosition(own, { ...scope, endpoint: 'https://other.example' }, ownRoute), null);
  const visitor = saveForumBrowsePosition({ storage, scope: { ...scope, subjectId: null }, route, pages: 2, y: 800 });
  assert.deepEqual(readForumBrowsePosition({ storage, scope, route, state: {} }), visitor);
  assert.equal(forumBrowsePosition({ ...own, route: 'https://elsewhere.example' }, scope, ownRoute), null);
});

test('blocked storage does not interrupt navigation and malformed records do not drive paging', () => {
  const storage = { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } };
  const position = saveForumBrowsePosition({ storage, scope, route, pages: 2, y: 40 });
  assert.deepEqual(readForumBrowsePosition({ storage, scope, route, state: { forumBrowse: position } }), position);
  assert.equal(forumBrowsePosition({ ...position, pages: 1e9 }, scope, route), null);
});

test('paragraphs preserve line breaks and links are readable without remote preview fetching', () => {
  assert.deepEqual(forumBodyParagraphs('第一段\r\n同一段\r\n\r\n第二段'), ['第一段\n同一段', '第二段']);
  assert.deepEqual(forumLinkLabel('https://example.com/%E8%B5%84%E6%96%99?q=1#part'), { host: 'example.com', detail: '/资料?q=1#part', href: 'https://example.com/%E8%B5%84%E6%96%99?q=1#part' });
  assert.equal(forumLinkLabel('javascript:alert(1)'), null);
  assert.equal(forumLinkLabel('https://name:password@example.com/'), null);
});

test('empty permission-filtered pages continue and a moved return target is read beyond its former page', async () => {
  const pages = [
    { items: [], nextAfter: 'cursor-a', order: 'published' },
    { items: [{ id: 'new-post' }], nextAfter: 'cursor-b', order: 'published' },
    { items: [{ id: 'original-post' }], nextAfter: 'cursor-c', order: 'published' },
  ];
  const read = async after => pages[after === undefined ? 0 : after === 'cursor-a' ? 1 : 2];
  const first = await readForumPages(read, 1, () => true);
  assert.equal(first.pagesRead, 2);
  assert.deepEqual(first.items, [{ id: 'new-post' }]);
  const restored = await readForumPages(read, 2, () => true, undefined, item => item.id === 'original-post');
  assert.equal(restored.pagesRead, 3);
  assert.deepEqual(restored.items.map(item => item.id), ['new-post', 'original-post']);
  assert.equal(restored.nextAfter, 'cursor-c');
});

test('a changed reading lease discards later pages and repeating cursors stop safely', async () => {
  let valid = true;
  const changed = await readForumPages(async () => { valid = false; return { items: [{ id: 'old-identity' }], nextAfter: null }; }, 1, () => valid);
  assert.equal(changed, null);
  await assert.rejects(readForumPages(async () => ({ items: [], nextAfter: 'same' }), 1, () => true), /分页位置/);
});
