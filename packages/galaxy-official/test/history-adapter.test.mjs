import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGalaxyAdapter } from '../../../integrations/host-adapters/opencode-stable/galaxy.tui.ts';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';

test('native adapter filters history and confirms authorized and local-draft submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-history-adapter-'));
  const previous = process.env.GALAXY_DATA_DIR;
  process.env.GALAXY_DATA_DIR = directory;
  const layers = []; let page;
  const requests = [], submissions = [], publications = [];
  const draft = { consentId: 'fixture-consent', payloadJson: '{"kind":"revision","summary":"Selected work revision"}' };
  const subjectId = 'GUID' + '0'.repeat(28);
  const controller = { cancel() {},
    checkRemote:async()=>({state:'active'}),
    getCase:async caseId=>({caseId,version:1,state:'open',events:[{id:'source-event',version:1,kind:'case',title:'Rebuilt history'}],reviews:[]}),
    prepareCaseReview:async()=>{throw new Error('No implicit preparation');},executeCaseReview:async()=>{throw new Error('No implicit execution');},
    queryModeration:async()=>({items:[],nextAfter:null}),
    status: async () => ({ endpoint: 'https://official.example.org', subjectId, state: 'session-local', scopes: ['binding', 'history', 'case-teaser', 'consent', 'moderation'] }),
    listPublicationDrafts: async () => [{ localCaseId: 'local-case', title: 'Selected draft', status: 'not-prepared' }],
    preparePublication: async (id, options) => {
      assert.equal(id, 'local-case'); assert.equal(options.visibility, 'Public');
      return { endpoint: 'https://official.example.org', payloadJson: draft.payloadJson, intentJson: '{"visibility":"Public"}', confirmation: 'PUBLISH fixture' };
    },
    executePublication: async (preview, confirmation) => { publications.push({ preview, confirmation }); return { eventId: 'published', caseId: 'case', version: 1 }; },
    prepareCase: async request => ({ ...request, endpoint: 'https://official.example.org', confirmation: 'CONFIRM fixture' }),
    executeCase: async (preview, confirmation) => { submissions.push({ preview, confirmation }); return { eventId: 'event', caseId: 'case', version: 2 }; },
    queryHistory: async input => { requests.push(input); return { pageSummary:{ciSources:{proofRecordCount:2,sourceGroupCount:1,duplicateProofRecordCount:1}},refresh:{mode:'on-demand',state:'rebuilt',backgroundQueue:false,checkedAt:2000000000},items: [{caseId:'case',title:'Rebuilt history',summary:'Fixture',state:'open',results:[{id:'failure',outcome:'failed',summary:'Later failure',failureReason:'Regression reported',limitations:['Not independently verified']}],matchReasons:[],
      fieldPolicy:{id:'history-fields',version:1,view:'owner'},reportedProgress:{latestResultId:'failure',timeline:[{resultId:'success',attemptId:'attempt',outcome:'succeeded',sourceEventVersion:3,corrected:false},{resultId:'failure',attemptId:'attempt',outcome:'failed',sourceEventVersion:4,corrected:false}],subsequentReports:[{previousSuccessId:'success',resultId:'failure',attemptRelation:'same-attempt',regressionVerified:false}]},
      searchExplanation:{sourceType:'case-history',order:'case-id',scope:'current-authorized-view',checkedAt:2000000000,textMatches:[{term:'compiler',fields:['title']}],capabilityMatches:[{capabilityId:'compiler',assistanceId:'collaboration',authority:'requester-declared-requirement'}],verification:{strength:'ci-execution-fact',proofIds:[],meaning:'Fixture'},limitations:['CI does not verify individual capability.']},
      moderationContext:{coverage:'fixture',items:[{reportId:'review',state:'resolved',paused:false,events:[{kind:'resolve',verdict:'dismissed',summary:'Later decision'}],revalidation:{generation:2,state:'completed'}}]},
      rebuild:{rule:{id:'case-history',version:1},sourceVersion:1,contentHash:'a'.repeat(64),sources:{events:[{id:'source-event',kind:'case',version:1}],proofIds:[],capsuleUseIds:[]}},
      rebuildComparison:{state:'changed',reasons:['visible-content-changed']},
      proofs:[{proofId:'ci-proof',status:'active',provenance:{sourceKey:'github-actions:repository:123:run:12345:attempt:1',sourceControl:{repositoryOwner:{id:77,login:'fixture',type:'Organization'}}}}],
      participants:[{subjectId:'declared-person',role:'requester'}],attempts:[{id:'attempt',configuration:{environment:'Node',version:'24',tools:[]}}],
      collaborationContext:{capabilityIds:['compiler'],items:[{assistanceId:'collaboration',capabilityId:'compiler',requestedScope:'Inspect build',participantLinks:[{subjectId:'confirmed-person',role:'provider',eventId:'confirmation',authority:'signed-participation-confirmation'}]}]}}], nextCursor: null }; } };
  const api = { keymap: { registerLayer(layer) { layers.push(layer); return () => { const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1); }; } },
    ui: { dialog: { setSize() {}, clear() {}, replace(factory) { factory(); } },
      DialogSelect(value) { page = { ...value, kind: 'select' }; },
      DialogPrompt(value) { page = { ...value, kind: 'prompt' }; },
      DialogAlert(value) { page = { ...value, kind: 'alert' }; } } };
  const viewText = () => [page?.title,page?.message,...(page?.options??[]).flatMap(value=>[value.title,value.description])].filter(Boolean).join('\n');
  const command = name => {
    const item = layers.flatMap(layer => layer.commands).find(item => item.name === name);
    assert.ok(item, name); item.run();
  };
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Adapter transition timed out.'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
    await createGalaxyAdapter(controller, { readCaseSubmission: async () => draft }).tui(api);
    const openConnection = async () => {
      command('galaxy.open'); await wait(() => page?.kind === 'select' && page.options.some(option => option.value === '1' && option.title.includes('找帮助')));
      command('galaxy.choose.4'); await wait(() => viewText().includes('我的与设置'));
      command('galaxy.choose.6'); await wait(() => viewText().includes('本机会话可用'));
    };
    await openConnection();
    command('galaxy.choose.4'); await wait(() => viewText().includes('履历筛选'));
    command('galaxy.choose.5'); assert.equal(page.kind, 'prompt');
    page.onConfirm('Node'); await wait(() => page.kind === 'select');
    assert.equal(requests.length, 0);
    command('galaxy.choose.6'); page.onConfirm('2026-02-30');
    await wait(() => page.kind === 'alert'); assert.match(page.message, /有效日期/);
    page.onConfirm(); await wait(() => page.kind === 'select');
    command('galaxy.choose.6'); page.onConfirm('2026-01-01'); await wait(() => page.kind === 'select');
    command('galaxy.choose.9');await wait(()=>viewText().includes('更多检索条件'));command('galaxy.choose.1');page.onConfirm('invalid capability');
    await wait(()=>page.kind==='alert');assert.match(page.message,/Capability ID/);page.onConfirm();await wait(()=>viewText().includes('履历筛选'));
    command('galaxy.choose.9');command('galaxy.choose.1');page.onConfirm('compiler');await wait(()=>viewText().includes('履历筛选'));
    command('galaxy.choose.9');command('galaxy.choose.2');command('galaxy.choose.3');await wait(()=>viewText().includes('履历筛选'));
    assert.equal(requests.length,0);
    command('galaxy.choose.8'); await wait(() => requests.length === 1);
    assert.deepEqual(requests[0], { query: '', limit: 8, environment: 'Node', subjectId, createdFrom: '2026-01-01T00:00:00.000Z',capabilityId:'compiler',verificationStrength:'ci-execution-fact' });
    await wait(() => viewText().includes('可见履历')); assert.match(viewText(),/2 \/ 1 \/ 1/); assert.match(viewText(),/不作为独立证据计数/);
    assert.match(viewText(),/检查时间/);
    command('galaxy.choose.1');await wait(()=>page.kind==='alert');
    assert.match(page.message,/Later failure/);assert.match(page.message,/Regression reported/);assert.ok(!page.message.includes('source-event'));assert.ok(!page.message.includes('a'.repeat(64)));
    page.onConfirm();await wait(()=>page.kind==='select'&&viewText().includes('履历后续操作'));command('galaxy.choose.6');await wait(()=>page.kind==='alert');
    assert.match(page.message,/case-history@1/);assert.match(page.message,/source-event/);assert.match(page.message,/来源或可见内容有变化/);
    assert.match(page.message,/非认证/);assert.match(page.message,/compiler/);assert.match(page.message,/confirmed-person/);assert.match(page.message,/Node/);
    assert.match(page.message,/报告失败/);assert.match(page.message,/回归未核验/);assert.match(page.message,/失败说明/);assert.match(page.message,/同一尝试/);
    assert.match(page.message,/独立处理沿革/);assert.match(page.message,/Later decision/);assert.match(page.message,/Evidence验证轮次: 2/);
    assert.match(page.message,/检索解释/);assert.match(page.message,/请求者声明的工作需求/);assert.match(page.message,/CI does not verify/);
    assert.match(page.message,/github-actions:repository:123:run:12345:attempt:1/);assert.match(page.message,/fixture \/ 77/);assert.match(page.message,/未证明提交者控制权/);
    page.onConfirm();await wait(()=>page.kind==='select'&&viewText().includes('履历后续操作'));
    command('galaxy.choose.3');await wait(()=>page.kind==='select'&&viewText().includes('Case所有者记录'));
    command('galaxy.zero');await wait(()=>viewText().includes('可见履历'));
    command('galaxy.choose.1');await wait(()=>page.kind==='alert');page.onConfirm();await wait(()=>viewText().includes('履历后续操作'));
    command('galaxy.choose.5');await wait(()=>viewText().includes('Case独立处理'));assert.match(viewText(),/case/);
    command('galaxy.zero');await wait(()=>viewText().includes('可见履历'));
    command('galaxy.zero'); await wait(() => viewText().includes('本机会话可用'));
    command('galaxy.choose.5'); await wait(() => page.kind === 'select' && page.options.some(option => option.title.includes('允许本次内容与范围')));
    assert.match(viewText(), /Selected work revision/); assert.equal(submissions.length, 0);
    command('galaxy.choose.2'); await wait(() => page.kind === 'alert');
    assert.ok(page.message.includes(draft.payloadJson)); assert.equal(submissions.length, 0);
    page.onConfirm(); await wait(() => page.kind === 'select');
    const oldAllow = page.options.find(option => option.value === '1').onSelect;
    command('galaxy.choose.1'); await wait(() => submissions.length === 1);
    assert.equal(submissions[0].preview.payloadJson, draft.payloadJson);
    assert.equal(submissions[0].confirmation, 'CONFIRM fixture');
    await oldAllow(); assert.equal(submissions.length, 1);
    await wait(() => page.kind === 'alert' && page.message.includes('工作内容已保存'));
    page.onConfirm(); await wait(() => viewText().includes('本机会话可用'));
    command('galaxy.choose.6'); await wait(() => viewText().includes('本地草稿'));
    command('galaxy.choose.1'); assert.match(viewText(), /选择可见性/);
    command('galaxy.choose.2'); await wait(() => page.kind === 'select' && page.options.some(option => option.title.includes('允许本次内容与范围')));
    assert.match(viewText(), /可见范围：所有人/); assert.equal(publications.length, 0);
    command('galaxy.choose.1'); await wait(() => publications.length === 1);
    assert.equal(publications[0].confirmation, 'PUBLISH fixture');
    await wait(()=>page.kind==='alert');page.onConfirm();await wait(()=>viewText().includes('本机会话可用'));
    command('galaxy.choose.3');await wait(()=>viewText().includes('设备与本人资料'));
    assert.ok(page.options.some(option=>option.title.includes('我的资料')));
    command('galaxy.choose.6');await wait(()=>page.kind==='select'&&viewText().includes('我的资料'));
    assert.match(viewText(),/自述（未经认证）/);assert.match(viewText(),/事实派生履历/);
    let typedRequest;
    controller.querySearch=async input=>{typedRequest=input;return {type:input.type,items:[],nextCursor:null};};
    await openConnection();
    assert.ok(page.options.some(option=>option.title.includes('分类型搜索')));
    command('galaxy.choose.4');await wait(()=>viewText().includes('选择检索来源'));
    assert.deepEqual(page.options.map(option=>option.title),['[1] 工作','[2] 事实履历']);
    command('galaxy.choose.1');await wait(()=>viewText().includes('查找工作'));
    command('galaxy.choose.2');await wait(()=>typedRequest&&viewText().includes('工作 · 0'));
    assert.deepEqual(typedRequest,{type:'case',query:{query:'',limit:8}});
    command('galaxy.zero');await wait(()=>viewText().includes('查找工作'));
    command('galaxy.choose.4');await wait(()=>viewText().includes('履历筛选'));
  } finally {
    if (previous === undefined) delete process.env.GALAXY_DATA_DIR; else process.env.GALAXY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
