import assert from 'node:assert/strict';
import test from 'node:test';
import {searchQualityLocation,searchQualityHref,searchQualityOverviewPath,searchQualityHistoryPath,searchQualityOperationPath,searchQualityNext,searchQualityPrevious,searchQualityOverview,searchQualityHistory,searchQualityDraft,searchQualityDraftBody,searchQualityDifferences,searchQualityOperationResult,searchQualityPhase,searchQualitySettings,searchQualityNumber,searchQualityPercent} from '../src/lib/search-quality-view-model.ts';

const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-'+String(n).padStart(12,'0');
const stamp='2026-10-23T07:00:00.000Z',lease={checkedAt:1792738800,readExpiresAt:1792738830,metadataOnly:true};
const fixed={currentSource:true,anonymousPublic:true,withdrawnExcluded:true,expiredExcluded:true},settings={synonyms:[{term:'同步',alternatives:['sync']}],rankingMode:'relevance',fixedConstraints:fixed};
const version={id:id(1),version:1,settings,kind:'draft',createdAt:stamp,operatorId:'real-reader',restoredFrom:null,restorable:true};
const config={revision:3,active:version,draft:{...version,id:id(2),version:2,restorable:false},native:{state:'available',settings},pending:null};
const metric={searches:0,measuredSearches:0,resultKnownSearches:0,noResults:null,noResultRate:null,clicks:null,clickedSearches:null,clickRate:null,followUps:null,scanLimited:null};
const overview=()=>({...lease,period:{from:'2026-10-16T07:00:00.000Z',to:stamp,days:7},metrics:metric,trend:{items:[],availability:'not-collected'},queries:{items:[{...metric,key:'sync',label:'Sync',issueCodes:['unmeasured']}],nextAfter:null},configuration:structuredClone(config),capabilities:{canConfigure:true,canPublish:true,canRestore:true},basis:{source:'meilisearch-community',metricsSource:'openpanel-native-and-galaxy-request-bound-events',qualityCollection:'request-bound-only',historicalBackfill:false,model:'not-configured'}});

test('query quality keeps UI tabs/selection and opaque or history cursors separate from precise API filters',()=>{
 const at=Buffer.from(JSON.stringify('sync')).toString('base64url'),location=searchQualityLocation({tab:'queries',days:'30',query:'同步',issue:'scan-limited',after:at,trail:'first',word:'sync',version:id(1),role:'administrator',operatorId:'forged'});
 assert.deepEqual(searchQualityLocation(Object.fromEntries(new URL(searchQualityHref(location),'https://test.invalid').searchParams)),location);
 assert.deepEqual([...new URL(searchQualityOverviewPath(location),'https://test.invalid').searchParams],[['days','30'],['query','同步'],['issue','scan-limited'],['limit','20'],['after',at]]);
 assert.ok(!searchQualityOverviewPath({...location,tab:'draft'}).includes('after='));
 assert.deepEqual(searchQualityPrevious(location),{after:'',trail:[]});assert.deepEqual(searchQualityNext({...location,after:'',trail:[]},at),{after:at,trail:['first']});
 assert.equal(searchQualityLocation({tab:'history',after:at}).after,'');assert.equal(searchQualityLocation({tab:'history',after:'9223372036854775808'}).after,'');
 assert.equal(searchQualityHistoryPath('20'),'/v1/operations/search-quality/history?limit=20&after=20');assert.equal(searchQualityOperationPath('operator-supplied-secret'),null);
 assert.deepEqual(searchQualityLocation({tab:'preview',days:'14',issue:'exclude-category',query:'x\nsecret'}),{tab:'queries',days:7,query:'',issue:'all',after:'',trail:[],word:'',version:''});
});

test('quality projection preserves unknown rates versus real zero and ignores unrelated payload fields',()=>{
 const raw=overview();raw.metrics.password='NEVER_SHOW';raw.queries.items[0].body='NEVER_SHOW';raw.configuration.active.native_settings={password:'NEVER_SHOW'};raw.metrics.clickRate=1.5;
 const value=searchQualityOverview(raw);assert.ok(value);assert.equal(value.metrics.searches,0);assert.equal(value.metrics.clicks,null);assert.equal(value.metrics.clickRate,null);assert.equal(value.queries.items[0].noResultRate,null);assert.ok(!JSON.stringify(value).includes('NEVER_SHOW'));
 assert.equal(searchQualityNumber(0),'0');assert.equal(searchQualityNumber(null),'—');assert.equal(searchQualityPercent(.082),'8.2%');assert.equal(searchQualityPercent(null),'—');
 assert.equal(searchQualityOverview({...raw,basis:{...raw.basis,qualityCollection:'all-old-clicks'}}),null);assert.equal(searchQualityOverview({...raw,readExpiresAt:raw.checkedAt+900}),null);
});

test('draft keeps original revision, normalizes explicit synonyms and fixed eligibility cannot be disabled or replaced with active exclusions',()=>{
 const draft=searchQualityDraft(config);draft.reason='修订同义表达';draft.rows=[{term:'ＳＹＮＣ',alternatives:'同步、同步,更新'}];draft.rankingMode='newest';
 const body=searchQualityDraftBody(draft);assert.deepEqual(body,{expectedRevision:3,settings:{synonyms:[{term:'sync',alternatives:['同步','更新']}],rankingMode:'newest',fixedConstraints:fixed},reason:'修订同义表达'});assert.equal(body.operationId,undefined);assert.equal(body.exclusions,undefined);
 assert.equal(searchQualityDraftBody({...draft,reason:''}),null);assert.equal(searchQualityDraftBody({...draft,rows:[...draft.rows,{term:'sync',alternatives:'副本'}]}),null);assert.equal(searchQualityDraftBody({...draft,rows:[{term:'__proto__',alternatives:'x'}]}),null);
 assert.equal(searchQualitySettings({...settings,fixedConstraints:{...fixed,anonymousPublic:false}}),null);
 const changed={...config,revision:4,draft:{...version,version:3,settings:{...settings,rankingMode:'newest'}}};assert.equal(searchQualityDifferences(draft,changed).changed,true);assert.equal(searchQualityDraftBody(draft).expectedRevision,3);assert.equal(searchQualityDifferences(draft,changed).current.rankingMode,'newest');
});

test('uncaptured or unsupported native baseline never becomes a fabricated active version or relevance default',()=>{
 const raw=overview();raw.configuration={revision:0,active:null,draft:null,native:{state:'available',settings:null},pending:null};
 const value=searchQualityOverview(raw);assert.ok(value);assert.equal(value.configuration.active,null);const draft=searchQualityDraft(value.configuration);assert.equal(draft.rankingMode,'');assert.equal(draft.base,null);draft.reason='明确采用排序';assert.equal(searchQualityDraftBody(draft),null);
 draft.rankingMode='newest';assert.ok(searchQualityDraftBody(draft));assert.deepEqual(searchQualityDraftBody(draft).settings.fixedConstraints,fixed);
});

test('native accepted/pending/unknown operations remain distinct from applied and draft applied only means saved',()=>{
 const op={...lease,operationId:id(3),kind:'apply',versionId:id(2),phase:'task-pending',errorCode:null,recordedAt:stamp,updatedAt:stamp,replayed:false,taskId:55};
 const value=searchQualityOperationResult(op);assert.ok(value);assert.equal(searchQualityPhase(value),'等待生效');assert.equal(value.taskId,undefined);assert.equal(searchQualityPhase({...value,phase:'result-unknown'}),'生效结果待确认');assert.equal(searchQualityPhase({...value,kind:'draft',phase:'applied'}),'草稿已保存');assert.equal(searchQualityPhase({...value,phase:'applied'}),'已生效');assert.equal(searchQualityOperationResult({...op,phase:'enqueued-success'}),null);
});

test('restoration uses real restorable versions and closed actual deltas, never free native JSON or inferred identity',()=>{
 const event={id:id(3),sequence:'20',kind:'apply',operatorId:'actual-reader',versionId:id(1),version:1,phase:'applied',changes:{synonyms:{before:null,after:settings.synonyms},rankingMode:{before:null,after:'relevance'},password:{before:'NEVER_SHOW',after:'NEVER_SHOW'}},reason:'实际操作说明',createdAt:stamp};
 const value=searchQualityHistory({...lease,items:[event],versions:[version,{...version,id:id(2),version:2,restorable:false},{...version,id:id(4),version:0,settings:null,kind:'baseline'}],nextAfter:'19'});
 assert.ok(value);assert.equal(value.versions[0].restorable,true);assert.equal(value.versions[1].restorable,false);assert.equal(value.versions[2].settings,null);assert.deepEqual(value.items[0].changes,{synonyms:{before:null,after:settings.synonyms},rankingMode:{before:null,after:'relevance'}});assert.equal(value.items[0].operatorId,'actual-reader');assert.ok(!JSON.stringify(value).includes('NEVER_SHOW'));assert.equal(searchQualityHistory({...lease,items:[],versions:[{...version,restorable:undefined}],nextAfter:null}),null);
});
