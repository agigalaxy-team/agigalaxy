import test from 'node:test';
import assert from 'node:assert/strict';
import { createA2aMenu,readableLegacyA2aResult } from '../../../integrations/host-adapters/opencode-stable/a2a-menu.mjs';
const wait = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('A2A menu did not settle'); };

test('native A2A menu selects endpoint/Attempt/text and requires exact confirmation', async () => {
  let page, prepared, writes = 0, canceled = 0, current = true;
  const peer = { id: 'p1', name: 'Peer 1', endpoint: 'https://peer.example.org/a2a', peerPrincipal: 'account' };
  const preview = { endpoint: peer.endpoint, payloadJson: '{"text":"selected text"}', confirmation: 'CONFIRM A2A HOST fixture' };
  const link={id:'original-link',caseId:'case',attemptId:'attempt',status:'observed',peer:{taskId:'task',state:'working',text:'Current peer response'}};
  const menu = createA2aMenu({ controller: {
    async status(){return{subjectId:'connected-owner'};},
    async queryHistory(input){assert.equal(input.subjectId,'connected-owner');return{items:[{caseId:'case',title:'Current work',attempts:[{id:'attempt',approach:'Existing attempt'}]}]};},
    async readA2a(method) { return method==='peers'?[peer]:method==='list'?[link]:link; },
    async getCase(id) { assert.equal(id, 'case'); return { caseId: id, events: [{kind:'case',title:'Current work'},{ kind: 'attempt', id: 'attempt', sequence: 1, approach: 'Existing attempt' }] }; },
    async prepareA2a(input) { prepared = input; return preview; },
    async executeA2a(p, value) { assert.equal(p, preview); assert.equal(value, preview.confirmation); writes++; return link; },
    cancel() { canceled++; },
  }, language: 'zh-CN', availableScopes: ['case-teaser','history'], isCurrent: () => current, onBack() {},
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; } });
  const choose = text => { const item = page.options.find(o => o.title.includes(text)); assert.ok(item, text); page.routes[item.number](); };
  menu.open(); await wait(() => page.kind === 'select'); choose('Peer 1'); choose('处理当前工作');
  await wait(() => page.kind === 'select'&&page.options.some(o=>o.title==='Current work'));choose('Current work');await wait(()=>page.kind==='prompt');
  page.onConfirm('selected text'); await wait(() => page.kind === 'select' && page.options.some(o => o.title === '允许本次内容与范围'));
  assert.deepEqual(prepared, { peerId: 'p1', kind: 'send', caseId: 'case', attemptId: 'attempt', text: 'selected text' });
  assert.match(page.options[0].description, /selected text/); assert.match(page.options[0].description, /https:\/\/peer.example.org\/a2a/);
  assert.equal(writes, 0); choose('查看来源与完整内容'); assert.equal(page.kind, 'info'); assert.equal(writes, 0);
  assert.ok(page.message.includes(preview.payloadJson)); page.onBack(); const oldAllow = page.routes[1];
  choose('允许本次内容与范围'); await wait(() => page.kind === 'select' && page.title.includes('Current peer response'));
  assert.equal(writes, 1); await oldAllow(); assert.equal(writes, 1);
  current = false; menu.open(); assert.equal(writes, 1); assert.equal(canceled, 0);menu.close();
});

test('native A2A task actions distinguish polling, cancellation and separately consented Result import', async () => {
  let page, prepared, cancels = 0;
  const peer = { id: 'p', name: 'Peer', endpoint: 'https://peer.example.org/a2a', peerPrincipal: 'account' };
  const link = { id: 'link', status: 'observed', caseId: 'case', attemptId: 'attempt', peer: { taskId: 'task', state: 'input-required' } };
  const menu = createA2aMenu({ controller: {
    async readA2a(method) { return method === 'peers' ? [peer] : method === 'list' ? [link] : link; },
    async getCase(id){return{caseId:id,events:[{kind:'case',title:'Existing work'},{kind:'attempt',id:'attempt'}]};},
    async prepareA2a(input) { prepared = input; return { endpoint: peer.endpoint, intentJson: input.kind === 'result' ? 'case.teaser.publish' : '', payloadJson: '{}', confirmation: 'EXACT' }; },
    cancel() { cancels++; },
  }, language: 'zh-CN', availableScopes: ['consent', 'case-teaser'], isCurrent: () => true, onBack() {},
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; } });
  const choose = text => { const item = page.options.find(o => o.title.includes(text)); assert.ok(item, text); page.routes[item.number](); };
  menu.open(); await wait(() => page.kind === 'select'); choose('Peer'); choose('查看已有工作');
  await wait(() => page.kind === 'select'); choose('Existing work'); await wait(() => page.kind === 'select' && page.options.some(o => o.title.includes('补充所需')));
  choose('补充所需'); page.onConfirm('More input'); await wait(() => page.kind === 'select' && page.options.some(o => o.title === '允许本次内容与范围'));
  assert.equal(prepared.kind, 'reply'); choose('取消'); await wait(() => page.kind === 'select');
  choose('请求停止'); await wait(() => page.kind === 'select' && page.options.some(o => o.title === '允许本次内容与范围')); assert.equal(prepared.kind, 'cancel');link.peer.state = 'completed';choose('取消');
  await wait(() => page.kind === 'select' && page.options.some(o => o.title.includes('保留这次')));
  choose('保留这次'); choose('仅自己'); await wait(() => page.kind === 'select' && page.options.some(o => o.title === '允许本次内容与范围'));
  assert.deepEqual(prepared, { peerId: 'p', associationId: 'link', kind: 'result', visibility: 'Private', viewers: [] });
  assert.ok(cancels >= 2); choose('取消');menu.close();
});

test('legacy A2A provenance is separated only for the exact original schema and digest; authored or mismatched limitations remain visible',()=>{
  const link={id:'original-association',caseId:'case',attemptId:'attempt',peer:{state:'completed',responseHash:'a'.repeat(64)}};
  const payload={kind:'result',caseId:'case',attemptId:'attempt',outcome:'succeeded',summary:'Actual peer content',limitations:[
    'External peer report; no independent execution or capability verification.',
    `A2A state: completed; association: ${link.id}; response SHA-256: ${link.peer.responseHash}`,
    'Artifact hashes identify received content/references. Referenced URLs were not fetched; this is not a Proof.'
  ]},preview={payloadJson:JSON.stringify(payload)};
  assert.deepEqual(readableLegacyA2aResult(preview,link).limitations,[]);assert.deepEqual(JSON.parse(preview.payloadJson),payload);
  assert.deepEqual(readableLegacyA2aResult(preview,{...link,id:'different'}),payload);
  const authored={...payload,limitations:[...payload.limitations,'Only covers this actual environment.']};assert.deepEqual(readableLegacyA2aResult({payloadJson:JSON.stringify(authored)},link),authored);
});
