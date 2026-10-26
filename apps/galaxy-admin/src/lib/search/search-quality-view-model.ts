import type {SearchQualityConfiguration,SearchQualityDraft,SearchQualityHistory,SearchQualityHistoryEvent,SearchQualityIssue,SearchQualityLease,SearchQualityLocation,SearchQualityMetrics,SearchQualityOperation,SearchQualityOperationResult,SearchQualityOverview,SearchQualitySettings,SearchQualityTab,SearchQualityVersion} from "../../components/search/search-quality-types";

export const searchQualityTabs=[{id:'queries',label:'查询分析'},{id:'draft',label:'配置草稿'},{id:'history',label:'版本记录'}] as const;
export const searchQualitySearchKeys=['tab','days','query','issue','after','trail','word','version'] as const;
export const searchQualityIssues={all:'全部搜索词','no-results':'出现无结果','no-recorded-click':'未记录结果点击','scan-limited':'检索尚未完成',unmeasured:'缺少归属样本'} as const;
export const searchQualityRanking={relevance:'相关性优先',newest:'发布时间优先'} as const;
export const searchQualityKinds={draft:'保存草稿',apply:'应用配置',restore:'恢复配置'} as const;
export const searchQualityFixed={currentSource:true,anonymousPublic:true,withdrawnExcluded:true,expiredExcluded:true} as const;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sequence=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const cursor=(value:string)=>/^[A-Za-z0-9_-]{1,1024}$/.test(value);
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim():'';
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:'';
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const integer=(value:unknown)=>Number.isInteger(value)&&Number(value)>=0&&Number(value)<=2147483646;
const phase=(value:unknown)=>['prepared','submitting','task-pending','applied','failed','result-unknown'].includes(String(value));
const kind=(value:unknown)=>['draft','apply','restore'].includes(String(value));
export function searchQualityLocation(input:Record<string,string>):SearchQualityLocation{
 const tab=searchQualityTabs.some(item=>item.id===input.tab)?input.tab as SearchQualityTab:'queries',valid=tab==='history'?sequence:cursor;
 const after=valid(input.after??'')?input.after:'',trail=(input.trail??'').split(',').slice(0,30).filter(value=>value==='first'||valid(value));
 return {tab,days:['7','30','90'].includes(input.days)?Number(input.days):7,query:text(input.query,160),issue:Object.hasOwn(searchQualityIssues,input.issue)?input.issue as SearchQualityIssue:'all',after,trail:after?trail:[],word:text(input.word,160),version:uuid.test(input.version??'')?input.version.toLowerCase():''};
}
export function searchQualityHref(location:SearchQualityLocation,patch:Partial<SearchQualityLocation>={}){
 const value={...location,...patch},next=searchQualityLocation({...value,days:String(value.days),trail:value.trail.join(',')}),params=new URLSearchParams();
 if(next.tab!=='queries')params.set('tab',next.tab);if(next.days!==7)params.set('days',String(next.days));if(next.query)params.set('query',next.query);if(next.issue!=='all')params.set('issue',next.issue);if(next.word)params.set('word',next.word);if(next.version)params.set('version',next.version);
 if(next.after){params.set('after',next.after);if(next.trail.length)params.set('trail',next.trail.join(','));}return '/admin/operations/search-quality'+(params.size?'?'+params:'');
}
export function searchQualityOverviewPath(location:SearchQualityLocation){return '/v1/operations/search-quality/overview?'+new URLSearchParams({days:String(location.days),...(location.query?{query:location.query}:{}),issue:location.issue,limit:'20',...(location.tab==='queries'&&location.after?{after:location.after}:{})});}
export function searchQualityHistoryPath(after=''){return '/v1/operations/search-quality/history?'+new URLSearchParams({limit:'20',...(sequence(after)?{after}:{})});}
export function searchQualityOperationPath(id:string){return uuid.test(id)?'/v1/operations/search-quality/operations/'+id.toLowerCase():null;}
export function searchQualityNext(location:SearchQualityLocation,next:string){return (location.tab==='history'?sequence(next):cursor(next))?{after:next,trail:[...location.trail,location.after||'first'].slice(-30)}:null;}
export function searchQualityPrevious(location:SearchQualityLocation){const previous=location.trail.at(-1);return previous?{after:previous==='first'?'':previous,trail:location.trail.slice(0,-1)}:null;}
export function searchQualityNumber(value:unknown){return number(value)!==null?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(Number(value)):'—';}
export function searchQualityPercent(value:unknown){return number(value)!==null&&Number(value)<=1?new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(Number(value)):'—';}
export function searchQualityTime(value:unknown){return date(value)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(String(value))):'未记录';}
function lease(value:Record<string,unknown>):SearchQualityLease|null{const checkedAt=number(value.checkedAt),readExpiresAt=number(value.readExpiresAt);return value.metadataOnly===true&&checkedAt!==null&&readExpiresAt!==null&&readExpiresAt>=checkedAt&&readExpiresAt-checkedAt<=31?{checkedAt,readExpiresAt,metadataOnly:true}:null;}
function synonyms(value:unknown):SearchQualitySettings['synonyms']|null{
 if(!Array.isArray(value)||value.length>100)return null;const rows=value.map(record);if(rows.some(row=>!row||!text(row.term,80)||!Array.isArray(row.alternatives)||row.alternatives.length<1||row.alternatives.length>20||row.alternatives.some(item=>!text(item,80))))return null;
 return rows.map(row=>({term:text(row!.term,80),alternatives:(row!.alternatives as string[]).map(item=>text(item,80))}));
}
export function searchQualitySettings(value:unknown):SearchQualitySettings|null{const row=record(value),fixed=record(row?.fixedConstraints),words=synonyms(row?.synonyms);if(!row||!words||!Object.hasOwn(searchQualityRanking,String(row.rankingMode))||!fixed||Object.keys(searchQualityFixed).some(key=>fixed[key]!==true))return null;return {synonyms:words,rankingMode:row.rankingMode as SearchQualitySettings['rankingMode'],fixedConstraints:{...searchQualityFixed}};}
export function searchQualityVersion(value:unknown):SearchQualityVersion|null{
 const row=record(value),settings=searchQualitySettings(row?.settings);if(!row||typeof row.id!=='string'||!uuid.test(row.id)||!integer(row.version)||!['baseline','draft','restore'].includes(String(row.kind))||!date(row.createdAt)||!text(row.operatorId,256)||row.settings!==null&&!settings||row.restoredFrom!==null&&(typeof row.restoredFrom!=='string'||!uuid.test(row.restoredFrom))||typeof row.restorable!=='boolean')return null;
 return {id:row.id.toLowerCase(),version:Number(row.version),settings,kind:row.kind as SearchQualityVersion['kind'],createdAt:String(row.createdAt),operatorId:text(row.operatorId,256),restoredFrom:row.restoredFrom as string|null,restorable:row.restorable};
}
export function searchQualityOperation(value:unknown):SearchQualityOperation|null{
 const row=record(value);if(!row||typeof row.operationId!=='string'||!uuid.test(row.operationId)||typeof row.versionId!=='string'||!uuid.test(row.versionId)||!kind(row.kind)||!phase(row.phase)||!date(row.recordedAt)||!date(row.updatedAt)||typeof row.replayed!=='boolean')return null;
 return {operationId:row.operationId.toLowerCase(),kind:row.kind as SearchQualityOperation['kind'],versionId:row.versionId.toLowerCase(),phase:row.phase as SearchQualityOperation['phase'],errorCode:typeof row.errorCode==='string'&&/^[a-z][a-z0-9_-]{0,100}$/.test(row.errorCode)?row.errorCode:null,recordedAt:String(row.recordedAt),updatedAt:String(row.updatedAt),replayed:row.replayed};
}
export function searchQualityOperationResult(value:unknown):SearchQualityOperationResult|null{const root=record(value),meta=root&&lease(root),operation=searchQualityOperation(value);return meta&&operation?{...meta,...operation}:null;}
export function searchQualityPhase(value:Pick<SearchQualityOperation,'kind'|'phase'>){if(value.phase==='applied')return value.kind==='draft'?'草稿已保存':'已生效';return {prepared:'已受理，准备应用',submitting:'正在提交配置','task-pending':'等待生效',failed:'未生效','result-unknown':'生效结果待确认'}[value.phase];}
export function searchQualityPending(value:Pick<SearchQualityOperation,'phase'>){return !['applied','failed'].includes(value.phase);}
function configuration(value:unknown):SearchQualityConfiguration|null{
 const row=record(value),native=record(row?.native);if(!row||!integer(row.revision)||!native||!['available','drifted','not-connected','unavailable'].includes(String(native.state)))return null;
 const active=searchQualityVersion(row.active),draft=searchQualityVersion(row.draft),pending=searchQualityOperation(row.pending),settings=searchQualitySettings(native.settings);
 if(row.active!==null&&!active||row.draft!==null&&!draft||row.pending!==null&&!pending||native.settings!==null&&!settings)return null;
 return {revision:Number(row.revision),active,draft,native:{state:native.state as SearchQualityConfiguration['native']['state'],settings},pending};
}
function metrics(value:unknown):SearchQualityMetrics|null{const row=record(value);if(!row)return null;return {searches:number(row.searches),measuredSearches:number(row.measuredSearches),resultKnownSearches:number(row.resultKnownSearches),noResults:number(row.noResults),noResultRate:number(row.noResultRate)!==null&&Number(row.noResultRate)<=1?Number(row.noResultRate):null,clicks:number(row.clicks),clickedSearches:number(row.clickedSearches),clickRate:number(row.clickRate)!==null&&Number(row.clickRate)<=1?Number(row.clickRate):null,followUps:number(row.followUps),scanLimited:number(row.scanLimited)};}
export function searchQualityOverview(value:unknown):SearchQualityOverview|null{
 const root=record(value),meta=root&&lease(root),period=record(root?.period),trend=record(root?.trend),queries=record(root?.queries),caps=record(root?.capabilities),basis=record(root?.basis),config=configuration(root?.configuration),totals=metrics(root?.metrics);
 if(!root||!meta||!period||!date(period.from)||!date(period.to)||![7,30,90].includes(Number(period.days))||!totals||!trend||!Array.isArray(trend.items)||!['available','unavailable','not-collected','not-connected'].includes(String(trend.availability))||!queries||!Array.isArray(queries.items)||queries.nextAfter!==null&&(typeof queries.nextAfter!=='string'||!cursor(queries.nextAfter))||!config||!caps||['canConfigure','canPublish','canRestore'].some(key=>typeof caps[key]!=='boolean')||!basis||basis.source!=='meilisearch-community'||basis.metricsSource!=='openpanel-native-and-galaxy-request-bound-events'||basis.qualityCollection!=='request-bound-only'||basis.historicalBackfill!==false||basis.model!=='not-configured')return null;
 const items=queries.items.flatMap(value=>{const row=record(value),measure=metrics(value);if(!row||!measure||!text(row.key,160)||!text(row.label,160)||!Array.isArray(row.issueCodes))return [];return [{...measure,key:text(row.key,160),label:text(row.label,160),issueCodes:row.issueCodes.filter((key):key is Exclude<SearchQualityIssue,'all'>=>typeof key==='string'&&key!=='all'&&Object.hasOwn(searchQualityIssues,key))}];});
 const points=trend.items.flatMap(value=>{const row=record(value);return row&&typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&date(row.date)?[{date:row.date,searches:number(row.searches),noResults:number(row.noResults),clicks:number(row.clicks)}]:[];});
 return {...meta,period:{from:String(period.from),to:String(period.to),days:Number(period.days)},metrics:totals,trend:{items:points,availability:trend.availability as SearchQualityOverview['trend']['availability']},queries:{items,nextAfter:queries.nextAfter as string|null},configuration:config,capabilities:{canConfigure:Boolean(caps.canConfigure),canPublish:Boolean(caps.canPublish),canRestore:Boolean(caps.canRestore)},basis:{source:'meilisearch-community',metricsSource:'openpanel-native-and-galaxy-request-bound-events',qualityCollection:'request-bound-only',historicalBackfill:false,model:'not-configured'}};
}
export function searchQualityHistory(value:unknown):SearchQualityHistory|null{
 const root=record(value),meta=root&&lease(root);if(!root||!meta||!Array.isArray(root.items)||!Array.isArray(root.versions)||root.nextAfter!==null&&(typeof root.nextAfter!=='string'||!sequence(root.nextAfter)))return null;
 const versions=root.versions.map(searchQualityVersion);if(versions.some(value=>!value))return null;
 const items=root.items.flatMap(value=>{const row=record(value);if(!row||!uuid.test(String(row.id))||!sequence(String(row.sequence))||!kind(row.kind)||!phase(row.phase)||!text(row.operatorId,256)||!uuid.test(String(row.versionId))||!integer(row.version)||!date(row.createdAt))return [];
  const changes=record(row.changes)??{},projected:SearchQualityHistoryEvent['changes']={},wordChange=record(changes.synonyms),rankChange=record(changes.rankingMode);
  if(wordChange&&(wordChange.before===null||synonyms(wordChange.before))&&(wordChange.after===null||synonyms(wordChange.after)))projected.synonyms={before:synonyms(wordChange.before),after:synonyms(wordChange.after)};
  if(rankChange&&(rankChange.before===null||Object.hasOwn(searchQualityRanking,String(rankChange.before)))&&(rankChange.after===null||Object.hasOwn(searchQualityRanking,String(rankChange.after))))projected.rankingMode={before:rankChange.before as SearchQualitySettings['rankingMode']|null,after:rankChange.after as SearchQualitySettings['rankingMode']|null};
  return [{id:String(row.id),sequence:String(row.sequence),kind:row.kind as SearchQualityOperation['kind'],operatorId:text(row.operatorId,256),operatorDisplayName:text(row.operatorDisplayName,200)||null,versionId:String(row.versionId),version:Number(row.version),phase:row.phase as SearchQualityOperation['phase'],changes:projected,reason:typeof row.reason==='string'&&row.reason.length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.reason)?row.reason.trim():'',createdAt:String(row.createdAt)}];});
 return {...meta,items,versions:versions as SearchQualityVersion[],nextAfter:root.nextAfter as string|null};
}
export function searchQualityDraft(config:SearchQualityConfiguration):SearchQualityDraft{const settings=config.draft?.settings??config.active?.settings??config.native.settings;return {baseRevision:config.revision,base:settings?structuredClone(settings):null,rows:settings?.synonyms.map(row=>({term:row.term,alternatives:row.alternatives.join('、')}))??[],rankingMode:settings?.rankingMode??'',reason:''};}
const normalize=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ');
export function searchQualityDraftBody(draft:SearchQualityDraft){
 const rows=draft.rows.filter(row=>row.term.trim()||row.alternatives.trim()).map(row=>({term:normalize(row.term),alternatives:[...new Set(row.alternatives.split(/[\n,，、;；]+/).map(normalize).filter(Boolean))]}));
 if(!integer(draft.baseRevision)||!draft.reason.trim()||draft.reason.length>500||!Object.hasOwn(searchQualityRanking,draft.rankingMode)||rows.length>100||new Set(rows.map(row=>row.term)).size!==rows.length||rows.some(row=>!row.term||row.term.length>80||['__proto__','constructor','prototype'].includes(row.term)||row.alternatives.length<1||row.alternatives.length>20||row.alternatives.some(word=>word.length>80||['__proto__','constructor','prototype'].includes(word))))return null;
 return {expectedRevision:draft.baseRevision,settings:{synonyms:rows,rankingMode:draft.rankingMode as SearchQualitySettings['rankingMode'],fixedConstraints:{...searchQualityFixed}},reason:draft.reason.trim()};
}
export function searchQualityDifferences(draft:SearchQualityDraft,current:SearchQualityConfiguration){const latest=current.draft?.settings??current.active?.settings??current.native.settings;return {changed:current.revision!==draft.baseRevision,current:latest,base:draft.base};}

export function searchQualityMerge(draft:SearchQualityDraft,current:SearchQualityConfiguration,choices:Partial<Record<'synonyms'|'rankingMode','mine'|'current'>>={}){
 const latest=current.draft?.settings??current.active?.settings??current.native.settings;
 if(!draft.base||!latest)return null;
 const rows=(settings:SearchQualitySettings)=>settings.synonyms.map(row=>({term:row.term,alternatives:row.alternatives.join('、')}));
 const canonical=(value:{term:string;alternatives:string}[])=>value.map(row=>({term:normalize(row.term),alternatives:[...new Set(row.alternatives.split(/[\n,，、;；]+/).map(normalize).filter(Boolean))].sort()})).sort((a,b)=>a.term.localeCompare(b.term));
 const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),conflicts:{key:'synonyms'|'rankingMode';label:string;mine:string;current:string}[]=[];
 const pick=<T,>(key:'synonyms'|'rankingMode',label:string,before:T,mine:T,saved:T,compare:(a:T,b:T)=>boolean,display:(value:T)=>string):T=>{
  if(compare(mine,before))return saved;if(compare(saved,before)||compare(mine,saved))return mine;
  conflicts.push({key,label,mine:display(mine),current:display(saved)});return choices[key]==='current'?saved:mine;
 };
 const words=pick('synonyms','同义词',rows(draft.base),draft.rows,rows(latest),(a,b)=>equal(canonical(a),canonical(b)),value=>value.map(row=>row.term+'：'+row.alternatives).join('；')||'无');
 const rankingMode=pick('rankingMode','结果排序',draft.base.rankingMode as SearchQualityDraft['rankingMode'],draft.rankingMode,latest.rankingMode,equal,value=>value?searchQualityRanking[value]:'未选择');
 return {draft:{...draft,baseRevision:current.revision,base:structuredClone(latest),rows:structuredClone(words),rankingMode},conflicts,unresolved:conflicts.filter(item=>!choices[item.key]).length};
}
