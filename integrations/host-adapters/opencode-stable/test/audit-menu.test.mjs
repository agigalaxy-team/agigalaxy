import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditMenu } from '../audit-menu.mjs';
const wait = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Menu did not settle'); };
test('native audit menu reads bounded pages, exports explicitly and confirms the exact reviewer scope once', async () => {
  let page, prepared, exports = 0, approvals = 0;
  const subjectId = 'GUID' + 'A'.repeat(28), readerId = 'GUID' + 'B'.repeat(28);
  const preview = { id: 'fixture', endpoint: 'https://fixture.example', payloadJson: '{}', confirmation: 'CONFIRM fixture' };
  const menu = createAuditMenu({ language: 'zh-CN', isCurrent: () => true, onBack() {}, availableScopes: ['audit', 'audit-review'],
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; }, controller: {
      cancel() {}, async prepareAudit(input) { prepared = input; preview.payloadJson=JSON.stringify(input); return preview; },
      async executeAudit(value, confirmation) { assert.equal(value, preview); assert.equal(confirmation, preview.confirmation); approvals++; return { id: 'fixture' }; },
      async readAudit(method, input) {
        if (method === 'config') return { subjectId, canReview: true };
        if (method === 'grants') return { items: [] };
        if (method === 'export') { exports++; assert.equal(input.through, '2'); return { filename: 'audit.json', items: [] }; }
        assert.equal(input.subjectId, subjectId); return { items: [], through: '2', nextAfter: null };
      } } });
  const choose = title => { const option = page.options.find(item => item.title === title); assert.ok(option, title); page.routes[option.number](); };
  menu.open(); await wait(() => page.kind === 'select'); choose('查询自己的操作');
  for (const value of [subjectId, '', '']) page.onConfirm(value);
  await wait(() => page.kind === 'select'); assert.equal(exports, 0); choose('导出当前页 JSON');
  await wait(() => page.kind === 'info' && page.message.includes('audit.json')); assert.equal(exports, 1);
  menu.open(); await wait(() => page.kind === 'select'); choose('审批他人访问');
  for (const value of [readerId, subjectId, 'query,export', 'incident-001', '600']) page.onConfirm(value);
  await wait(() => page.kind === 'select' && page.options.some(o=>o.title==='允许本次内容与范围'));
  assert.deepEqual(prepared.subjectIds, [subjectId]); assert.deepEqual(prepared.actions, ['query', 'export']); assert.equal(approvals, 0);
  const scope = page.options.find(option => option.number === '1').description;
  assert.ok(scope.includes(readerId)); assert.ok(scope.includes(subjectId)); assert.match(scope, /query/); assert.match(scope, /export/);
  assert.equal(page.title.includes(preview.confirmation), false);
  page.routes[2](); assert.equal(page.kind, 'info'); assert.ok(page.message.includes(preview.payloadJson)); assert.equal(approvals, 0);
  page.onBack(); const oldAllow = page.routes[1];
  page.routes[1](); await wait(() => approvals === 1); assert.equal(prepared.lifetimeSeconds, 600);
  oldAllow(); assert.equal(approvals, 1);
});
