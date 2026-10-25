import assert from 'node:assert/strict';
import test from 'node:test';
import {recommendationLocation,recommendationHref,recommendationOverviewPath,recommendationHistoryPath,recommendationNextPage,recommendationPreviousPage,recommendationOverview,recommendationSubjects,recommendationNumber,recommendationPolicyDraft,recommendationPolicyBody,recommendationPolicyDifferences,recommendationThemeDraft,recommendationThemeBody,recommendationHistory,recommendationHistoryDetails} from '../src/lib/recommendation-view-model.ts';

const id='11111111-1111-4111-8111-111111111111',tagId='22222222-2222-4222-8222-222222222222';
const category={key:'category:technology',id:null,label:'技术与工具',kind:'category',version:0,enabled:true,mapping:{categories:['technology'],tagIds:[],queryTerms:[]},source:'forum-category'};
const tag={key:'tag:'+tagId,id:tagId,label:'工具',kind:'tag',version:2,enabled:true,mapping:{categories:[],tagIds:[tagId],queryTerms:[]},source:'forum-tag'};
const theme={key:'theme:'+id,id,label:'跨类需求',kind:'theme',version:1,enabled:true,mapping:{categories:['technology'],tagIds:[tagId],queryTerms:['sync']},source:'operator-mapping'};
const policy={version:4,enabled:false,directions:[{key:theme.key,direction:'increase'}],controls:{avoidRepetition:false,avoidConcentration:true},fixedConstraints:{personalNeeds:true,supply:true,negativeFeedback:true},updatedAt:null,algorithm:'galaxy-opportunity-v1'};
const lease={checkedAt:1792742400,readExpiresAt:1792742430,metadataOnly:true};
const overview=()=>({...lease,period:{from:'2026-10-16T00:00:00Z',to:'2026-10-23T00:00:00Z',days:7},catalog:{items:[category,tag,theme]},mappingCatalog:{items:[category,tag]},topics:{items:[{key:category.key,supply:0,demand:0,exposures:null,clicks:null,bookmarks:null,notInterested:null,availability:{supply:'available',usage:'not-collected'}}]},metrics:{exposures:0,clicks:null,bookmarks:null,notInterested:0},trend:{items:[],availability:'not-collected'},policy,capabilities:{canConfigure:false,canMapThemes:false},basis:{metricsSource:'openpanel-native',topicSource:'galaxy-qualified-usage-events',recommendationAttribution:'request-bound-only',historicalBackfill:false,model:'not-configured'}});

test('same-page topic and return state never become API parameters; history uses a bounded bigint cursor',()=>{
 const location=recommendationLocation({tab:'history',days:'30',id:theme.key,query:'sync',after:'20',trail:'first,40',operatorId:'forged',role:'administrator'});
 assert.deepEqual(recommendationLocation(Object.fromEntries(new URL(recommendationHref(location),'https://local.invalid').searchParams)),location);
 assert.deepEqual([...new URL(recommendationOverviewPath(location),'https://local.invalid').searchParams], [['days','30'],['query','sync']]);
 assert.deepEqual([...new URL(recommendationHistoryPath(location.after),'https://local.invalid').searchParams],[['limit','20'],['after','20']]);
 assert.deepEqual(recommendationPreviousPage(location),{after:'40',trail:['first']});
 assert.deepEqual(recommendationNextPage({...location,after:'',trail:[]},'10'),{after:'10',trail:['first']});
 assert.equal(recommendationLocation({after:'9223372036854775808'}).after,'');assert.equal(recommendationNextPage(location,'0'),null);
 assert.deepEqual(recommendationLocation({tab:'unsafe',days:'14',query:'x\nsecret'}),{tab:'overview',days:7,id:'',query:'',after:'',trail:[]});
});

test('real category and tag identity, zero, unavailable attribution and filtered mapping options remain distinct',()=>{
 const raw=overview();raw.catalog.items=[theme];raw.metrics.secret='hidden';raw.topics.items.push({key:tag.key,supply:null,demand:null,availability:{supply:'partial',usage:'partial'}});
 const projected=recommendationOverview(raw);assert.ok(projected);assert.equal(projected.catalog.items.length,1);assert.equal(projected.mappingCatalog.items.length,2);assert.equal(projected.metrics.exposures,0);assert.equal(projected.metrics.clicks,null);assert.equal(projected.metrics.secret,undefined);
 const rows=recommendationSubjects(recommendationOverview(overview()));assert.equal(rows[0].supply,0);assert.equal(rows[0].demand,0);assert.equal(rows[0].metrics.exposures,null);assert.equal(rows[1].kind,'tag');assert.equal(rows[2].direction,'increase');
 assert.equal(recommendationNumber(0),'0');assert.equal(recommendationNumber(null),'—');assert.equal(recommendationNumber(-1),'—');
 assert.equal(recommendationOverview({...raw,policy:{...policy,fixedConstraints:{...policy.fixedConstraints,personalNeeds:false}}}),null);
 assert.equal(recommendationOverview({...raw,basis:{...raw.basis,recommendationAttribution:'all-site-events'}}),null);
});

test('policy saves retain the original CAS and expose current differences without changing the old intent',()=>{
 const draft=recommendationPolicyDraft(policy,theme.key);draft.direction='decrease';draft.reason='减少集中';const body=recommendationPolicyBody(draft);
 assert.deepEqual(body,{expectedVersion:4,enabled:false,themeKey:theme.key,direction:'decrease',controls:{avoidRepetition:false,avoidConcentration:true},reason:'减少集中'});
 const current={...policy,version:5,enabled:true,directions:[{key:theme.key,direction:'keep'}]};const diff=recommendationPolicyDifferences(draft,current);
 assert.ok(diff.some(item=>item.label==='此主题方向'&&item.current==='保持'&&item.draft==='减少机会'));assert.ok(diff.some(item=>item.label==='启用方向调控'));assert.equal(recommendationPolicyBody(draft).expectedVersion,4);assert.equal(body.operationId,undefined);
 assert.equal(recommendationPolicyBody({...draft,reason:''}),null);
});

test('theme mapping uses actual catalogue choices and exact IDs, never creates a default all-source or fake theme',()=>{
 const empty=recommendationThemeDraft();assert.equal(empty.enabled,false);assert.deepEqual(empty.categories,[]);assert.equal(recommendationThemeBody(empty,[category,tag]),null);
 const draft={...empty,label:'跨类需求',categories:['technology'],tagIds:[tagId],queryTerms:'ＳＹＮＣ\nsync\nother',reason:'明示映射'};
 const body=recommendationThemeBody(draft,[category,tag]);assert.equal(body.expectedVersion,0);assert.equal(body.themeId,undefined);assert.deepEqual(body.mapping.queryTerms,['sync','other']);
 assert.equal(recommendationThemeBody({...draft,tagIds:[id]},[category,tag]),null);assert.equal(recommendationThemeBody({...draft,queryTerms:'x'.repeat(81)},[category,tag]),null);assert.equal(recommendationThemeBody({...draft,queryTerms:Array.from({length:25},(_,i)=>'word'+i).join('\n')},[category,tag]),null);
 const update=recommendationThemeDraft(theme);update.reason='保留原有映射';assert.equal(recommendationThemeBody(update,[category,tag]).themeId,id);assert.equal(recommendationThemeDraft(tag).id,null);
 assert.equal(recommendationThemeBody(draft,[category,{...tag,enabled:false}]),null);
});

test('history projects only real closed field changes and approved operation reasons, without unknown metadata or inferred actor kind',()=>{
 const event={id,sequence:'10',kind:'theme-updated',operatorId:'real-reader-id',version:2,themeKey:theme.key,changes:{label:{before:'原名',after:'新名'},enabled:{before:false,after:true},mapping:{before:null,after:{categories:['technology'],tagIds:[tagId],queryTerms:['sync'],secret:'NEVER_SHOW'}},password:{before:'NEVER_SHOW',after:'NEVER_SHOW'}},reason:'实际操作说明\n第二行',createdAt:'2026-10-23T01:00:00Z'};
 const result=recommendationHistory({...lease,items:[event,{...event,kind:'arbitrary-private-kind'}],nextAfter:'9'});assert.equal(result.items.length,1);assert.ok(!JSON.stringify(result).includes('NEVER_SHOW'));assert.equal(result.items[0].reason,event.reason);
 const lines=recommendationHistoryDetails(result.items[0],[category,tag]);assert.ok(lines.includes('主题名称：原原名；现新名'));assert.ok(lines.some(line=>line.includes('技术与工具')&&line.includes('工具')&&line.includes('sync')));assert.ok(lines.every(line=>!line.includes('→')));
 const unknown=recommendationHistory({...lease,items:[{...event,changes:{direction:{before:null,after:{key:theme.key,value:'invented'}}}}],nextAfter:null});assert.deepEqual(unknown.items[0].changes,{});assert.equal(recommendationHistory({...lease,items:[],nextAfter:'9223372036854775808'}),null);
});
