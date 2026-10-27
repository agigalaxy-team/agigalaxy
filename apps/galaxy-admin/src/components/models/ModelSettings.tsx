'use client';

import {SettingsDraftBoundary,useSettingsDraftState} from "../SettingsDraftBoundary";
import {useSettingsDraftMemory} from "../../lib/use-settings-draft-memory";
import {SettingsReceiptNotice,useSettingsReceiptRecovery} from "../../lib/use-settings-receipt-recovery";
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {FormEvent,ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {useOperationsRead} from "../../lib/use-operations-read";
import {modelSettingsClone,modelSettingsConflictValue,modelSettingsCount,modelSettingsDomainNames,modelSettingsDomains,modelSettingsEffective,modelSettingsEmpty,modelSettingsHistoryLines,modelSettingsHref,modelSettingsMerge,modelSettingsNewModel,modelSettingsOperationLabel,modelSettingsOperator,modelSettingsPath,modelSettingsProgressLabel,modelSettingsSafeConfiguration,modelSettingsSame,modelSettingsSource,modelSettingsTabs,modelSettingsTime,modelSettingsValidation} from "../../lib/models/model-settings-view-model";
import type {ModelSettingsConfiguration,ModelSettingsDomain,ModelSettingsHistory,ModelSettingsLocation,ModelSettingsModel,ModelSettingsOverview,ModelSettingsUsage} from './model-settings-types';
import {modelUsage} from "../../lib/models/model-usage-view-model";
import {ModelUsagePanel} from './ModelUsagePanel';
import {AdminIcon} from "../AdminIcons";
import {AdminTabs} from "../AdminTabs";
import {ReadStatus} from "../OperationControls";
import {ModelConnectionEditor} from './ModelConnectionEditor';

import {useModelSettingsCommand} from "../../lib/models/use-model-settings-command";
import './model-settings.css';
import './model-connection-editor.css';

const readable=<T extends {readExpiresAt:number},>(value:T|null)=>value&&value.readExpiresAt*1000>Date.now()?value:null;

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
 const editor=useRef<HTMLDivElement|null>(null),sidebar=useRef<HTMLElement|null>(null),positions=useRef<Record<string,number>>({});
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
        {!selectedModel?<div className="model-settings-empty"><AdminIcon name="settings" size={30}/><h2>尚未添加模型连接</h2><p>{canConfigure?'新增连接后，可为不同领域选择模型。':'当前没有已保存的模型连接。'}</p></div>:<fieldset disabled={!editable} className="model-settings-form-fields"><ModelConnectionEditor model={selectedModel} models={configuration.models} formats={current.formats} native={current.native} apiKey={keys[selectedModel.id]??''} onChange={updateModel} onKey={value=>{forgetMergeChoice('models.'+selectedModel.id+'.connection');setKeys(previous=>({...previous,[selectedModel.id]:value}));}}/></fieldset>}
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
