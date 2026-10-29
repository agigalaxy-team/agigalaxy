import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsDraftMemory,settingsOperatorId} from '../src/lib/settings-draft-memory.ts';
const operationId='8e04057f-097c-46fa-b2da-34d60ac5d760';
test('settings snapshots are closed memory-only values tied to verified business identity and the original login',()=>{
 const memory=createSettingsDraftMemory(),user={id:'cms-document-12',collection:'operators',verifiedOperator:true,externalId:'real-business-principal'};
 assert.equal(settingsOperatorId(user),'real-business-principal');assert.equal(settingsOperatorId({...user,verifiedOperator:false}),null);
 const first=memory.open(settingsOperatorId(user),'first-login'),draft={draft:null,reasons:{saved:'local only'},positions:[],arbitraryResponse:'must drop'};
 first.write('search',draft);const value=first.read('search');assert.equal(value.arbitraryResponse,undefined);value.reasons.saved='mutated outside store';assert.equal(first.read('search').reasons.saved,'local only');
 assert.equal(memory.open(settingsOperatorId(user),'first-login'),first);assert.equal(first.current(),true);
 const next=memory.open(settingsOperatorId(user),'new-login');assert.equal(first.current(),false);assert.equal(next.read('search'),null);first.write('search',draft);assert.equal(next.read('search'),null);
 next.write('search',draft);memory.observeIdentity(null);assert.equal(next.current(),false);assert.equal(memory.open(settingsOperatorId(user),'new-login').read('search'),null);
 const original=memory.open(settingsOperatorId(user),'new-login');original.write('search',draft);memory.observeIdentity('another-business-principal');assert.equal(original.current(),false);assert.equal(memory.open('another-business-principal','same-token-string').read('search'),null);
});
test('pending memory keeps only the original receipt coordinates and excludes secrets instead of persisting a command body',()=>{
 const memory=createSettingsDraftMemory(),session=memory.open('principal','login');
 session.setPending('models',{operationId,kind:'credential-provision',apiKey:'SYNTHETIC_NOT_SECRET',body:{apiKey:'SYNTHETIC_NOT_SECRET'}});assert.deepEqual(session.pending('models'),{operationId,kind:'credential-provision'});
 assert.throws(()=>session.setPending('smtp',{operationId,kind:'apply'}),/Invalid/);assert.throws(()=>session.write('unknown-scope',{}),/Unknown/);
 assert.throws(()=>session.write('models',{configuration:{models:[{apiKey:'SYNTHETIC_NOT_SECRET'}]}}),/Excluded/);
 session.write('search',{draft:null,reasons:{draft:'safe'},positions:[]});session.setPending('search',{operationId,kind:'draft'});session.clear('search');assert.equal(session.read('search'),null);assert.equal(session.pending('search').operationId,operationId);session.setPending('search',null);assert.equal(session.pending('search'),null);
});


test('AI duty drafts preserve the explicitly selected inspection profile',()=>{
 const memory=createSettingsDraftMemory(),session=memory.open('principal','login');
 const config={id:operationId,domain:'overview',revision:1,enabled:false,mode:'ai',schedule:{kind:'interval',minutes:60,timezone:'Asia/Shanghai'},purpose:'',goal:'',prompt:'',promptVersion:1,planVersion:1,delegationVersion:null,plan:{strategyIds:[],grantIds:[],actions:[],resourceIds:[],eventTypes:[],inspectionProfile:'current-operations-v1'}};
 session.write('ai-work',{dutyDrafts:{overview:{configuration:config,base:config}}});const saved=session.read('ai-work').dutyDrafts.overview;assert.equal(saved.configuration.plan.inspectionProfile,'current-operations-v1');assert.equal(saved.base.plan.inspectionProfile,'current-operations-v1');
});
