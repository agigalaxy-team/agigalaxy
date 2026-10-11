import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataExportMenu } from '../../../integrations/host-adapters/opencode-stable/data-export-menu.mjs';
const wait = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Menu did not settle'); };
test('native export menu creates only on selection and saves only to the explicitly entered directory', async () => {
  let page, creates = 0, saves = 0;
  const menu = createDataExportMenu({ language: 'zh-CN', isCurrent: () => true, onBack() {},
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; }, controller: {
      cancel() {}, async readDataExport(method) {
        if (method === 'specification') return { datasets: ['identity'] };
        assert.equal(method, 'create'); creates++; return { id: 'fixture', endpoint: 'https://fixture.example', subjectId: 'synthetic', expiresAt: 2000000000 };
      }, async saveDataExport(id, directory) { assert.equal(id, 'fixture'); assert.equal(directory, '/explicit/user/directory'); saves++; return { directory, files: 1, totalRows: 1 }; } } });
  menu.open(); await wait(() => page.kind === 'select'); assert.equal(creates, 0); assert.equal(saves, 0);
  page.routes[1](); assert.equal(page.kind, 'prompt'); assert.equal(creates, 0);assert.equal(saves, 0);
  page.onConfirm('/explicit/user/directory'); await wait(() => page.kind === 'select' && page.title.includes('已保存到本机')); assert.equal(creates,1);assert.equal(saves, 1);
});
test('native export chooses a currently readable record and saves only that view without a typed internal ID or broadening to all own data', async () => {
  let page, selection;
  const id = '83f6d1c8-0aab-4c52-8152-38132f543e27';
  const menu = createDataExportMenu({ language: 'zh-CN', isCurrent: () => true, onBack() {},
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; }, controller: {
      cancel() {},async queryAssistance(){return{items:[{id:'parent-request',title:'Original collaboration'}]};},async queryContext(assistanceId){assert.equal(assistanceId,'parent-request');return{items:[{id,title:'Chosen readable material',scope:'Original shared scope'}]};},async saveDataExport(ticket,directory){assert.equal(ticket,id);assert.equal(directory,'/chosen/directory');return{directory,files:1,totalRows:1};}, async readDataExport(method, input) {
        if (method === 'specification') return { datasets: ['identity'], viewKinds: ['context'] };
        selection = input; return { id, views: input.views, endpoint: 'https://fixture.example', subjectId: 'synthetic', expiresAt: 2000000000 };
      } } });
  menu.open(); await wait(() => page.kind === 'select');
  page.routes[2](); page.routes[1]();await wait(()=>page.options?.some(o=>o.title==='Original collaboration'));page.routes[1]();await wait(()=>page.options?.some(o=>o.title==='Chosen readable material'));assert.equal(selection,undefined);
  page.routes[1]();await wait(()=>page.kind==='prompt');assert.equal(selection,undefined);page.onConfirm('/chosen/directory');await wait(()=>page.kind==='select'&&page.title.includes('已保存到本机'));
  assert.deepEqual(selection, { datasets: ['authorized-views'], views: [{ kind: 'context', id }] });
  assert.ok(page.title.includes('/chosen/directory'));
});
