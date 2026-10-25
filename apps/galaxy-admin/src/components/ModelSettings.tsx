'use client';

import {SettingsDraftBoundary,useSettingsDraftState} from './SettingsDraftBoundary';
import {useSettingsDraftMemory} from '../lib/use-settings-draft-memory';
import {SettingsReceiptNotice,useSettingsReceiptRecovery} from '../lib/use-settings-receipt-recovery';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {FormEvent,ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {operationsFailure,operationsRequest,OperationsRequestError} from '../lib/operations-client';
import {useOperationsRead} from '../lib/use-operations-read';
import {modelSettingsClone,modelSettingsConflictValue,modelSettingsCount,modelSettingsCredential,modelSettingsDomainNames,modelSettingsDomains,modelSettingsEffective,modelSettingsEffortNames,modelSettingsEfforts,modelSettingsEmpty,modelSettingsErrors,modelSettingsFormatNames,modelSettingsHistoryLines,modelSettingsHref,modelSettingsMerge,modelSettingsNewModel,modelSettingsOperationLabel,modelSettingsOperator,modelSettingsPath,modelSettingsProgressLabel,modelSettingsSafeConfiguration,modelSettingsSame,modelSettingsSource,modelSettingsTabs,modelSettingsTime,modelSettingsValidation,modelSettingsWithFormat} from '../lib/model-settings-view-model';
import type {ModelSettingsConfiguration,ModelSettingsDomain,ModelSettingsEffort,ModelSettingsHistory,ModelSettingsLocation,ModelSettingsModel,ModelSettingsOperation,ModelSettingsOperationResult,ModelSettingsOverview,ModelSettingsUsage} from './model-settings-types';
import {modelUsage} from '../lib/model-usage-view-model';
import {ModelUsagePanel} from './ModelUsagePanel';
import {AdminIcon} from './AdminIcons';
import {AdminTabs} from './AdminTabs';
import {ReadStatus} from './OperationControls';
import './model-settings.css';

const base='/v1/operations/model-settings';
const readable=<T extends {readExpiresAt:number},>(value:T|null)=>value&&value.readExpiresAt*1000>Date.now()?value:null;
type RequestIntent={operationId:string;kind:ModelSettingsOperation['kind'];path:string;body:Record<string,unknown>;attempted:boolean};
type SaveFlow={csrfToken:string;mode:'draft'|'apply'|'apply-existing';configuration:ModelSettingsConfiguration;revision:number;versionId:string|null;keys:{modelId:string;apiKey:string}[];keyIndex:number;stage:'credentials'|'draft'|'apply';request:RequestIntent|null;polls:number;failures:number};
type CommandState={busy:boolean;pending:boolean;message:string;error:string;operation:ModelSettingsOperation|null;step:ModelSettingsOperation['kind']|null;mode:SaveFlow['mode']|null;recoveryRequired:boolean};
type ModelCommandOptions={csrfToken:string;overview:ModelSettingsOverview|null;denied:boolean;read:()=>Promise<ModelSettingsOverview|undefined>;onSaved:(configuration:ModelSettingsConfiguration,revision:number)=>void;onCredential:(modelId:string,reference:string)=>void;onDone:()=>Promise<unknown>;onDenied:()=>void};

function useModelSettingsCommand(options:ModelCommandOptions){
 const [state,setState]=useState<CommandState>({busy:false,pending:false,message:'',error:'',operation:null,step:null,mode:null,recoveryRequired:false});
 const latest=useRef(options);latest.current=options;
 const flow=useRef<SaveFlow|null>(null),alive=useRef(false),inFlight=useRef(false),controller=useRef<AbortController|null>(null),generation=useRef(0),runner=useRef<()=>Promise<void>>(async()=>{});
 function erase(intent:SaveFlow|null){if(!intent)return;intent.keys.forEach(key=>{key.apiKey='';});if(intent.request?.kind==='credential-provision')delete intent.request.body.apiKey;}
 const stop=useCallback((discard=false)=>{generation.current++;controller.current?.abort();controller.current=null;if(discard){erase(flow.current);flow.current=null;}},[]);
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;stop(true);};},[stop]);
 useEffect(()=>{
  const suspend=()=>stop(false),resume=()=>{if(navigator.onLine&&document.visibilityState==='visible'){if(flow.current)flow.current.failures=0;setState(previous=>({...previous,recoveryRequired:false,error:previous.pending?'':previous.error}));void runner.current();}},visible=()=>document.visibilityState==='hidden'?suspend():resume();
  window.addEventListener('offline',suspend);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',visible);
  return()=>{window.removeEventListener('offline',suspend);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',visible);};
 },[stop]);
 useEffect(()=>{if(!options.overview)stop(false);},[options.overview,stop]);
 useEffect(()=>{if(!options.denied)return;stop(true);setState(previous=>({...previous,busy:false,pending:false,message:'',operation:null,step:null,recoveryRequired:false}));},[options.denied,stop]);
 useLayoutEffect(()=>{if(flow.current&&flow.current.csrfToken!==options.csrfToken){stop(true);setState(previous=>({...previous,busy:false,pending:false,operation:null,step:null,recoveryRequired:false,error:'管理登录已变化，原操作不再提交；请查看当前记录。'}));}},[options.csrfToken,stop]);
 const run=useCallback(async()=>{
  const intent=flow.current;if(!intent||inFlight.current||!alive.current||!navigator.onLine||document.visibilityState==='hidden'||!readable(latest.current.overview)||intent.csrfToken!==latest.current.csrfToken)return;
  const requestGeneration=++generation.current,active=new AbortController();controller.current=active;inFlight.current=true;
  setState(previous=>({...previous,busy:true,pending:true,error:'',recoveryRequired:false}));
  const current=()=>alive.current&&!active.signal.aborted&&generation.current===requestGeneration;
  const hasCurrentRead=()=>current()&&intent.csrfToken===latest.current.csrfToken&&!!readable(latest.current.overview);
  try{
   while(hasCurrentRead()){
    if(!intent.request){
     const operationId=crypto.randomUUID();
     if(intent.stage==='credentials'){
      const key=intent.keys[intent.keyIndex];if(!key){intent.stage='draft';continue;}
      intent.request={operationId,kind:'credential-provision',path:base+'/credentials',body:{operationId,modelRecordId:key.modelId,apiKey:key.apiKey},attempted:false};
     }else if(intent.stage==='draft'){
      intent.request={operationId,kind:'draft',path:base+'/draft',body:{operationId,expectedRevision:intent.revision,configuration:modelSettingsSafeConfiguration(intent.configuration),reason:intent.mode==='apply'?'人工保存并应用模型设置':'人工保存模型配置草稿'},attempted:false};
     }else{
      if(!intent.versionId)throw new Error('model_settings_draft_changed');
      intent.request={operationId,kind:'apply',path:base+'/apply',body:{operationId,expectedRevision:intent.revision,versionId:intent.versionId,reason:'人工应用模型设置'},attempted:false};
     }
    }
    const request=intent.request;setState(previous=>({...previous,step:request.kind,message:''}));let result:ModelSettingsOperationResult;
    const post=async()=>{request.attempted=true;return operationsRequest<ModelSettingsOperationResult>(request.path,{csrfToken:intent.csrfToken,body:request.body,signal:active.signal});};
    if(!request.attempted)result=await post();else{
     try{result=await operationsRequest<ModelSettingsOperationResult>(base+'/operations/'+request.operationId,{signal:active.signal});}
     catch(error){if(error instanceof OperationsRequestError&&error.status===404)result=await post();else throw error;}
     if(result.phase==='prepared'&&request.kind!=='draft')result=await post();
    }
    if(!hasCurrentRead())return;
    if(result.phase!=='applied')intent.failures=0;setState(previous=>({...previous,operation:result}));
    if(result.phase==='failed'){
     erase(intent);flow.current=null;setState(previous=>({...previous,pending:false,step:null,message:'',error:modelSettingsErrors[result.errorCode??'']??'设置未能保存，修改已保留。'}));await latest.current.read();return;
    }
    if(result.phase!=='applied'){intent.polls++;return;}
    if(request.kind==='credential-provision'){
     if(!result.credentialRef)throw new Error('model_settings_credential_unavailable');
     const key=intent.keys[intent.keyIndex];key.apiKey='';delete request.body.apiKey;
     intent.configuration.models=intent.configuration.models.map(model=>model.id===key.modelId?{...model,credentialRef:result.credentialRef}:model);
     latest.current.onCredential(key.modelId,result.credentialRef);intent.keyIndex++;intent.request=null;intent.polls=0;intent.failures=0;continue;
    }
    if(request.kind==='draft'){
     intent.versionId=result.versionId;
     // A reconciled POST can have no revision; a fresh overview supplies the next CAS.
     const fresh=await latest.current.read();if(!current())return;
     if(!fresh){intent.polls++;intent.failures++;setState(previous=>({...previous,step:intent.mode==='apply'?'apply':'draft',recoveryRequired:intent.failures>=3,error:intent.failures>=3?'暂时无法连接配置服务，草稿已保存。':''}));return;}
     if(fresh.draft?.id!==intent.versionId)throw new Error('model_settings_draft_changed');
     intent.revision=fresh.revision;latest.current.onSaved(intent.configuration,fresh.revision);intent.request=null;intent.polls=0;intent.failures=0;
     if(intent.mode==='apply'){
      if(!fresh.capabilities.canApply)throw new Error('model_settings_apply_unavailable');
      intent.stage='apply';continue;
     }
    }else{
     const fresh=await latest.current.read();if(!current())return;
     if(fresh)latest.current.onSaved(intent.configuration,fresh.revision);
    }
    erase(intent);flow.current=null;setState(previous=>({...previous,pending:false,step:null,recoveryRequired:false,message:request.kind==='draft'?'草稿已保存，尚未应用。':'配置已生效。',error:''}));await latest.current.onDone();return;
   }
  }catch(error){
   if(!current())return;
   const denied=error instanceof OperationsRequestError&&[401,403].includes(error.status),known=error instanceof OperationsRequestError?error.status<500:error instanceof Error&&error.message.startsWith('model_settings_');
   const code=error instanceof OperationsRequestError?error.code:error instanceof Error?error.message:'';
   if(known){erase(intent);flow.current=null;if(denied)latest.current.onDenied();else void latest.current.read();}
   else{intent.polls++;intent.failures++;}
   setState(previous=>({...previous,pending:!known,message:'',step:known?null:previous.step,recoveryRequired:!known&&intent.failures>=3,error:known?(modelSettingsErrors[code]??(code==='model_settings_apply_unavailable'?'草稿已保存，当前暂不能应用。':operationsFailure(error,'设置未能保存，修改已保留。'))):intent.failures>=3?'暂时无法连接配置服务，修改已保留。':''}));
  }finally{if(controller.current===active)controller.current=null;inFlight.current=false;if(alive.current)setState(previous=>({...previous,busy:false}));}
 },[]);
 runner.current=run;
 useEffect(()=>{if(!state.pending||state.busy||state.recoveryRequired||!options.overview||!flow.current)return;const intent=flow.current,delay=intent.failures?Math.min(8000,1000*(1+intent.failures)):1500+Math.min(intent.polls,8)*500,timer=setTimeout(()=>{void run();},delay);return()=>clearTimeout(timer);},[state.pending,state.busy,state.recoveryRequired,state.operation,options.overview,run]);
 const clearConflict=useCallback(()=>setState(previous=>!previous.pending&&[modelSettingsErrors.model_settings_revision_changed,modelSettingsErrors.model_settings_draft_changed].includes(previous.error)?{...previous,error:''}:previous),[]);
 return{...state,receipt:state.pending&&flow.current?.request?{operationId:flow.current.request.operationId,kind:flow.current.request.kind}:null,locked:state.pending||state.busy,clearConflict,retry:async()=>{if(flow.current){flow.current.failures=0;flow.current.polls=0;}setState(previous=>({...previous,error:'',recoveryRequired:false}));const fresh=await latest.current.read();if(fresh)await run();},
  start:(input:{mode:SaveFlow['mode'];configuration:ModelSettingsConfiguration;revision:number;versionId?:string;keys:Record<string,string>})=>{
   if(flow.current||inFlight.current||!readable(latest.current.overview))return;
   flow.current={csrfToken:latest.current.csrfToken,mode:input.mode,configuration:modelSettingsClone(input.configuration),revision:input.revision,versionId:input.versionId??null,keys:Object.entries(input.keys).filter(([,apiKey])=>!!apiKey).map(([modelId,apiKey])=>({modelId,apiKey})),keyIndex:0,stage:input.mode==='apply-existing'?'apply':'credentials',request:null,polls:0,failures:0};
   setState({busy:false,pending:true,message:'',error:'',operation:null,step:input.mode==='apply-existing'?'apply':Object.values(input.keys).some(Boolean)?'credential-provision':'draft',mode:input.mode,recoveryRequired:false});void run();
  }};
}

function Fact({label,children}:{label:string;children:ReactNode}){return <div><dt>{label}</dt><dd>{children}</dd></div>;}
function StateTag({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className="model-settings-state" data-tone={tone}>{children}</span>;}
function NativeStatus({value}:{value:ModelSettingsOverview|null}){
 const status=modelSettingsEffective(value),native=value?.native;
 function adopted(engine:{configurationVersion:string|null;state:string}|undefined){
  const version=engine?.configurationVersion;
  if(!native||native.availability.state!=='available'||!engine||['unknown','unavailable'].includes(engine.state))return '暂未取得';
  if(!version)return value?.active?'版本未取得':'尚未配置';
  if(value?.active&&native.appliedVersionId===value.active.id&&native.configurationVersion&&version===native.configurationVersion)return '已采用 v'+value.active.version;
  return '版本待核对';
 }
 return <section className="model-settings-side-card"><h2>当前生效</h2><StateTag tone={status==='applied'?'good':status==='drift'?'warning':'neutral'}>{status==='applied'?'两端配置已一致':status==='not-configured'?'尚未配置模型':status==='drift'?'配置读回不一致':'生效状态未确认'}</StateTag>
  <dl className="model-settings-facts"><Fact label="生效版本">{!value?'未取得':value.active?'v'+value.active.version:'未设置'}</Fact><Fact label="保存草稿">{!value?'未取得':value.draft?'v'+value.draft.version:'暂无草稿'}</Fact><Fact label="模型网关"><span title={native?.engines.gateway.configurationVersion??undefined}>{adopted(native?.engines.gateway)}</span></Fact><Fact label="执行服务"><span title={native?.engines.agentos.configurationVersion??undefined}>{adopted(native?.engines.agentos)}</span></Fact><Fact label="网关模型数">{modelSettingsCount(native?.engines.gateway.modelCount)}</Fact></dl>
  <p className="model-settings-note">配置状态不检查供应商模型连通性。</p>
 </section>;
}

export function ModelSettings(props:Parameters<typeof ModelSettingsSettings>[0]){return <SettingsDraftBoundary scope="/admin/operations/models" resetKey={props.csrfToken}><ModelSettingsSettings {...props}/></SettingsDraftBoundary>;}
function ModelSettingsSettings({location,csrfToken,canConfigure,canApply}:{location:ModelSettingsLocation;csrfToken:string;canConfigure:boolean;canApply:boolean}){
 const router=useRouter();
 const [online,setOnline]=useState(true);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);update();window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 const overview=useOperationsRead<ModelSettingsOverview>({path:modelSettingsPath('overview',location),failureMessage:'模型设置暂时无法取得。',clearOnOffline:true});
 const usage=useOperationsRead<ModelSettingsUsage>({path:modelSettingsPath('usage',location),failureMessage:'基础用量暂时无法取得。',clearOnOffline:true});
 const history=useOperationsRead<ModelSettingsHistory>({path:modelSettingsPath('history',location),failureMessage:'配置记录暂时无法取得。',clearOnOffline:true});
 const [clock,setClock]=useState(()=>Date.now()),[configuration,setConfiguration]=useState<ModelSettingsConfiguration>(modelSettingsEmpty),[baseConfiguration,setBaseConfiguration]=useState<ModelSettingsConfiguration>(modelSettingsEmpty),[baseRevision,setBaseRevision]=useState<number|null>(null),[keys,setKeys]=useState<Record<string,string>>({}),[errors,setErrors]=useState<string[]>([]),[mergeDecision,setMergeDecision]=useState<{revision:number;choices:Record<string,'mine'|'current'>}|null>(null),[selected,setSelected]=useState(location.id);
 const editor=useRef<HTMLDivElement|null>(null),sidebar=useRef<HTMLElement|null>(null),positions=useRef<Record<string,number>>({}),pendingPolls=useRef({id:'',count:0});
 const current=readable(overview.value),historyValue=readable(history.value),usageValue=modelUsage(readable(usage.value)),source=current?modelSettingsSource(current):null;
 const dirty=!modelSettingsSame(configuration,baseConfiguration)||Object.values(keys).some(Boolean);
 const changed=!!current&&baseRevision!==null&&current.revision!==baseRevision;
 const memory=useSettingsDraftMemory({scope:'models',ready:!!current&&overview.verified,blocked:!!current?.pending&&!current.capabilities.canConfigure,denied:!canConfigure||!!current&&!current.capabilities.canConfigure&&!current.pending||!!overview.error&&/登录|权限/.test(overview.error),snapshot:()=>({configuration,baseConfiguration,baseRevision,selected,positions:positions.current}),restore:value=>{setConfiguration(value.configuration);setBaseConfiguration(value.baseConfiguration);setBaseRevision(value.baseRevision);setSelected(location.id||value.selected);positions.current=value.positions;setKeys({});setMergeDecision(null);},discard:()=>{const fresh=modelSettingsClone(source?.configuration??modelSettingsEmpty());setConfiguration(fresh);setBaseConfiguration(modelSettingsClone(fresh));setBaseRevision(current?.revision??null);setKeys({});setMergeDecision(null);}});
 const mergeChoices=current&&mergeDecision?.revision===current.revision?mergeDecision.choices:{};
 const merge=current&&changed?modelSettingsMerge(baseConfiguration,configuration,source?.configuration??modelSettingsEmpty(),mergeChoices,Object.keys(keys).filter(id=>!!keys[id])):null;
 const refresh=useCallback(async()=>{await Promise.all([overview.read(),usage.read(),history.read()]);},[overview.read,usage.read,history.read]);
 const localCommand=useModelSettingsCommand({csrfToken,overview:current,denied:!!overview.error&&/登录|权限/.test(overview.error),read:overview.read,
  onCredential:(modelId,reference)=>setConfiguration(previous=>({...previous,models:previous.models.map(model=>model.id===modelId?{...model,credentialRef:reference}:model)})),
  onSaved:(saved,revision)=>{setConfiguration(modelSettingsClone(saved));setBaseConfiguration(modelSettingsClone(saved));setBaseRevision(revision);setMergeDecision(null);},
  onDone:refresh,onDenied:()=>{setKeys({});overview.clear();usage.clear();history.clear();}});
 const recovery=useSettingsReceiptRecovery({scope:'models',refresh:refresh,live:localCommand.receipt,ready:!!current&&overview.verified,denied:!!overview.error&&/登录|权限/.test(overview.error),onRecorded:async receipt=>{if(receipt.kind==='credential-provision'&&receipt.phase==='applied'&&receipt.modelRecordId&&receipt.credentialRef){const apply=(value:ModelSettingsConfiguration)=>({...value,models:value.models.map(model=>model.id===receipt.modelRecordId?{...model,credentialRef:receipt.credentialRef}:model)});const saved=memory.session?.read('models');if(saved)memory.session?.write('models',{...saved,configuration:apply(saved.configuration)});setConfiguration(apply);}await refresh();},onDenied:()=>{setKeys({});overview.clear();usage.clear();history.clear();}});
 const command={...localCommand,locked:localCommand.locked||recovery.pending};
 useEffect(()=>{
   if(!memory.initialized||!current||command.locked)return;
  if(baseRevision===null||!dirty){const next=modelSettingsClone(source?.configuration??modelSettingsEmpty());setConfiguration(next);setBaseConfiguration(modelSettingsClone(next));setBaseRevision(current.revision);setMergeDecision(null);}
  },[memory.initialized,current?.checkedAt,current?.revision,source,baseRevision,dirty,command.locked]);
 useEffect(()=>{if(changed)command.clearConflict();},[changed,command.clearConflict]);
 useEffect(()=>{
  if(!current||!changed||!merge?.configuration||merge.unresolved||command.locked)return;
  setConfiguration(modelSettingsClone(merge.configuration));setBaseConfiguration(modelSettingsClone(source?.configuration??modelSettingsEmpty()));setBaseRevision(current.revision);setMergeDecision(null);setErrors([]);
  if(merge.discardCredentialIds.length)setKeys(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>!merge.discardCredentialIds.includes(id))));
 },[current,changed,merge,source,command.locked]);
 useEffect(()=>{setSelected(location.id);},[location.id]);
 useEffect(()=>{
  setClock(Date.now());const ends=[overview.value?.readExpiresAt,usage.value?.readExpiresAt,history.value?.readExpiresAt].filter((value):value is number=>typeof value==='number'&&value*1000>Date.now());if(!ends.length)return;
  const timer=setTimeout(()=>setClock(Date.now()),Math.max(1,Math.min(...ends)*1000-Date.now()));return()=>clearTimeout(timer);
 },[overview.value,usage.value,history.value]);
  useLayoutEffect(()=>{setKeys({});},[csrfToken]);
  useEffect(()=>{const clear=()=>setKeys({});window.addEventListener('offline',clear);return()=>window.removeEventListener('offline',clear);},[]);
 useEffect(()=>{if(!current)setKeys(previous=>Object.keys(previous).length?{}:previous);},[!!current]);
 useEffect(()=>{if(overview.error&&/登录|权限/.test(overview.error)){setKeys({});usage.clear();history.clear();}},[overview.error,usage.clear,history.clear]);
 useEffect(()=>{
  const operation=current?.pending;if(!operation||command.locked)return;if(pendingPolls.current.id!==operation.operationId)pendingPolls.current={id:operation.operationId,count:0};
  const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible'){pendingPolls.current.count++;void overview.read();}},Math.min(10000,2000+pendingPolls.current.count*1000));return()=>clearTimeout(timer);
 },[current?.pending,current?.checkedAt,command.locked,overview.read]);
 useLayoutEffect(()=>{if(current&&editor.current)editor.current.scrollTop=positions.current[location.tab+':'+selected]??0;},[location.tab,selected,!!current]);
 void clock;
 const selectedModel=configuration.models.find(model=>model.id===selected)??configuration.models[0]??null;
 const editable=!!current&&overview.verified&&canConfigure&&current.capabilities.canConfigure&&!command.locked;
 const nativeAvailable=current?.native?.availability.state==='available';
 const modelNames=Object.fromEntries(configuration.models.map(model=>[model.id,model.displayName||'未命名模型']));
 function navigate(patch:Partial<ModelSettingsLocation>){if(!command.locked)router.push(modelSettingsHref(location,patch),{scroll:false});}
 function forgetMergeChoice(path:string){setMergeDecision(previous=>{if(!previous||!Object.hasOwn(previous.choices,path))return previous;const choices={...previous.choices};delete choices[path];return{...previous,choices};});}
 function updateModel(patch:Partial<ModelSettingsModel>){if(!editable||!selectedModel)return;for(const field of Object.keys(patch))forgetMergeChoice('models.'+selectedModel.id+'.'+(['modelId','apiFormat','baseUrl','credentialRef'].includes(field)?'connection':field));setConfiguration(previous=>({...previous,models:previous.models.map(model=>model.id===selectedModel.id?{...model,...patch}:model)}));setErrors([]);}
 function updateScenario(domain:ModelSettingsDomain,binding:ModelSettingsConfiguration['scenarios'][ModelSettingsDomain]){forgetMergeChoice('scenarios.'+domain);setConfiguration(previous=>({...previous,scenarios:{...previous.scenarios,[domain]:binding}}));}
 function createModel(){if(!editable||configuration.models.length>=50)return;const id=crypto.randomUUID();setConfiguration(previous=>({...previous,models:[...previous.models,modelSettingsNewModel(id)]}));setSelected(id);navigate({id});}
 function cancelNewModel(){
  if(!editable||!selectedModel||source?.configuration.models.some(model=>model.id===selectedModel.id))return;
  const id=selectedModel.id,remaining=configuration.models.filter(model=>model.id!==id),next=remaining[0]?.id??'';
  setConfiguration(previous=>({...previous,models:previous.models.filter(model=>model.id!==id),scenarios:Object.fromEntries(modelSettingsDomains.map(domain=>[domain,previous.scenarios[domain]?.modelId===id?null:previous.scenarios[domain]])) as ModelSettingsConfiguration['scenarios']}));
  setKeys(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>key!==id)));setSelected(next);setErrors([]);navigate({id:next});
 }
 function revertLocal(){
  if(!editable||!current)return;const saved=modelSettingsClone(source?.configuration??modelSettingsEmpty());
  setConfiguration(saved);setBaseConfiguration(modelSettingsClone(saved));setBaseRevision(current.revision);setKeys({});setMergeDecision(null);setErrors([]);
  const next=saved.models.some(model=>model.id===selected)?selected:saved.models[0]?.id??'';setSelected(next);navigate({id:next});
 }
 function save(event:FormEvent,mode:'draft'|'apply'){
  event.preventDefault();if(!editable||baseRevision===null||changed)return;
  const validation=modelSettingsValidation(configuration,{applying:mode==='apply',pendingKeys:Object.keys(keys).filter(id=>!!keys[id])});
  if(Object.values(keys).some(key=>key&&(key.trim()!==key||/[\p{Cc}]/u.test(key)||key.length>16384)))validation.push('API Key 不能包含前后空格或控制字符。');
  if(Object.values(keys).some(Boolean)&&!current?.capabilities.canProvisionCredentials)validation.push('凭据配置服务暂不可用，请稍后保存。');
  if(mode==='apply'&&(!canApply||!nativeAvailable||modelSettingsEffective(current)==='drift'))validation.push('当前暂不能应用配置，仍可保存草稿。');
  if(validation.length){setErrors(validation);return;}
  const credentialInput={...keys};setKeys({});setErrors([]);command.start({mode,configuration:modelSettingsSafeConfiguration(configuration),revision:baseRevision,keys:credentialInput});
 }
 function applyExisting(){if(!current?.draft||!current.capabilities.canApply||!canApply||command.locked)return;setErrors([]);command.start({mode:'apply-existing',configuration:current.draft.configuration,revision:current.revision,versionId:current.draft.id,keys:{}});}
 const activity=command.locked?command.step:current?.pending?.kind??null;
 useSettingsDraftState(dirty,command.locked);
 return <section className="galaxy-model-settings" aria-label="人工模型设置">
  <header className="model-settings-header"><div><h1>模型设置与用量</h1><span>人工配置</span></div><button type="button" disabled={command.locked||overview.loading||usage.loading||history.loading} onClick={()=>void refresh()}><AdminIcon name="refresh" size={15}/>刷新</button></header>
  <AdminTabs items={modelSettingsTabs.map(tab=>({...tab,disabled:command.locked}))} active={location.tab} onChange={tab=>navigate({tab:tab as ModelSettingsLocation['tab']})} ariaLabel="模型设置页面"/>
  <div className="model-settings-status"><SettingsReceiptNotice recovery={recovery}/><ReadStatus loading={overview.loading} error={command.error?'':!online?'网络已断开，恢复后会更新配置、用量和记录。':overview.error} retry={online?overview.read:refresh}/>{command.error?<div className="model-settings-feedback" data-tone="error" role="alert"><AdminIcon name="warning" size={17}/><span>{command.error}</span>{command.recoveryRequired&&<button type="button" disabled={command.busy||!current} onClick={()=>void command.retry()}>重新连接</button>}</div>:activity&&current?<div className="model-settings-feedback" role="status" aria-live="polite"><span className="model-settings-spinner" aria-hidden="true"/><span>{modelSettingsProgressLabel(activity)}</span></div>:command.message?<output className="model-settings-feedback" data-tone="success" role="status"><AdminIcon name="check" size={17}/><span>{command.message}</span></output>:null}</div>
  <div className="model-settings-workspace">
   <section className="model-settings-editor" aria-label={modelSettingsTabs.find(tab=>tab.id===location.tab)?.label}>
    <div ref={editor} className="model-settings-editor-scroll" onScroll={event=>{if(current)positions.current[location.tab+':'+selected]=event.currentTarget.scrollTop;}}>
     {!current?<div className="model-settings-empty"><AdminIcon name="settings" size={29}/><h2>模型配置暂未取得</h2><p>重新读取后可继续配置。</p></div>:<>
      {changed&&merge&&<section className="model-settings-conflict" aria-label="配置版本变化"><strong>当前配置已有更新，你的修改已保留。</strong>{merge.configuration?<><p>选择有冲突的设置，其余更改自动保留。</p>{merge.conflicts.map(conflict=><fieldset key={conflict.path} disabled={command.locked}><legend>{conflict.label}</legend>{(['current','mine'] as const).map(choice=><label key={choice}><input type="radio" name={conflict.path} checked={mergeChoices[conflict.path]===choice} onChange={()=>setMergeDecision(previous=>({revision:current.revision,choices:{...(previous?.revision===current.revision?previous.choices:{}),[conflict.path]:choice}}))}/>{choice==='current'?'当前配置':'我的修改'}：{modelSettingsConflictValue(conflict[choice],conflict.path)}</label>)}</fieldset>)}</>:<p>连接资料暂未完整取得，恢复读取后可继续编辑。</p>}</section>}
      {location.tab==='usage'?<><div className="model-settings-usage-toolbar"><span>统计范围</span><AdminTabs items={[{id:'7',label:'近 7 天',disabled:command.locked},{id:'30',label:'近 30 天',disabled:command.locked}]} active={String(location.days)} onChange={days=>navigate({days:days==='30'?30:7})} ariaLabel="基础用量时间"/></div><ReadStatus loading={usage.loading} error={online?usage.error:''} retry={usage.read}/><ModelUsagePanel value={usageValue} modelNames={modelNames}/></>:<form onSubmit={event=>save(event,'apply')}>
       {location.tab==='models'?<>
        <div className="model-settings-picker"><label>模型连接<select aria-label="当前模型连接" disabled={command.locked} value={selectedModel?.id??''} onChange={event=>{setSelected(event.target.value);navigate({id:event.target.value});}}>{configuration.models.length===0&&<option value="">尚未添加模型</option>}{configuration.models.map((model,index)=><option key={model.id} value={model.id}>{model.displayName||'新模型 '+(index+1)}{model.enabled?'':' · 已停用'}</option>)}</select></label>{canConfigure&&<button type="button" disabled={!editable||configuration.models.length>=50} onClick={createModel}><AdminIcon name="plus" size={15}/>新增模型</button>}{canConfigure&&selectedModel&&!source?.configuration.models.some(model=>model.id===selectedModel.id)&&<button type="button" disabled={!editable} onClick={cancelNewModel}>取消本次新增</button>}</div>
        {!selectedModel?<div className="model-settings-empty"><AdminIcon name="settings" size={30}/><h2>尚未添加模型连接</h2><p>{canConfigure?'新增连接后，可为不同领域选择模型。':'当前没有已保存的模型连接。'}</p></div>:<fieldset disabled={!editable} className="model-settings-form-fields">
         <section className="model-settings-section"><div className="model-settings-section-title"><h2>连接设置</h2><label className="model-settings-checkbox"><input type="checkbox" checked={selectedModel.enabled} onChange={event=>updateModel({enabled:event.target.checked})}/>启用此模型</label></div>
          <div className="model-settings-fields"><label>显示名称<input value={selectedModel.displayName} maxLength={100} autoComplete="off" onChange={event=>updateModel({displayName:event.target.value})}/></label><label>API 模型名称<input value={selectedModel.modelId??''} maxLength={200} autoComplete="off" spellCheck={false} placeholder="服务商提供的真实 model ID" onChange={event=>updateModel({modelId:event.target.value||null})}/></label><label>接口格式<select value={selectedModel.apiFormat} onChange={event=>updateModel(modelSettingsWithFormat(selectedModel,event.target.value as ModelSettingsModel['apiFormat']))}>{current.formats.map(format=><option key={format} value={format}>{modelSettingsFormatNames[format]}</option>)}</select></label><label>接口地址 · Base URL<input type="url" value={selectedModel.baseUrl??''} maxLength={2048} autoComplete="off" spellCheck={false} placeholder="https://…" onChange={event=>updateModel({baseUrl:event.target.value||null})}/></label></div>
          <div className="model-settings-credential"><label>API Key<input type="password" autoComplete="new-password" spellCheck={false} value={keys[selectedModel.id]??''} placeholder={selectedModel.credentialRef?'留空保留现有凭据':'输入 API Key'} onChange={event=>{forgetMergeChoice('models.'+selectedModel.id+'.connection');setKeys(previous=>({...previous,[selectedModel.id]:event.target.value}));}}/></label><StateTag tone={modelSettingsCredential(selectedModel,current.native)==='configured'?'good':'neutral'}>{keys[selectedModel.id]?'待保存新凭据':modelSettingsCredential(selectedModel,current.native)==='configured'?'凭据已配置':modelSettingsCredential(selectedModel,current.native)==='unknown'?'凭据状态未确认':'未配置凭据'}</StateTag></div>
         </section>
         <section className="model-settings-section"><h2>上下文与输出</h2><div className="model-settings-fields model-settings-fields-three">{([['contextWindow','上下文窗口 · Token',100000000],['maxOutputTokens','最大输出 · Token',100000000],['timeoutSeconds','超时 · 秒',1800]] as const).map(([field,label,max])=><label key={field}>{label}<input type="number" min="1" max={max} step="1" value={selectedModel[field]??''} placeholder="未设置" onChange={event=>updateModel({[field]:event.target.value===''?null:Number(event.target.value)})}/></label>)}</div></section>
         <section className="model-settings-section"><h2>思考与能力</h2><p className="model-settings-note">按接口实际支持填写。</p><div className="model-settings-efforts"><span>支持的思考档位</span><div>{modelSettingsEfforts.filter(effort=>selectedModel.apiFormat!=='gemini'||!['xhigh','max'].includes(effort)).map(effort=><label key={effort} className="model-settings-checkbox"><input type="checkbox" checked={selectedModel.reasoning.supportedEfforts.includes(effort)} onChange={event=>{const efforts=event.target.checked?[...selectedModel.reasoning.supportedEfforts,effort]:selectedModel.reasoning.supportedEfforts.filter(value=>value!==effort);updateModel({reasoning:{...selectedModel.reasoning,supportedEfforts:efforts,...(!efforts.includes(selectedModel.reasoning.effort as ModelSettingsEffort)?{mode:'default',effort:null}:{})}});}}/>{effort}</label>)}</div></div><div className="model-settings-fields"><label>使用的思考档位<select value={selectedModel.reasoning.mode==='default'?'default':selectedModel.reasoning.effort??'default'} onChange={event=>updateModel({reasoning:{...selectedModel.reasoning,mode:event.target.value==='default'?'default':'effort',effort:event.target.value==='default'?null:event.target.value as ModelSettingsEffort}})}><option value="default">使用模型默认</option>{selectedModel.reasoning.supportedEfforts.map(effort=><option key={effort} value={effort}>{modelSettingsEffortNames[effort]}</option>)}</select></label><div className="model-settings-capabilities"><label className="model-settings-checkbox"><input type="checkbox" checked={selectedModel.toolCalling} onChange={event=>updateModel({toolCalling:event.target.checked})}/>支持工具调用</label><label className="model-settings-checkbox"><input type="checkbox" checked={selectedModel.structuredOutput} onChange={event=>updateModel({structuredOutput:event.target.checked})}/>支持结构化输出</label></div></div></section>
        </fieldset>}
       </>:<section className="model-settings-scenarios"><h2>场景分配</h2><p className="model-settings-note">选择各领域使用的模型及允许处理的资料。</p>{modelSettingsDomains.map(domain=>{const binding=configuration.scenarios[domain];return <fieldset key={domain} disabled={!editable} className="model-settings-scenario"><legend>{modelSettingsDomainNames[domain]}</legend><label>使用模型<select value={binding?.modelId??''} onChange={event=>updateScenario(domain,event.target.value?{modelId:event.target.value,dataPolicyApproved:false}:null)}><option value="">不配置模型</option>{configuration.models.map(model=><option key={model.id} value={model.id}>{model.displayName||'未命名模型'}{model.enabled?'':' · 已停用'}</option>)}</select></label>{binding&&<label className="model-settings-checkbox"><input type="checkbox" checked={binding.dataPolicyApproved} onChange={event=>updateScenario(domain,{...binding,dataPolicyApproved:event.target.checked})}/>允许该服务处理本领域已获准资料</label>}</fieldset>;})}</section>}
       {!!errors.length&&<div className="model-settings-validation" role="alert">{errors.map(error=><p key={error}>{error}</p>)}</div>}
       <footer className="model-settings-actions"><div><span>{dirty?'有未保存修改':current.draft?(current.draft.id===current.active?.id?(modelSettingsEffective(current)==='applied'?'当前配置已生效':'配置已保存'):'草稿尚未应用'):'暂无配置草稿'}</span>{!canConfigure&&<span>当前配置为只读</span>}</div><div>{canConfigure&&dirty&&<button type="button" disabled={!editable} onClick={revertLocal}>撤销本地修改</button>}{canConfigure&&<><button type="button" disabled={!editable||changed||!dirty} onClick={event=>save(event,'draft')}>{command.locked&&command.mode==='draft'?(command.recoveryRequired?'等待连接':'正在保存…'):'保存草稿'}</button>{(dirty||!!activity||!current.draft||current.draft.id===current.active?.id)&&<button className="model-settings-primary" type="submit" disabled={!editable||changed||!dirty||!canApply||!nativeAvailable||modelSettingsEffective(current)==='drift'}>{command.locked&&command.mode==='apply'?(command.recoveryRequired?'等待连接':command.step==='apply'?'正在应用…':'正在保存…'):'保存并应用'}</button>}</>}{canApply&&!dirty&&!activity&&current.draft&&current.active?.id!==current.draft.id&&<button className="model-settings-primary" type="button" disabled={!current.capabilities.canApply||command.locked} onClick={applyExisting}>应用已保存草稿</button>}</div></footer>
      </form>}
     </>}
    </div>
   </section>
   <aside ref={sidebar} className="model-settings-sidebar" aria-label="生效状态与记录">
    <NativeStatus value={current}/>
    {location.tab!=='usage'&&<section className="model-settings-side-card"><div className="model-settings-section-title"><h2>近 {location.days} 天用量</h2><button type="button" disabled={command.locked} onClick={()=>navigate({tab:'usage'})}>查看用量</button></div><div className="model-settings-quick-usage"><div><span>调用</span><strong>{modelSettingsCount(usageValue?.availability.state==='available'?usageValue.calls.total:null)}</strong></div><div><span>已报告 Token</span><strong>{modelSettingsCount(usageValue?.availability.state==='available'?usageValue.tokens.total:null)}</strong></div></div><ReadStatus loading={usage.loading} error={online?usage.error:''} retry={usage.read}/></section>}
    <section className="model-settings-side-card model-settings-history"><h2>配置记录</h2><ReadStatus loading={history.loading} error={online?history.error:''} retry={history.read} empty={!!historyValue&&!historyValue.items.length}/>{historyValue?.items.map(item=><article key={item.operationId}><div><strong>{modelSettingsOperationLabel(item)}</strong>{item.version!==null&&<span>v{item.version}</span>}</div><time>{modelSettingsTime(item.updatedAt)}</time>{modelSettingsHistoryLines(item).map((line,index)=><p key={index}>{line}</p>)}<p className="model-settings-note">操作者 {modelSettingsOperator(item)}</p></article>)}<div className="model-settings-history-pages">{location.historyTrail.length>0&&<button type="button" disabled={command.locked} onClick={()=>navigate({historyAfter:location.historyTrail.at(-1)??'',historyTrail:location.historyTrail.slice(0,-1)})}>较新记录</button>}{historyValue?.nextAfter&&<button type="button" disabled={command.locked} onClick={()=>navigate({historyAfter:historyValue.nextAfter!,historyTrail:[...location.historyTrail,location.historyAfter].slice(-30)})}>更早记录</button>}</div></section>
   </aside>
  </div>
 </section>;
}
