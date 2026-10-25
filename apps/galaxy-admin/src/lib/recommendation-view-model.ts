import type {RecommendationDirection,RecommendationHistory,RecommendationHistoryEvent,RecommendationLocation,RecommendationOverview,RecommendationPolicy,RecommendationPolicyDraft,RecommendationSubject,RecommendationTab,RecommendationTheme,RecommendationThemeDraft} from '../components/recommendation-types';

export const recommendationTabs=[{id:'overview',label:'整体表现'},{id:'topics',label:'主题供需'},{id:'strategy',label:'调控策略'},{id:'history',label:'变化记录'}] as const;
export const recommendationSearchKeys=['tab','days','id','query','after','trail'] as const;
export const recommendationDirectionLabels={increase:'增加机会',keep:'保持',decrease:'减少机会'} as const;
const tabs=new Set<string>(recommendationTabs.map(item=>item.id));
const directions=new Set<string>(Object.keys(recommendationDirectionLabels));
const cursor={test:(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n};
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function safeText(value:unknown,max:number){return typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)?value.trim():'';}
export function recommendationLocation(input:Record<string,string>):RecommendationLocation{
 const after=cursor.test(input.after??'')?input.after:'',trail=(input.trail??'').split(',').slice(0,30).filter(item=>item==='first'||cursor.test(item));
 return {tab:tabs.has(input.tab)?input.tab as RecommendationTab:'overview',days:['7','30','90'].includes(input.days)?Number(input.days):7,id:safeText(input.id,256),query:safeText(input.query,160),after,trail:after?trail:[]};
}
export function recommendationHref(location:RecommendationLocation,patch:Partial<RecommendationLocation>={}){
 const candidate={...location,...patch},next=recommendationLocation({tab:candidate.tab,days:String(candidate.days),id:candidate.id,query:candidate.query,after:candidate.after,trail:candidate.trail.join(',')}),query=new URLSearchParams();
 if(next.tab!=='overview')query.set('tab',next.tab);if(next.days!==7)query.set('days',String(next.days));if(next.id)query.set('id',next.id);if(next.query)query.set('query',next.query);
 if(next.after){query.set('after',next.after);if(next.trail.length)query.set('trail',next.trail.join(','));}return '/admin/operations/recommendation'+(query.size?'?'+query:'');
}
export function recommendationOverviewPath(location:RecommendationLocation){return '/v1/operations/recommendation/overview?'+new URLSearchParams({days:String(location.days),...(location.query?{query:location.query}:{})});}
export function recommendationHistoryPath(after=''){return '/v1/operations/recommendation/history?'+new URLSearchParams({limit:'20',...(cursor.test(after)?{after}:{})});}
export function recommendationNextPage(location:RecommendationLocation,next:string){return cursor.test(next)?{after:next,trail:[...location.trail,location.after||'first'].slice(-30)}:null;}
export function recommendationPreviousPage(location:RecommendationLocation){const previous=location.trail.at(-1);return previous?{after:previous==='first'?'':previous,trail:location.trail.slice(0,-1)}:null;}
export function recommendationNumber(value:unknown){return typeof value==='number'&&Number.isFinite(value)&&value>=0?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(value):'—';}
export function recommendationTime(value:unknown){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return '未记录';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));}
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const nonnegative=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function stringList(value:unknown,max=200){return Array.isArray(value)&&value.length<=max&&value.every(item=>typeof item==='string'&&item.length<=256&&!/[\u0000-\u001f\u007f]/.test(item))?[...new Set(value as string[])]:null;}
export function recommendationTheme(value:unknown):RecommendationTheme|null{
 const row=record(value),mapping=record(row?.mapping);if(!row||!mapping||!['category','tag','theme'].includes(String(row.kind))||!['forum-category','forum-tag','operator-mapping'].includes(String(row.source))||typeof row.key!=='string'||!safeText(row.label,80)||!Number.isInteger(row.version)||Number(row.version)<0||typeof row.enabled!=='boolean')return null;
 const categories=stringList(mapping.categories),tagIds=stringList(mapping.tagIds),queryTerms=stringList(mapping.queryTerms);if(!categories||!tagIds||!queryTerms||tagIds.some(id=>!uuid.test(id)))return null;
 const kind=row.kind as RecommendationTheme['kind'],id=typeof row.id==='string'&&uuid.test(row.id)?row.id.toLowerCase():null;
 if(kind==='category'?(id!==null||categories.length!==1||row.key!=='category:'+categories[0]):!id||row.key!==kind+':'+id)return null;
 if(kind==='category'&&row.source!=='forum-category'||kind==='tag'&&(row.source!=='forum-tag'||tagIds.length!==1||tagIds[0]!==id)||kind==='theme'&&row.source!=='operator-mapping')return null;
 return {key:row.key,id,label:safeText(row.label,80),kind,version:Number(row.version),enabled:row.enabled,mapping:{categories,tagIds,queryTerms},source:row.source as RecommendationTheme['source']};
}
export function recommendationPolicy(value:unknown):RecommendationPolicy|null{
 const row=record(value),controls=record(row?.controls),fixed=record(row?.fixedConstraints);if(!row||!controls||!fixed||!Number.isInteger(row.version)||Number(row.version)<0||typeof row.enabled!=='boolean'||typeof controls.avoidRepetition!=='boolean'||typeof controls.avoidConcentration!=='boolean'||fixed.personalNeeds!==true||fixed.supply!==true||fixed.negativeFeedback!==true||row.algorithm!=='galaxy-opportunity-v1'||!Array.isArray(row.directions))return null;
 const mapped=row.directions.map(record);if(mapped.some(item=>!item||typeof item.key!=='string'||!directions.has(String(item.direction))))return null;
 return {version:Number(row.version),enabled:row.enabled,directions:mapped.map(item=>({key:item!.key as string,direction:item!.direction as RecommendationDirection})),controls:{avoidRepetition:controls.avoidRepetition,avoidConcentration:controls.avoidConcentration},fixedConstraints:{personalNeeds:true,supply:true,negativeFeedback:true},updatedAt:typeof row.updatedAt==='string'&&Number.isFinite(Date.parse(row.updatedAt))?row.updatedAt:null,algorithm:'galaxy-opportunity-v1'};
}
export function recommendationOverview(value:unknown):RecommendationOverview|null{
 const root=record(value),period=record(root?.period),catalog=record(root?.catalog),topics=record(root?.topics),metrics=record(root?.metrics),trend=record(root?.trend),caps=record(root?.capabilities),basis=record(root?.basis),policy=recommendationPolicy(root?.policy);
 if(!root||root.metadataOnly!==true||nonnegative(root.checkedAt)===null||nonnegative(root.readExpiresAt)===null||!period||typeof period.from!=='string'||typeof period.to!=='string'||!Number.isFinite(Date.parse(period.from))||!Number.isFinite(Date.parse(period.to))||![7,30,90].includes(Number(period.days))||!catalog||!Array.isArray(catalog.items)||!topics||!Array.isArray(topics.items)||!metrics||!trend||!Array.isArray(trend.items)||!['available','not-collected','not-connected'].includes(String(trend.availability))||!caps||typeof caps.canConfigure!=='boolean'||typeof caps.canMapThemes!=='boolean'||!policy||!basis||basis.metricsSource!=='openpanel-native'||basis.topicSource!=='galaxy-qualified-usage-events'||basis.recommendationAttribution!=='request-bound-only'||basis.historicalBackfill!==false||basis.model!=='not-configured')return null;
 const themes=catalog.items.map(recommendationTheme),mappingCatalog=record(root.mappingCatalog),mappingItems=Array.isArray(mappingCatalog?.items)?mappingCatalog.items.map(recommendationTheme):[];if(themes.some(item=>!item)||mappingItems.some(item=>!item||item.kind==='theme'))return null;
 const topicRows=topics.items.flatMap(value=>{const row=record(value),availability=record(row?.availability);if(!row||typeof row.key!=='string'||!availability||!['available','partial'].includes(String(availability.supply))||!['available','partial','not-collected'].includes(String(availability.usage)))return [];return [{key:row.key,supply:nonnegative(row.supply),demand:nonnegative(row.demand),exposures:nonnegative(row.exposures),clicks:nonnegative(row.clicks),bookmarks:nonnegative(row.bookmarks),notInterested:nonnegative(row.notInterested),availability:{supply:availability.supply as 'available'|'partial',usage:availability.usage as 'available'|'partial'|'not-collected'}}];});
 const trendRows=trend.items.flatMap(value=>{const row=record(value);if(!row||typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!Number.isFinite(Date.parse(row.date)))return [];return [{date:row.date,exposures:nonnegative(row.exposures),clicks:nonnegative(row.clicks),bookmarks:nonnegative(row.bookmarks),notInterested:nonnegative(row.notInterested)}];});
 return {checkedAt:Number(root.checkedAt),readExpiresAt:Number(root.readExpiresAt),metadataOnly:true,period:{from:period.from,to:period.to,days:Number(period.days)},catalog:{items:themes as RecommendationTheme[]},mappingCatalog:{items:mappingItems as RecommendationTheme[]},topics:{items:topicRows},metrics:{exposures:nonnegative(metrics.exposures),clicks:nonnegative(metrics.clicks),bookmarks:nonnegative(metrics.bookmarks),notInterested:nonnegative(metrics.notInterested)},trend:{items:trendRows,availability:trend.availability as RecommendationOverview['trend']['availability']},policy,capabilities:{canConfigure:caps.canConfigure,canMapThemes:caps.canMapThemes},basis:{metricsSource:'openpanel-native',topicSource:'galaxy-qualified-usage-events',recommendationAttribution:'request-bound-only',historicalBackfill:false,model:'not-configured'}};
}
export function recommendationSubjects(value:RecommendationOverview):RecommendationSubject[]{
 const metrics=new Map(value.topics.items.map(item=>[item.key,item])),directions=new Map(value.policy.directions.map(item=>[item.key,item.direction]));
 return value.catalog.items.map(theme=>{const metric=metrics.get(theme.key);return {key:theme.key,label:theme.label,kind:theme.kind,terms:theme.mapping.queryTerms,supply:metric?.supply??null,supplyPartial:metric?.availability.supply==='partial',usagePartial:metric?.availability.usage==='partial',demand:metric?.demand??null,metrics:{exposures:metric?.exposures??null,clicks:metric?.clicks??null,bookmarks:metric?.bookmarks??null,negativeFeedback:metric?.notInterested??null},direction:directions.get(theme.key)??null};});
}
export function recommendationPolicyDraft(policy:RecommendationPolicy,key:string):RecommendationPolicyDraft{return {base:structuredClone(policy),themeKey:key,enabled:policy.enabled,direction:policy.directions.find(item=>item.key===key)?.direction??'keep',controls:{...policy.controls},reason:''};}
export type RecommendationThemePolicyDraft=Pick<RecommendationPolicyDraft,'base'|'themeKey'|'direction'|'reason'>;
export type RecommendationGlobalPolicyDraft=Pick<RecommendationPolicyDraft,'base'|'enabled'|'controls'>;
export function recommendationThemePolicyDraft(policy:RecommendationPolicy,key:string):RecommendationThemePolicyDraft{const {enabled:_,controls:__,...draft}=recommendationPolicyDraft(policy,key);return draft;}
export function recommendationGlobalPolicyDraft(policy:RecommendationPolicy):RecommendationGlobalPolicyDraft{return {base:structuredClone(policy),enabled:policy.enabled,controls:{...policy.controls}};}
export function recommendationGlobalChanged(draft:RecommendationGlobalPolicyDraft){return draft.enabled!==draft.base.enabled||draft.controls.avoidRepetition!==draft.base.controls.avoidRepetition||draft.controls.avoidConcentration!==draft.base.controls.avoidConcentration;}
export function recommendationComposePolicyDraft(policy:RecommendationPolicy,key:string,theme?:RecommendationThemePolicyDraft,global?:RecommendationGlobalPolicyDraft|null):RecommendationPolicyDraft{
 const local=theme??recommendationThemePolicyDraft(policy,key);
 return {...local,base:global?{...local.base,version:global.base.version,enabled:global.base.enabled,controls:{...global.base.controls}}:local.base,enabled:global?.enabled??policy.enabled,controls:{...(global?.controls??policy.controls)}};
}
export function recommendationAfterPolicySaved(drafts:Record<string,RecommendationThemePolicyDraft>,policy:RecommendationPolicy,savedKey:string){
 const next:Record<string,RecommendationThemePolicyDraft>={};
 for(const [key,draft] of Object.entries(drafts)){
  if(key===savedKey)continue;
  const before=draft.base.directions.find(item=>item.key===key)?.direction??'keep',current=policy.directions.find(item=>item.key===key)?.direction??'keep';
  // A save to another topic cannot resolve a genuine concurrent direction edit.
  next[key]=before===current||draft.direction===before||draft.direction===current?{...draft,base:structuredClone(policy)}:draft;
 }
 return next;
}
export function recommendationPolicyBody(draft:RecommendationPolicyDraft){if(!draft.themeKey||!directions.has(draft.direction)||!draft.reason.trim()||draft.reason.length>500)return null;return {expectedVersion:draft.base.version,enabled:draft.enabled,themeKey:draft.themeKey,direction:draft.direction,controls:{...draft.controls},reason:draft.reason.trim()};}
export function recommendationThemeDraft(theme?:RecommendationTheme|null):RecommendationThemeDraft{return {...(theme?.kind==='theme'?{base:{label:theme.label,enabled:theme.enabled,categories:[...theme.mapping.categories],tagIds:[...theme.mapping.tagIds],queryTerms:theme.mapping.queryTerms.join('\n')}}:{}),id:theme?.kind==='theme'?theme.id:null,baseVersion:theme?.kind==='theme'?theme.version:0,label:theme?.kind==='theme'?theme.label:'',enabled:theme?.kind==='theme'?theme.enabled:false,categories:theme?.kind==='theme'?[...theme.mapping.categories]:[],tagIds:theme?.kind==='theme'?[...theme.mapping.tagIds]:[],queryTerms:theme?.kind==='theme'?theme.mapping.queryTerms.join('\n'):'',reason:''};}
export function recommendationThemeBody(draft:RecommendationThemeDraft,catalog:readonly RecommendationTheme[]){
 const categories=new Set(catalog.filter(item=>item.kind==='category').flatMap(item=>item.mapping.categories)),tags=new Set(catalog.filter(item=>item.kind==='tag'&&item.enabled).flatMap(item=>item.mapping.tagIds)),terms=[...new Set(draft.queryTerms.split(/[\n,，]+/).map(item=>item.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ')).filter(Boolean))];
 if(!draft.label.trim()||draft.label.length>80||!draft.reason.trim()||draft.reason.length>500||draft.categories.length>6||draft.tagIds.length>32||terms.length>24||draft.categories.some(item=>!categories.has(item))||draft.tagIds.some(item=>!tags.has(item))||terms.some(item=>item.length>80)||(!draft.categories.length&&!draft.tagIds.length&&!terms.length)||draft.id!==null&&!uuid.test(draft.id))return null;
 return {...(draft.id?{themeId:draft.id}:{}),expectedVersion:draft.baseVersion,label:draft.label.trim(),enabled:draft.enabled,mapping:{categories:[...new Set(draft.categories)],tagIds:[...new Set(draft.tagIds)],queryTerms:terms},reason:draft.reason.trim()};
}
export function recommendationPolicyDifferences(draft:RecommendationPolicyDraft,current:RecommendationPolicy){
 const labels={enabled:'启用方向调控',avoidRepetition:'减少重复展示',avoidConcentration:'避免主题过度集中'},before={enabled:draft.base.enabled,...draft.base.controls},saved={enabled:current.enabled,...current.controls},input={enabled:draft.enabled,...draft.controls};
 const changes=(Object.keys(labels) as (keyof typeof labels)[]).filter(key=>before[key]!==saved[key]).map(key=>({label:labels[key],current:saved[key]?'启用':'停用',draft:input[key]?'启用':'停用'}));
 const original=draft.base.directions.find(item=>item.key===draft.themeKey)?.direction??'keep',latest=current.directions.find(item=>item.key===draft.themeKey)?.direction??'keep';
 if(original!==latest)changes.unshift({label:'此主题方向',current:recommendationDirectionLabels[latest],draft:recommendationDirectionLabels[draft.direction]});return changes;
}
export const recommendationHistoryNames={'policy-updated':'调整推荐方向','theme-created':'建立需求主题','theme-updated':'更新需求主题'} as const;
export function recommendationHistoryLines(event:RecommendationHistoryEvent){
 return recommendationHistoryDetails(event);
}

export function recommendationHistory(value:unknown):RecommendationHistory|null{
 const root=record(value);if(!root||root.metadataOnly!==true||nonnegative(root.checkedAt)===null||nonnegative(root.readExpiresAt)===null||!Array.isArray(root.items)||root.nextAfter!==null&&(typeof root.nextAfter!=='string'||!cursor.test(root.nextAfter)))return null;
 const items=root.items.flatMap(value=>{const row=record(value);if(!row||typeof row.id!=='string'||!uuid.test(row.id)||typeof row.sequence!=='string'||!cursor.test(row.sequence)||!Object.hasOwn(recommendationHistoryNames,String(row.kind))||typeof row.operatorId!=='string'||!safeText(row.operatorId,256)||!Number.isInteger(row.version)||Number(row.version)<0||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))return [];
  const changes=record(row.changes)??{},projected:Record<string,unknown>={};
  for(const key of ['enabled','avoidRepetition','avoidConcentration','direction','label','mapping']){const change=record(changes[key]);if(!change)continue;const allowed=(value:unknown):boolean=>value===null||(key==='enabled'||key==='avoidRepetition'||key==='avoidConcentration'?typeof value==='boolean':key==='label'?!!safeText(value,80):key==='direction'?!!record(value)&&typeof record(value)!.key==='string'&&directions.has(String(record(value)!.value)):!!record(value)&&!!stringList(record(value)!.categories,6)&&!!stringList(record(value)!.tagIds,32)&&!!stringList(record(value)!.queryTerms,24));
   const project=(value:unknown)=>{if(value===null||typeof value==='boolean'||typeof value==='string')return value;const item=record(value)!;return key==='direction'?{key:safeText(item.key,80),value:item.value}:{categories:stringList(item.categories,6)!,tagIds:stringList(item.tagIds,32)!,queryTerms:stringList(item.queryTerms,24)!};};
   if(allowed(change.before)&&allowed(change.after)&&change.after!==null)projected[key]={before:project(change.before),after:project(change.after)};}
  return [{id:row.id,sequence:row.sequence,kind:row.kind as RecommendationHistoryEvent['kind'],operatorId:row.operatorId,operatorDisplayName:safeText(row.operatorDisplayName,200)||null,version:Number(row.version),themeKey:typeof row.themeKey==='string'?safeText(row.themeKey,80)||null:null,changes:projected,reason:typeof row.reason==='string'&&row.reason.length<=500&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.reason)?row.reason.trim():'',createdAt:row.createdAt}];});
 return {checkedAt:Number(root.checkedAt),readExpiresAt:Number(root.readExpiresAt),metadataOnly:true,items,nextAfter:root.nextAfter as string|null};
}
export function recommendationHistoryDetails(event:RecommendationHistoryEvent,catalog:readonly RecommendationTheme[]=[]){
 const lines:string[]=[];
 for(const[key,label]of [['enabled','启用状态'],['avoidRepetition','减少重复展示'],['avoidConcentration','避免主题过度集中']] as const){const change=record(event.changes[key]);if(change&&typeof change.after==='boolean'&&(change.before===null||typeof change.before==='boolean'))lines.push(label+'：'+(change.before===null?'原未设置':'原'+(change.before?'启用':'停用'))+'；现'+(change.after?'启用':'停用'));}
 const direction=record(event.changes.direction),before=record(direction?.before),after=record(direction?.after);if(after&&directions.has(String(after.value)))lines.push('此主题方向：'+(before&&directions.has(String(before.value))?'原'+recommendationDirectionLabels[before.value as RecommendationDirection]:'原未设置')+'；现'+recommendationDirectionLabels[after.value as RecommendationDirection]);
 const label=record(event.changes.label);if(label&&typeof label.after==='string')lines.push('主题名称：'+(typeof label.before==='string'?'原'+label.before:'原未设置')+'；现'+label.after);
 const mapping=record(event.changes.mapping);if(mapping){const display=(value:unknown)=>{const row=record(value);if(!row)return '未设置';const categories=stringList(row.categories,6)??[],tags=stringList(row.tagIds,32)??[],terms=stringList(row.queryTerms,24)??[];return [...categories.map(key=>catalog.find(item=>item.kind==='category'&&item.mapping.categories.includes(key))?.label??'原分类'),...tags.map(id=>catalog.find(item=>item.kind==='tag'&&item.id===id)?.label??'原标签'),...terms].join('、')||'无';};lines.push('主题映射：原'+display(mapping.before)+'；现'+display(mapping.after));}
 return lines;
}

export type RecommendationMergeChoice=Record<string,'mine'|'current'>;
export type RecommendationMergeConflict={key:string;label:string;mine:string;current:string};
const recommendationSame=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function recommendationPick<T>(key:string,label:string,before:T,mine:T,current:T,choices:RecommendationMergeChoice,conflicts:RecommendationMergeConflict[],display:(value:T)=>string,equal:(a:T,b:T)=>boolean=recommendationSame):T{
 if(equal(mine,before))return current;if(equal(current,before)||equal(mine,current))return mine;
 conflicts.push({key,label,mine:display(mine),current:display(current)});return choices[key]==='current'?current:mine;
}
export function recommendationMergePolicy(policy:RecommendationPolicy,key:string,theme:RecommendationThemePolicyDraft|undefined,global:RecommendationGlobalPolicyDraft|null,choices:RecommendationMergeChoice={}){
 const conflicts:RecommendationMergeConflict[]=[],enabled=(value:boolean)=>value?'启用':'停用';
 const pick=<T,>(field:string,label:string,before:T,mine:T,current:T,display:(value:T)=>string)=>recommendationPick(field,label,before,mine,current,choices,conflicts,display);
 const nextGlobal=global?{base:structuredClone(policy),enabled:pick('enabled','启用方向调控',global.base.enabled,global.enabled,policy.enabled,enabled),controls:{avoidRepetition:pick('avoidRepetition','减少重复展示',global.base.controls.avoidRepetition,global.controls.avoidRepetition,policy.controls.avoidRepetition,enabled),avoidConcentration:pick('avoidConcentration','避免主题过度集中',global.base.controls.avoidConcentration,global.controls.avoidConcentration,policy.controls.avoidConcentration,enabled)}}:null;
 const direction=(value:RecommendationPolicy)=>value.directions.find(item=>item.key===key)?.direction??'keep';
 const nextTheme=theme?{...theme,base:structuredClone(policy),direction:pick('direction','此主题方向',direction(theme.base),theme.direction,direction(policy),value=>recommendationDirectionLabels[value])}:undefined;
 return {global:nextGlobal,theme:nextTheme,conflicts,unresolved:conflicts.filter(item=>!choices[item.key]).length};
}
export function recommendationMergeTheme(draft:RecommendationThemeDraft,current:RecommendationTheme,choices:RecommendationMergeChoice={},catalog:readonly RecommendationTheme[]=[]){
 if(!draft.base||current.kind!=='theme'||current.id!==draft.id)return null;
 const latest=recommendationThemeDraft(current),saved=latest.base!,conflicts:RecommendationMergeConflict[]=[];
 const pick=<T,>(key:string,label:string,before:T,mine:T,now:T,display:(value:T)=>string,equal?:(a:T,b:T)=>boolean)=>recommendationPick(key,label,before,mine,now,choices,conflicts,display,equal);
 const sameSet=(a:string[],b:string[])=>recommendationSame([...a].sort(),[...b].sort()),terms=(text:string)=>[...new Set(text.split(/[\n,，]+/).map(value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ')).filter(Boolean))].sort();
 const next={...draft,baseVersion:current.version,base:saved,
  label:pick('label','主题名称',draft.base.label,draft.label,saved.label,value=>value),enabled:pick('enabled','启用主题',draft.base.enabled,draft.enabled,saved.enabled,value=>value?'启用':'停用'),
  categories:pick('categories','关联分类',draft.base.categories,draft.categories,saved.categories,values=>values.map(key=>catalog.find(item=>item.kind==='category'&&item.mapping.categories.includes(key))?.label??'原分类').join('、')||'无',sameSet),
  tagIds:pick('tagIds','关联标签',draft.base.tagIds,draft.tagIds,saved.tagIds,values=>values.map(id=>catalog.find(item=>item.id===id)?.label??'原标签').join('、')||'无',sameSet),
  queryTerms:pick('queryTerms','同义查询词',draft.base.queryTerms,draft.queryTerms,saved.queryTerms,value=>value||'无',(a,b)=>recommendationSame(terms(a),terms(b)))};
 return {draft:next,conflicts,unresolved:conflicts.filter(item=>!choices[item.key]).length};
}
