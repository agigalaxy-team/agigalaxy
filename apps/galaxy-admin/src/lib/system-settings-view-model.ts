import {systemSettingsTabIds,type SystemSettingsLocation,type SystemSettingsTab,type SystemSettingsOperation,type SystemSettingsSection,type SystemSettingsCommandSection,type SystemSettingsOperationLocator} from '../components/system-settings-types';
import type {SystemSettingsLease,SystemSettingsMailConfiguration,SystemSettingsMailConnection,SystemSettingsMailDraft,SystemSettingsMailDraftConnection,SystemSettingsServiceConfiguration,SystemSettingsServiceConnection,SystemSettingsServiceDraft,SystemSettingsServiceDraftConnection,SystemSettingsServiceKind,SystemSettingsDraftMap,SystemSettingsMemorySnapshot,SystemSettingsGeneralConfiguration,AutonomyRuntimeFields} from '../components/system-settings-types';
import type {AutonomyRuntimeSettings} from '../components/autonomy-types';

export const systemSettingsRoute='/admin/operations/system-settings';
export const systemSettingsBase='/v1/operations/system-settings';
export const systemSettingsTabs=[
 {id:'general',label:'常规设置'},
 {id:'mail',label:'邮件服务'},
 {id:'service-connections',label:'服务接入'},
 {id:'advanced',label:'高级设置'},
] as const;

/** A historical result locator is metadata only and can derive a fixed GET. */
export function systemSettingsOperationLocator(value:unknown):SystemSettingsOperationLocator|null{
 const row=record(value);
 if(!row||Object.keys(row).some(key=>!['operationId','section','kind','versionId','revision'].includes(key))
  ||typeof row.operationId!=='string'||!uuid.test(row.operationId)||typeof row.versionId!=='string'||!uuid.test(row.versionId)
  ||!['general','mail','service-connections'].includes(String(row.section))||!['save','test','apply'].includes(String(row.kind))
  ||row.section==='general'&&row.kind==='test'||!Number.isSafeInteger(row.revision)||Number(row.revision)<0)return null;
 return {operationId:row.operationId,section:row.section as SystemSettingsOperationLocator['section'],kind:row.kind as SystemSettingsOperationLocator['kind'],versionId:row.versionId,revision:Number(row.revision)};
}
export function systemSettingsLocation(search:Record<string,unknown>):SystemSettingsLocation{
 const tab=typeof search.tab==='string'&&(systemSettingsTabIds as readonly string[]).includes(search.tab)?search.tab as SystemSettingsTab:'general';
 const rawRevision=search.operationRevision;
 const revision=typeof rawRevision==='string'&&/^(?:0|[1-9][0-9]{0,15})$/.test(rawRevision)?Number(rawRevision):null;
 const operation=systemSettingsOperationLocator({operationId:search.operation,section:tab,kind:search.operationKind,versionId:search.operationVersion,revision});
 return {tab,operation};
}
export function systemSettingsHref(location:SystemSettingsLocation,patch:Partial<SystemSettingsLocation>={}){
 const next={...location,...patch},params=new URLSearchParams({tab:next.tab});
 const operation=next.tab===location.tab?systemSettingsOperationLocator(next.operation):null;
 if(operation&&operation.section===next.tab){params.set('operation',operation.operationId);params.set('operationKind',operation.kind);params.set('operationVersion',operation.versionId);params.set('operationRevision',String(operation.revision));}
 return systemSettingsRoute+'?'+params;
}
export function systemSettingsOriginalHref(value:unknown){
 const operation=systemSettingsOperationLocator(value);
 return operation?systemSettingsHref({tab:operation.section,operation}):null;
}
export function systemSettingsOriginalReadPath(value:SystemSettingsOperationLocator){
 const operation=systemSettingsOperationLocator(value);
 return operation?(operation.section==='general'?'/api/system-settings/general/operations/':systemSettingsBase+'/operations/')+operation.operationId:null;
}
export function systemSettingsOriginalOperation(value:unknown,locator:SystemSettingsOperationLocator):SystemSettingsOperation|null{
 systemSettingsReadLease(value);
 const envelope=record(value);
 if(envelope?.state==='unknown'&&envelope.operation===null)return null;
 if(envelope?.state!=='recorded'&&envelope?.state!=='not-recorded')throw Error('Invalid original settings result');
 const operation=systemSettingsOperation(value,{operationId:locator.operationId,section:locator.section,kind:locator.kind,versionId:locator.versionId});
 if(operation&&operation.revision!==locator.revision)throw Error('Different original settings revision');
 return operation;
}
export function systemSettingsTime(value:string|number|null|undefined){
 if(value===null||value===undefined)return '未记录';
 const time=new Date(typeof value==='number'?value*1000:value);
 return Number.isFinite(time.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(time):'未记录';
}
export const systemSettingsPurposeLabels={operations:'运营邮件','account-authentication':'注册与密码重置','runtime-alerts':'运行告警'} as const;
export const systemSettingsStateLabels:Record<string,string>={
 accepted:'处理中',pending:'等待处理',running:'处理中',completed:'已完成',partial:'部分完成',failed:'处理失败',unknown:'结果暂未取得',
 available:'可用',unavailable:'暂不可用','not-configured':'尚未配置','not-connected':'尚未接通','not-applied':'尚未应用',applied:'已应用',
};
export function systemSettingsState(value:string|null|undefined){return value?systemSettingsStateLabels[value]??'状态暂未取得':'状态暂未取得';}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record=(value:unknown):Record<string,unknown>|null=>!!value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function systemSettingsReadLease(value:unknown):SystemSettingsLease{
 const row=record(value),now=Date.now()/1000;
 if(!row||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isSafeInteger(row.checkedAt)||row.checkedAt<0
  ||typeof row.readExpiresAt!=='number'||!Number.isSafeInteger(row.readExpiresAt)||row.readExpiresAt<=now||row.readExpiresAt<row.checkedAt||row.readExpiresAt-row.checkedAt>31)throw Error('Invalid settings read lease');
 return{checkedAt:row.checkedAt,readExpiresAt:row.readExpiresAt,metadataOnly:true};
}
/** Only the original identifier and the saved version can complete this step. */
export function systemSettingsOperation(value:unknown,expected:{operationId:string;section:SystemSettingsCommandSection;kind:SystemSettingsOperation['kind'];versionId?:string;expectedRevision?:number}):SystemSettingsOperation|null{
 const envelope=record(value),row=record(envelope?.operation);
 if(!envelope||envelope.metadataOnly!==true||typeof envelope.checkedAt!=='number'||!Number.isFinite(envelope.checkedAt)||typeof envelope.readExpiresAt!=='number'||!Number.isFinite(envelope.readExpiresAt)||envelope.readExpiresAt<envelope.checkedAt||envelope.readExpiresAt-envelope.checkedAt>31||envelope.readExpiresAt*1000<=Date.now())throw Error('Expired settings receipt');
 if(envelope?.state==='not-recorded'){
  if(envelope.operation!==null)throw Error('Invalid settings receipt');
  return null;
 }
 if(!row||row.operationId!==expected.operationId||row.section!==expected.section||row.kind!==expected.kind
  ||!['accepted','completed','partial','failed','unknown'].includes(String(row.state))||!Number.isSafeInteger(row.revision)||Number(row.revision)<0
  ||!(row.versionId===null||typeof row.versionId==='string'&&uuid.test(row.versionId))
  ||expected.versionId!==undefined&&row.versionId!==expected.versionId
  ||expected.expectedRevision!==undefined&&row.revision!==expected.expectedRevision+(expected.kind==='save'?1:0)||!Array.isArray(row.phases))throw Error('Different settings receipt');
 const phases=row.phases.map(value=>{
  const phase=record(value);if(!phase||typeof phase.target!=='string'||phase.target.length>100||!['pending','running','completed','failed','unknown'].includes(String(phase.state))
   ||!(phase.code===null||typeof phase.code==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(phase.code))
   ||!(phase.adoptedVersionId===null||typeof phase.adoptedVersionId==='string'&&uuid.test(phase.adoptedVersionId)))throw Error('Invalid settings phase');
  let checks;
  if(phase.checks!==undefined){
   if(!Array.isArray(phase.checks)||phase.checks.length>8)throw Error('Invalid settings checks');
   const kinds=new Set<string>();checks=phase.checks.map(value=>{const check=record(value);if(!check||typeof check.kind!=='string'||!['transport','authentication','index','reader-authentication','writer-authentication','scanner-signatures','runtime','execution-signature'].includes(check.kind)||kinds.has(check.kind)||!['passed','failed','not-tested'].includes(String(check.state)))throw Error('Invalid settings check');kinds.add(check.kind);return{kind:check.kind,state:check.state};});
  }
  return {target:phase.target,state:phase.state,code:phase.code,adoptedVersionId:phase.adoptedVersionId,...(checks?{checks}:{})};
 });
 if(row.credentialRef!==undefined&&!(typeof row.credentialRef==='string'&&/^system-key:[0-9a-f-]{36}$/.test(row.credentialRef)))throw Error('Invalid credential receipt');
 if(expected.kind==='credential'&&row.state==='completed'&&row.credentialRef!=='system-key:'+expected.operationId)throw Error('Different credential receipt');
 return {operationId:expected.operationId,section:expected.section,kind:expected.kind,state:row.state,versionId:row.versionId,revision:Number(row.revision),phases,...(row.credentialRef?{credentialRef:row.credentialRef}:{})} as SystemSettingsOperation;
}

export const systemSettingsServiceLabels:Record<SystemSettingsServiceKind,string>={analysis:'使用分析',recommendation:'推荐服务',search:'搜索服务','ai-execution':'AI执行服务','file-scanning':'文件扫描'};
export const systemSettingsServiceKinds=['analysis','recommendation','search','ai-execution','file-scanning'] as const;
export const systemSettingsMailNumbers=[
 ['connectionTimeoutMs','连接超时（毫秒）',100,120000],['greetingTimeoutMs','握手超时（毫秒）',100,120000],
 ['socketTimeoutMs','通信超时（毫秒）',100,300000],['maxConnections','并发连接',1,32],
 ['rateLimit','窗口提交上限',1,100000],['rateWindowSeconds','限速窗口（秒）',1,86400],
] as const;
const numericKeys=systemSettingsMailNumbers.map(row=>row[0]);
const stringNumber=(value:number|null|undefined)=>value===null||value===undefined?'':String(value);
export function systemSettingsMailDraft(configuration:SystemSettingsMailConfiguration):SystemSettingsMailDraft{
 return {connections:configuration.connections.map(row=>({id:row.id,name:row.name,credentialRef:row.credentialRef,host:row.host??'',port:stringNumber(row.port),tls:row.tls??'',dkimSelector:row.dkimSelector??'',
  connectionTimeoutMs:stringNumber(row.connectionTimeoutMs),greetingTimeoutMs:stringNumber(row.greetingTimeoutMs),socketTimeoutMs:stringNumber(row.socketTimeoutMs),maxConnections:stringNumber(row.maxConnections),rateLimit:stringNumber(row.rateLimit),rateWindowSeconds:stringNumber(row.rateWindowSeconds)})),bindings:{...configuration.bindings}};
}
export function systemSettingsNewMailConnection(id:string):SystemSettingsMailDraftConnection{
 return {id,name:'',host:'',port:'',tls:'',credentialRef:null,connectionTimeoutMs:'',greetingTimeoutMs:'',socketTimeoutMs:'',maxConnections:'',rateLimit:'',rateWindowSeconds:'',dkimSelector:''};
}
export function systemSettingsServiceDraft(configuration:SystemSettingsServiceConfiguration):SystemSettingsServiceDraft{
 return {connections:configuration.connections.map(row=>({...systemSettingsNewServiceConnection(row.kind,row.id),...row,port:row.kind==='file-scanning'?stringNumber(row.port):'',timeoutMs:row.kind==='file-scanning'?stringNumber(row.timeoutMs):''}))};
}
export function systemSettingsNewServiceConnection(kind:SystemSettingsServiceKind,id:string):SystemSettingsServiceDraftConnection{
 return {id,kind,url:'',projectId:'',clientId:'',readClientId:'',credentialRef:null,index:'',host:'',port:'',timeoutMs:''};
}
function integer(value:string,minimum:number,maximum:number,nullable:boolean){
 if(!value.trim())return nullable?null:undefined;
 if(!/^[0-9]+$/.test(value.trim()))return undefined;
 const next=Number(value);return Number.isSafeInteger(next)&&next>=minimum&&next<=maximum?next:undefined;
}
const host=(value:string)=>/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)&&!value.includes('..');
export function systemSettingsMailConfiguration(draft:SystemSettingsMailDraft):{value:SystemSettingsMailConfiguration|null;error:string}{
 const connections:SystemSettingsMailConnection[]=[];
 for(const row of draft.connections){
  const name=row.name.trim(),hostname=row.host.trim().toLowerCase(),port=integer(row.port,1,65535,true);
  if(!name||name.length>100||/[\p{Cc}]/u.test(name))return {value:null,error:'请填写连接名称。'};
  if(hostname&&!host(hostname))return {value:null,error:name+'的 SMTP 主机格式不正确。'};
  if(port===undefined)return {value:null,error:name+'的端口应为 1 至 65535。'};
  const values:Record<string,number|null>={};
  for(const[key,label,min,max]of systemSettingsMailNumbers){const value=integer(row[key],min,max,true);if(value===undefined)return {value:null,error:name+'的'+label+'应为 '+min+' 至 '+max+'。'};values[key]=value;}
  const selector=row.dkimSelector.trim();if(selector&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(selector))return {value:null,error:name+'的 DKIM 选择器格式不正确。'};
  connections.push({id:row.id,name,host:hostname||null,port,tls:row.tls||null,credentialRef:row.credentialRef,dkimSelector:selector||null,...values} as SystemSettingsMailConnection);
 }
 if(connections.length>16||new Set(connections.map(row=>row.id)).size!==connections.length)return {value:null,error:'连接数量或标识不正确。'};
 for(const id of Object.values(draft.bindings))if(id!==null&&!connections.some(row=>row.id===id))return {value:null,error:'请选择仍存在的发信连接。'};
 return {value:{connections,bindings:{...draft.bindings}},error:''};
}
function origin(value:string):string|null{
 try{const url=new URL(value);if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||url.protocol!=='https:'&&(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))return null;return url.origin;}catch{return null;}
}
export function systemSettingsServiceConfiguration(draft:SystemSettingsServiceDraft):{value:SystemSettingsServiceConfiguration|null;error:string}{
 const connections:SystemSettingsServiceConnection[]=[];
 for(const row of draft.connections){
  const label=systemSettingsServiceLabels[row.kind];if(!label)return {value:null,error:'服务类型不正确。'};
  if(row.kind==='file-scanning'){
   const port=integer(row.port,1,65535,false),timeoutMs=integer(row.timeoutMs,1000,60000,false);
   if(!['127.0.0.1','::1','localhost'].includes(row.host)||port===undefined||port===null||timeoutMs===undefined||timeoutMs===null)return {value:null,error:'请填写扫描服务的本机地址、端口和超时。'};
   connections.push({id:row.id,kind:row.kind,host:row.host as '127.0.0.1'|'::1'|'localhost',port,timeoutMs});continue;
  }
  const url=origin(row.url.trim());if(!url)return {value:null,error:label+'请填写 HTTPS 地址，或本机 HTTP 地址；地址中不包含路径或凭据。'};
  const base={id:row.id,kind:row.kind,url,credentialRef:row.credentialRef};
  if(row.kind==='analysis'){
   if(![row.projectId,row.clientId,row.readClientId].every(value=>uuid.test(value.trim())))return {value:null,error:'请填写分析服务的项目、采集客户端与读取客户端标识。'};
   connections.push({...base,kind:'analysis',projectId:row.projectId.trim().toLowerCase(),clientId:row.clientId.trim().toLowerCase(),readClientId:row.readClientId.trim().toLowerCase()});
  }else if(row.kind==='search'){
   if(!/^[A-Za-z0-9_-]{1,80}$/.test(row.index.trim()))return {value:null,error:'请填写搜索索引名称，仅使用字母、数字、下划线或连字符。'};
   connections.push({...base,kind:'search',index:row.index.trim()});
  }else connections.push({...base,kind:row.kind});
 }
 if(connections.length>5||new Set(connections.map(row=>row.kind)).size!==connections.length||new Set(connections.map(row=>row.id)).size!==connections.length)return {value:null,error:'每种服务保留一个连接。'};
 return {value:{connections},error:''};
}

export type SystemSettingsMergeChoice=Record<string,'mine'|'current'>;
export type SystemSettingsMergeConflict={key:string;label:string;mine:string;current:string};
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const short=(value:unknown)=>value===null||value===''?'未设置':typeof value==='boolean'?value?'是':'否':String(value);
/** Connections keep target and credential binding together during conflicts. */
export function systemSettingsMerge<K extends keyof SystemSettingsDraftMap>(section:K,base:SystemSettingsDraftMap[K],mine:SystemSettingsDraftMap[K],current:SystemSettingsDraftMap[K],choices:SystemSettingsMergeChoice){
 const conflicts:SystemSettingsMergeConflict[]=[],draft=structuredClone(current);
 const select=<T>(key:string,label:string,old:T,local:T,remote:T,display:(value:T)=>string=short):T=>{
  if(equal(local,old))return remote;if(equal(remote,old)||equal(local,remote))return local;
  conflicts.push({key,label,mine:display(local),current:display(remote)});return choices[key]==='mine'?local:remote;
 };
 if(section==='mail'){
  const old=base as SystemSettingsMailDraft,local=mine as SystemSettingsMailDraft,remote=current as SystemSettingsMailDraft,result=draft as SystemSettingsMailDraft;
  result.connections=[];
  for(const id of new Set([...old.connections,...local.connections,...remote.connections].map(row=>row.id))){
   const b=old.connections.find(row=>row.id===id),m=local.connections.find(row=>row.id===id),c=remote.connections.find(row=>row.id===id),name=m?.name||c?.name||b?.name||'发信连接';
   if(!b||!m||!c){const row=select('mail:'+id,name,b,m,c,value=>value?value.name||'未命名连接':'移除连接');if(row)result.connections.push(row);continue;}
   const row={...c};
   const tuple=(value:SystemSettingsMailDraftConnection)=>({host:value.host,port:value.port,tls:value.tls,credentialRef:value.credentialRef});
   Object.assign(row,select('mail:'+id+':connection',name+' · 连接与凭据',tuple(b),tuple(m),tuple(c),value=>(value.host||'未设置主机')+(value.port?':'+value.port:'')+' · '+(value.tls==='starttls'?'STARTTLS':value.tls==='implicit'?'隐式 TLS':'未设置安全连接')+' · '+(value.credentialRef?'已配置凭据':'未配置凭据')));
   for(const key of ['name','dkimSelector',...numericKeys] as const)row[key]=select('mail:'+id+':'+key,name+' · '+(key==='name'?'名称':key==='dkimSelector'?'DKIM 选择器':systemSettingsMailNumbers.find(value=>value[0]===key)?.[1]??key),b[key],m[key],c[key]);
   result.connections.push(row);
  }
  for(const purpose of Object.keys(systemSettingsPurposeLabels) as (keyof typeof systemSettingsPurposeLabels)[])result.bindings[purpose]=select('binding:'+purpose,systemSettingsPurposeLabels[purpose]+'使用的连接',old.bindings[purpose],local.bindings[purpose],remote.bindings[purpose],value=>[...local.connections,...remote.connections,...old.connections].find(row=>row.id===value)?.name||'未选择连接');
 }else{
  const old=base as SystemSettingsServiceDraft,local=mine as SystemSettingsServiceDraft,remote=current as SystemSettingsServiceDraft,result=draft as SystemSettingsServiceDraft;result.connections=[];
  for(const kind of systemSettingsServiceKinds){const b=old.connections.find(row=>row.kind===kind),m=local.connections.find(row=>row.kind===kind),c=remote.connections.find(row=>row.kind===kind);const row=select('service:'+kind,systemSettingsServiceLabels[kind],b,m,c,value=>value?(value.kind==='file-scanning'?value.host+':'+value.port:value.url||'未设置地址')+(value.kind!=='file-scanning'?' · '+(value.credentialRef?'已配置凭据':'未配置凭据'):''):'尚未配置');if(row)result.connections.push(row);}
 }
 return {draft,conflicts,unresolved:conflicts.filter(row=>!choices[row.key]).length};
}

export const autonomyRuntimeFields=[
 ['concurrency','同时处理任务数',1,2,'同时执行的任务上限。'],
 ['healthSeconds','健康检查间隔（秒）',10,300,'检查值守与任务的运行状态。'],
 ['startGraceSeconds','启动容差（秒）',30,1800,'超过计划时刻与此容差后，记为迟到。'],
 ['roundSeconds','单轮处理时限（秒）',60,3600,'每轮任务允许的最长处理时间。'],
 ['eventCoalesceSeconds','事件合并窗口（秒）',1,300,'窗口内的关联事件合并处理。'],
] as const;
export function autonomyRuntimeDraft(value:AutonomyRuntimeSettings):AutonomyRuntimeFields{
 return Object.fromEntries(autonomyRuntimeFields.map(([key])=>[key,String(value[key])])) as AutonomyRuntimeFields;
}
export function autonomyRuntimeConfiguration(draft:AutonomyRuntimeFields,concurrencyMaximum:number){
 const value={} as Omit<AutonomyRuntimeSettings,'revision'>;
 for(const[key,label,min,maximum]of autonomyRuntimeFields){
  const max=key==='concurrency'?Math.min(maximum,concurrencyMaximum):maximum,text=draft[key].trim(),number=Number(text);
  if(!/^\d+$/.test(text)||!Number.isSafeInteger(number)||number<min||number>max)return{value:null,error:label+'须为 '+min+' 至 '+max+' 的整数。'};
  value[key]=number;
 }return{value,error:''};
}
export function autonomyRuntimeMerge(base:AutonomyRuntimeFields,mine:AutonomyRuntimeFields,current:AutonomyRuntimeFields,choices:Partial<Record<keyof AutonomyRuntimeFields,'mine'|'current'>>={}){
 const draft={...current},conflicts:{key:keyof AutonomyRuntimeFields;label:string;mine:string;current:string}[]=[];
 for(const[key,label]of autonomyRuntimeFields){if(mine[key]===base[key])continue;if(current[key]===base[key]||mine[key]===current[key]){draft[key]=mine[key];continue;}conflicts.push({key,label,mine:mine[key],current:current[key]});if(choices[key]==='mine')draft[key]=mine[key];}
 return{draft,conflicts,unresolved:conflicts.filter(row=>!choices[row.key]).length};
}

/** The system page keeps authored public fields, never provision input. */
export function systemSettingsMemorySnapshot(input:unknown):SystemSettingsMemorySnapshot{
 const excluded=(value:unknown)=>{if(!value||typeof value!=='object')return;for(const[key,child]of Object.entries(value)){
  if(key!=='credentialRef'&&/password|secret|credential|apiKey|signingKey|serviceKey|^(?:body|requestBody|rawBody|token|user)$/i.test(key))throw Error('Excluded system settings snapshot field');excluded(child);
 }};excluded(input);
 const object=(value:unknown)=>record(value)??{},text=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'',ref=(value:unknown)=>typeof value==='string'&&/^system-key:[0-9a-f-]{36}$/.test(value)?value:null;
 const mail=(input:unknown):SystemSettingsMailDraft=>{
  const value=object(input),connections:SystemSettingsMailDraftConnection[]=[];
  for(const raw of Array.isArray(value.connections)?value.connections.slice(0,16):[]){const row=object(raw);if(typeof row.id!=='string'||!uuid.test(row.id)||connections.some(value=>value.id===row.id))continue;
   const item=systemSettingsNewMailConnection(row.id);item.name=text(row.name,100);item.host=text(row.host,253);item.port=text(row.port,5);item.tls=row.tls==='implicit'||row.tls==='starttls'?row.tls:'';item.credentialRef=ref(row.credentialRef);item.dkimSelector=text(row.dkimSelector,63);for(const key of numericKeys)item[key]=text(row[key],12);connections.push(item);
  }
  const bindings=object(value.bindings);return{connections,bindings:Object.fromEntries(Object.keys(systemSettingsPurposeLabels).map(key=>[key,typeof bindings[key]==='string'&&uuid.test(bindings[key] as string)?bindings[key]:null])) as SystemSettingsMailDraft['bindings']};
 };
 const services=(input:unknown):SystemSettingsServiceDraft=>{
  const value=object(input),connections:SystemSettingsServiceDraftConnection[]=[];
  for(const raw of Array.isArray(value.connections)?value.connections.slice(0,5):[]){const row=object(raw);if(typeof row.id!=='string'||!uuid.test(row.id)||!(systemSettingsServiceKinds as readonly unknown[]).includes(row.kind)||connections.some(value=>value.id===row.id||value.kind===row.kind))continue;
   connections.push({...systemSettingsNewServiceConnection(row.kind as SystemSettingsServiceKind,row.id),url:text(row.url,2048),projectId:text(row.projectId,36),clientId:text(row.clientId,36),readClientId:text(row.readClientId,36),credentialRef:ref(row.credentialRef),index:text(row.index,80),host:text(row.host,100),port:text(row.port,5),timeoutMs:text(row.timeoutMs,12)});
  }return{connections};
 };
 const value=object(input),entryRows=object(value.entries),entries:SystemSettingsMemorySnapshot['entries']={mail:null,'service-connections':null},choices:SystemSettingsMemorySnapshot['choices']={};
 for(const section of ['mail','service-connections'] as const){const row=object(entryRows[section]);if(Number.isSafeInteger(row.revision)&&Number(row.revision)>=0&&Number(row.revision)<=2147483646){
  if(section==='mail')entries.mail={revision:Number(row.revision),base:mail(row.base),draft:mail(row.draft)};
  else entries['service-connections']={revision:Number(row.revision),base:services(row.base),draft:services(row.draft)};
 }
 const choice=object(object(value.choices)[section]),fields:Record<string,'mine'|'current'>={};if(Number.isSafeInteger(choice.revision)&&Number(choice.revision)>=0){for(const[key,which]of Object.entries(object(choice.fields)))if(key.length<=160&&/^[a-zA-Z0-9:_-]+$/.test(key)&&(which==='mine'||which==='current'))fields[key]=which;choices[section]={revision:Number(choice.revision),fields};}}
 const generalDraft=(input:unknown):SystemSettingsGeneralConfiguration=>{const row=object(input);return{siteTitle:text(row.siteTitle,120),description:text(row.description,600),footerLinks:Array.isArray(row.footerLinks)?row.footerLinks.slice(0,12).map(raw=>{const link=object(raw);return{label:text(link.label,100),href:text(link.href,2048)};}):[]};};
 const generalRow=object(value.general),general=Number.isSafeInteger(generalRow.revision)&&Number(generalRow.revision)>=0?{revision:Number(generalRow.revision),base:generalDraft(generalRow.base),draft:generalDraft(generalRow.draft)}:null;
 const generalChoice=object(object(value.choices).general);if(Number.isSafeInteger(generalChoice.revision)&&Number(generalChoice.revision)>=0){const fields:Record<string,'mine'|'current'>={};for(const[key,which]of Object.entries(object(generalChoice.fields)))if(['siteTitle','description','footerLinks'].includes(key)&&(which==='mine'||which==='current'))fields[key]=which;choices.general={revision:Number(generalChoice.revision),fields};}
 const runtimeFields=(input:unknown):AutonomyRuntimeFields=>{const row=object(input);return Object.fromEntries(autonomyRuntimeFields.map(([key])=>[key,text(row[key],12)])) as AutonomyRuntimeFields;};
 const runtimeRow=object(value.runtime),runtime=Number.isSafeInteger(runtimeRow.revision)&&Number(runtimeRow.revision)>=1?{revision:Number(runtimeRow.revision),base:runtimeFields(runtimeRow.base),draft:runtimeFields(runtimeRow.draft)}:null;
 const runtimeChoiceRow=object(value.runtimeChoices),runtimeChoices=Number.isSafeInteger(runtimeChoiceRow.revision)&&Number(runtimeChoiceRow.revision)>=1?{revision:Number(runtimeChoiceRow.revision),fields:Object.fromEntries(autonomyRuntimeFields.flatMap(([key])=>{const choice=object(runtimeChoiceRow.fields)[key];return choice==='mine'||choice==='current'?[[key,choice]]:[]})) as Partial<Record<keyof AutonomyRuntimeFields,'mine'|'current'>>}:null;
 const positions:SystemSettingsMemorySnapshot['positions']={};for(const tab of systemSettingsTabIds){const row=object(object(value.positions)[tab]);if(typeof row.left==='number'&&Number.isFinite(row.left)&&row.left>=0&&typeof row.right==='number'&&Number.isFinite(row.right)&&row.right>=0)positions[tab]={left:row.left,right:row.right};}
 return{general,runtime,runtimeChoices,entries,choices,selectedMail:typeof value.selectedMail==='string'&&uuid.test(value.selectedMail)?value.selectedMail:'',selectedService:(systemSettingsServiceKinds as readonly unknown[]).includes(value.selectedService)?value.selectedService as SystemSettingsServiceKind:'analysis',positions};
}

export function systemSettingsGeneralConfiguration(draft:SystemSettingsGeneralConfiguration):{value:SystemSettingsGeneralConfiguration|null;error:string}{
 const siteTitle=draft.siteTitle.trim(),description=draft.description.trim();if(!siteTitle||siteTitle.length>120||description.length>600||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(siteTitle+description))return{value:null,error:'请填写网站名称，简介不超过 600 字。'};
 if(draft.footerLinks.length>12)return{value:null,error:'页尾入口最多 12 项。'};
 const footerLinks=[];
 for(const row of draft.footerLinks){const label=row.label.trim(),href=row.href.trim();let safe=false;try{safe=!/[\\\p{Cc}\s]/u.test(href)&&(href.startsWith('/')&&!href.startsWith('//')||new URL(href).protocol==='https:'&&!new URL(href).username&&!new URL(href).password);}catch{}
  if(!label||label.length>100||href.length>2048||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(label)||!safe)return{value:null,error:'请为页尾入口填写文字和站内路径或 HTTPS 地址。'};footerLinks.push({label,href});}
 return{value:{siteTitle,description,footerLinks},error:''};
}
export function systemSettingsGeneralMerge(base:SystemSettingsGeneralConfiguration,mine:SystemSettingsGeneralConfiguration,current:SystemSettingsGeneralConfiguration,choices:SystemSettingsMergeChoice){
 const draft=structuredClone(current),conflicts:SystemSettingsMergeConflict[]=[];
 for(const key of ['siteTitle','description','footerLinks'] as const){if(equal(mine[key],base[key]))continue;if(equal(current[key],base[key])||equal(mine[key],current[key])){Object.assign(draft,{[key]:mine[key]});continue;}
  const display=(value:unknown)=>Array.isArray(value)?value.map(row=>row.label+' · '+row.href).join('；')||'无页尾入口':short(value);
  conflicts.push({key,label:{siteTitle:'网站名称',description:'网站简介',footerLinks:'页尾入口'}[key],mine:display(mine[key]),current:display(current[key])});if(choices[key]==='mine')Object.assign(draft,{[key]:mine[key]});
 }return{draft,conflicts,unresolved:conflicts.filter(row=>!choices[row.key]).length};
}
