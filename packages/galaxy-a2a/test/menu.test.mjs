import test from 'node:test';
import assert from 'node:assert/strict';
import { createA2aMenu } from '../../../integrations/host-adapters/opencode-stable/a2a-menu.mjs';
const wait = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('A2A menu did not settle'); };

test('native A2A menu selects endpoint/Attempt/text and requires exact confirmation', async () => {
  let page, prepared, writes = 0, canceled = 0, current = true;
  const peer = { id: 'p1', name: 'Peer 1', endpoint: 'https://peer.example.org/a2a', peerPrincipal: 'account' };
  const preview = { endpoint: peer.endpoint, payloadJson: '{"text":"selected text"}', confirmation: 'CONFIRM A2A HOST fixture' };
  const menu = createA2aMenu({ controller: {
    async readA2a(method) { assert.equal(method, 'peers'); return [peer]; },
    async getCase(id) { assert.equal(id, 'case'); return { caseId: id, events: [{ kind: 'attempt', id: 'attempt', sequence: 1, approach: 'Existing attempt' }] }; },
    async prepareA2a(input) { prepared = input; return preview; },
    async executeA2a(p, value) { assert.equal(p, preview); assert.equal(value, preview.confirmation); writes++; return { peer: { state: 'working' } }; },
    cancel() { canceled++; },
  }, language: 'zh-CN', availableScopes: ['case-teaser'], isCurrent: () => current, onBack() {},
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; } });
  const choose = text => { const item = page.options.find(o => o.title.includes(text)); assert.ok(item, text); page.routes[item.number](); };
  menu.open(); await wait(() => page.kind === 'select'); choose('Peer 1'); choose('向已有尝试发送任务');
  page.onConfirm('case'); await wait(() => page.kind === 'select'); choose('Existing attempt');
  page.onConfirm('selected text'); await wait(() => page.kind === 'prompt' && page.title.includes('CONFIRM'));
  assert.deepEqual(prepared, { peerId: 'p1', kind: 'send', caseId: 'case', attemptId: 'attempt', text: 'selected text' });
  assert.equal(writes, 0); page.onConfirm('yes'); assert.equal(page.kind, 'info'); assert.equal(writes, 0);
  page.onBack(); const oldConfirm = page.onConfirm;
  page.onConfirm(preview.confirmation); await wait(() => page.kind === 'info' && page.message.includes('已记录'));
  assert.equal(writes, 1); await oldConfirm(preview.confirmation); assert.equal(writes, 1);
  current = false; menu.open(); assert.equal(writes, 1); assert.equal(canceled, 0);
});

test('native A2A task actions distinguish polling, cancellation and separately consented Result import', async () => {
  let page, prepared, cancels = 0;
  const peer = { id: 'p', name: 'Peer', endpoint: 'https://peer.example.org/a2a', peerPrincipal: 'account' };
  const link = { id: 'link', status: 'observed', caseId: 'case', attemptId: 'attempt', peer: { taskId: 'task', state: 'input-required' } };
  const menu = createA2aMenu({ controller: {
    async readA2a(method) { return method === 'peers' ? [peer] : method === 'list' ? [link] : link; },
    async prepareA2a(input) { prepared = input; return { endpoint: peer.endpoint, intentJson: input.kind === 'result' ? 'case.teaser.publish' : '', payloadJson: '{}', confirmation: 'EXACT' }; },
    cancel() { cancels++; },
  }, language: 'zh-CN', availableScopes: ['consent', 'case-teaser'], isCurrent: () => true, onBack() {},
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; } });
  const choose = text => { const item = page.options.find(o => o.title.includes(text)); assert.ok(item, text); page.routes[item.number](); };
  menu.open(); await wait(() => page.kind === 'select'); choose('Peer'); choose('查看关联任务');
  await wait(() => page.kind === 'select'); choose('link'); await wait(() => page.kind === 'select' && page.options.some(o => o.title.includes('发送补充')));
  choose('发送补充'); page.onConfirm('More input'); await wait(() => page.kind === 'prompt' && page.title.includes('EXACT'));
  assert.equal(prepared.kind, 'reply'); page.onCancel(); await wait(() => page.kind === 'select');
  choose('请求取消'); await wait(() => page.kind === 'prompt'); assert.equal(prepared.kind, 'cancel'); page.onCancel();
  link.peer.state = 'completed'; await wait(() => page.kind === 'select' && page.options.some(o => o.title.includes('导入')));
  choose('导入'); choose('私有'); page.onConfirm(''); await wait(() => page.kind === 'prompt' && page.title.includes('case.teaser.publish'));
  assert.deepEqual(prepared, { peerId: 'p', associationId: 'link', kind: 'result', visibility: 'Private', viewers: [] });
  assert.ok(cancels >= 2); page.onCancel();
});
