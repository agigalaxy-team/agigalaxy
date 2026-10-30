import type {ModelSettingsConfiguration,ModelSettingsDomain,ModelSettingsEffort,ModelSettingsFormat,ModelSettingsHistoryItem,ModelSettingsLocation,ModelSettingsModel,ModelSettingsNative,ModelSettingsOperation,ModelSettingsOverview,ModelSettingsPhase} from "../../components/models/model-settings-types";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sequence=(value:string)=>/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
const string=(value:unknown)=>typeof value==='string'?value:'';
export const modelSettingsDomains:readonly ModelSettingsDomain[]=['overview','governance','messaging','discovery','maintenance'];
export const modelSettingsDomainNames:Record<ModelSettingsDomain,string>={overview:'综合运营',governance:'治理审查',messaging:'公告与消息',discovery:'内容与发现',maintenance:'运行诊断'};
export const modelSettingsFormatNames:Record<ModelSettingsFormat,string>={'openai-chat':'OpenAI Chat Completions','openai-responses':'OpenAI Responses',anthropic:'Anthropic Messages',gemini:'Google Gemini'};
export const modelSettingsEfforts:readonly ModelSettingsEffort[]=['none','minimal','low','medium','high','xhigh','max'];
export const modelSettingsEffortNames:Record<ModelSettingsEffort,string>={none:'不启用 · none',minimal:'最低 · minimal',low:'低 · low',medium:'中 · medium',high:'高 · high',xhigh:'更高 · xhigh',max:'最高 · max'};
export const modelSettingsSearchKeys=['tab','id','days','historyAfter','historyTrail'] as const;
export const modelSettingsTabs=[{id:'models',label:'模型配置'},{id:'scenarios',label:'场景分配'},{id:'usage',label:'基础用量'}] as const;
export function modelSettingsLocation(input:Record<string,unknown>={}):ModelSettingsLocation{
 let historyTrail:string[]=[];
 try{const source=string(input.historyTrail);if(source.length<6500){const values:unknown=JSON.parse(source||'[]');if(Array.isArray(values)&&values.length<=30&&values.every(v=>typeof v==='string'&&(v===''||sequence(v))))historyTrail=values as string[];}}catch{}
 return{tab:input.tab==='scenarios'||input.tab==='usage'?input.tab:'models',id:uuid.test(string(input.id))?string(input.id).toLowerCase():'',days:input.days===30||input.days==='30'?30:7,historyAfter:sequence(string(input.historyAfter))?string(input.historyAfter):'',historyTrail};
}
export function modelSettingsHref(location:ModelSettingsLocation,patch:Partial<ModelSettingsLocation>={}){
 const value=modelSettingsLocation({...location,...patch,historyTrail:JSON.stringify(patch.historyTrail??location.historyTrail)}),params=new URLSearchParams({tab:value.tab});
 if(value.id)params.set('id',value.id);if(value.days===30)params.set('days','30');if(value.historyAfter)params.set('historyAfter',value.historyAfter);if(value.historyTrail.length)params.set('historyTrail',JSON.stringify(value.historyTrail));
 return'/admin/operations/models?'+params;
}
export function modelSettingsPath(kind:'overview'|'history'|'usage'|'operation',location:ModelSettingsLocation,id?:string){
 const base='/v1/operations/model-settings';if(kind==='overview')return base+'/overview';if(kind==='operation')return id&&uuid.test(id)?base+'/operations/'+id:null;
 if(kind==='usage')return base+'/usage?days='+location.days;
 const params=new URLSearchParams({limit:'20'});if(location.historyAfter)params.set('after',location.historyAfter);return base+'/history?'+params;
}
export const modelSettingsEmpty=():ModelSettingsConfiguration=>({models:[],scenarios:{overview:null,governance:null,messaging:null,discovery:null,maintenance:null}});
export const modelSettingsClone=(configuration:ModelSettingsConfiguration):ModelSettingsConfiguration=>structuredClone(configuration);
export const modelSettingsSame=(left:unknown,right:unknown):boolean=>JSON.stringify(left)===JSON.stringify(right);
export const modelSettingsDefaultCompression={enabled:true,triggerPercent:80,recentTokens:8192,summaryTokens:2048} as const;
export function modelSettingsNewModel(id:string):ModelSettingsModel{
 return{id,displayName:'',modelId:null,apiFormat:'openai-chat',baseUrl:null,credentialRef:null,contextWindow:null,maxOutputTokens:null,timeoutSeconds:null,reasoning:{mode:'default',effort:null,supportedEfforts:[],supportSource:'manual'},toolCalling:false,structuredOutput:false,imageUnderstanding:false,parallelToolCalls:null,verbosity:null,fallbacks:[],enabled:false};
}
export function modelSettingsWithFormat(model:ModelSettingsModel,apiFormat:ModelSettingsFormat):ModelSettingsModel{
 const supportedEfforts=model.reasoning.supportedEfforts.filter(effort=>apiFormat!=='gemini'||!['xhigh','max'].includes(effort));
 const effort=model.reasoning.effort,valid=effort!==null&&supportedEfforts.includes(effort);
 return {...model,apiFormat,...(!['openai-chat','openai-responses'].includes(apiFormat)&&Object.hasOwn(model,'verbosity')?{verbosity:null}:{}),reasoning:{...model.reasoning,supportedEfforts,...(model.reasoning.mode==='effort'&&!valid?{mode:'default' as const,effort:null}:{})}};
}
export function modelSettingsValidBaseUrl(value:string){
 try{
  value=value.trim();
  if(!/^https?:\/\//i.test(value)||/[\s\p{Cc}]/u.test(value)||value.length>2048)return false;
  const url=new URL(value);if(!url.hostname||url.username||url.password||url.search||url.hash)return false;
  return url.protocol==='https:'||url.protocol==='http:'&&/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(/^http:\/\/([^/]+)/i.exec(value)?.[1]??'');
 }catch{return false;}
}
export const modelSettingsSource=(value:ModelSettingsOverview)=>value.draft??value.active;
export function modelSettingsCredential(model:ModelSettingsModel,native:ModelSettingsNative|null):'configured'|'missing'|'unknown'{
 if(!model.credentialRef)return'missing';if(native?.availability.state!=='available')return'unknown';return native.credentials.some(item=>item.modelRecordId===model.id&&item.reference===model.credentialRef&&item.configured)?'configured':'missing';
}
export function modelSettingsEffective(value:ModelSettingsOverview|null){
 if(!value||value.native?.availability.state!=='available')return'unknown';
 if(value.native.appliedVersionId!==(value.active?.id??null))return'drift';
 if(value.active===null)return'not-configured';
 const n=value.native,version=n.configurationVersion;
 if(!version||n.engines.gateway.modelCount===null||['unknown','unavailable'].includes(n.engines.gateway.state)||['unknown','unavailable'].includes(n.engines.agentos.state))return'unknown';
 if(n.engines.gateway.configurationVersion!==version||n.engines.agentos.configurationVersion!==version||n.engines.gateway.modelCount!==value.active.configuration.models.filter(model=>model.enabled).length)return'drift';
 const expected=modelSettingsDomains.filter(domain=>value.active!.configuration.scenarios[domain]!==null).sort();if(!modelSettingsSame([...n.engines.agentos.configuredScenarios].sort(),expected))return'drift';
 return'applied';
}
export function modelSettingsValidation(configuration:ModelSettingsConfiguration,{applying=false,pendingKeys=[] as string[]}={}):string[]{
 const errors:string[]=[],ids=new Set<string>();
 if(configuration.models.length>50)errors.push('最多保存 50 个模型连接。');
 for(const [index,model] of configuration.models.entries()){
  const name=model.displayName.trim()||'模型 '+(index+1);if(!uuid.test(model.id)||ids.has(model.id))errors.push('模型记录已变化，请重新读取。');ids.add(model.id);
  if(!model.displayName.trim()||model.displayName.trim().length>100)errors.push(name+'：填写 1–100 字显示名称。');
  if(!Object.hasOwn(modelSettingsFormatNames,model.apiFormat))errors.push(name+'：选择受支持的接口格式。');
   if(model.modelId!==null&&(!model.modelId||model.modelId.length>200||/[\s\p{Cc}]/u.test(model.modelId)))errors.push(name+'：API 模型名称需为不含空白或控制字符的 1–200 字标识。');
   if(model.baseUrl!==null&&!modelSettingsValidBaseUrl(model.baseUrl))errors.push(name+'：接口地址需为 HTTPS 或本机回环 HTTP，且不含账号、参数和片段。');
  for(const [field,label,max] of [['contextWindow','上下文窗口',100000000],['maxOutputTokens','最大输出 Token',100000000],['timeoutSeconds','超时时间',1800]] as const){const number=model[field];if(number!==null&&(!Number.isSafeInteger(number)||number<=0||number>max))errors.push(name+'：'+label+'需为 1–'+max+' 的整数。');}
  if(model.contextWindow!==null&&model.maxOutputTokens!==null&&model.maxOutputTokens>=model.contextWindow)errors.push(name+'：最大输出需小于上下文窗口，为输入保留空间。');
  if(model.apiFormat==='openai-responses'&&model.maxOutputTokens!==null&&model.maxOutputTokens<16)errors.push(name+'：Responses 最大输出至少为 16 Token。');
  if(model.contextCompression){const c=model.contextCompression;if(typeof c.enabled!=='boolean'||!Number.isSafeInteger(c.triggerPercent)||c.triggerPercent<50||c.triggerPercent>95||!Number.isSafeInteger(c.recentTokens)||c.recentTokens<256||c.recentTokens>100000000||!Number.isSafeInteger(c.summaryTokens)||c.summaryTokens<128||c.summaryTokens>100000000)errors.push(name+'：检查会话压缩参数范围。');}
  const reasoning=model.reasoning,efforts=reasoning.supportedEfforts;
  if(efforts.some(effort=>!modelSettingsEfforts.includes(effort))||new Set(efforts).size!==efforts.length)errors.push(name+'：支持的思考档位无效。');
  if(reasoning.mode==='effort'&&(!reasoning.effort||!efforts.includes(reasoning.effort)))errors.push(name+'：选择该接口实际支持的思考档位。');
  if(model.apiFormat==='gemini'&&reasoning.mode==='effort'&&['xhigh','max'].includes(reasoning.effort??''))errors.push(name+'：Gemini 当前不支持所选思考档位。');
  const backups=model.fallbacks??[];
  if(backups.length>3||new Set(backups.map(item=>item.modelId)).size!==backups.length)errors.push(name+'：最多选择三个不同的备用模型。');
  for(const backup of backups){
   const target=configuration.models.find(item=>item.id===backup.modelId);
   if(!target||target.id===model.id){errors.push(name+'：备用模型需为其他已有模型。');continue;}
   if(applying&&model.enabled){
    if(!target.enabled)errors.push(name+'：备用模型“'+target.displayName+'”尚未启用。');
    if(!backup.dataPolicyApproved)errors.push(name+'：确认备用模型“'+target.displayName+'”可处理已获准资料。');
    if(model.toolCalling&&!target.toolCalling||model.structuredOutput&&!target.structuredOutput||model.imageUnderstanding&&!target.imageUnderstanding)errors.push(name+'：备用模型“'+target.displayName+'”缺少所需的工具、结构化或图片能力。');
   }
  }
  if(applying&&model.enabled){if([model.modelId,model.baseUrl,model.contextWindow,model.maxOutputTokens,model.timeoutSeconds].some(value=>value===null))errors.push(name+'：启用前补齐模型名称、地址、上下文、输出上限和超时。');if(!model.credentialRef&&!pendingKeys.includes(model.id))errors.push(name+'：启用前配置 API Key。');}
 }
 for(const domain of modelSettingsDomains){const selected=configuration.scenarios[domain];if(!selected)continue;const model=configuration.models.find(item=>item.id===selected.modelId);
  if(!model)errors.push(modelSettingsDomainNames[domain]+'：重新选择已有模型。');else if(applying&&!model.enabled)errors.push(modelSettingsDomainNames[domain]+'：所选模型尚未启用。');
  if(applying&&!selected.dataPolicyApproved)errors.push(modelSettingsDomainNames[domain]+'：确认该服务可处理本领域获准资料。');
 }
 return[...new Set(errors)];
}
function modelSettingsOptional(model:ModelSettingsModel){
 const result:Partial<ModelSettingsModel>={};
 for(const key of ['imageUnderstanding','parallelToolCalls','verbosity','fallbacks','contextCompression'] as const)if(Object.hasOwn(model,key))(result as Record<string,unknown>)[key]=structuredClone(model[key]);
 return result;
}
export function modelSettingsSafeConfiguration(configuration:ModelSettingsConfiguration):ModelSettingsConfiguration{
 return{models:configuration.models.map(model=>({id:model.id,displayName:model.displayName.trim(),modelId:model.modelId?.trim()||null,apiFormat:model.apiFormat,baseUrl:model.baseUrl?.trim()||null,credentialRef:model.credentialRef,contextWindow:model.contextWindow,maxOutputTokens:model.maxOutputTokens,timeoutSeconds:model.timeoutSeconds,reasoning:{mode:model.reasoning.mode,effort:model.reasoning.mode==='effort'?model.reasoning.effort:null,supportedEfforts:[...model.reasoning.supportedEfforts],supportSource:'manual'},toolCalling:model.toolCalling,structuredOutput:model.structuredOutput,...modelSettingsOptional(model),enabled:model.enabled})),scenarios:Object.fromEntries(modelSettingsDomains.map(domain=>[domain,configuration.scenarios[domain]?{modelId:configuration.scenarios[domain]!.modelId,dataPolicyApproved:configuration.scenarios[domain]!.dataPolicyApproved}:null])) as ModelSettingsConfiguration['scenarios']};
}
export type ModelSettingsConflict={path:string;label:string;mine:unknown;current:unknown};
const fields=['displayName','modelId','apiFormat','baseUrl','credentialRef','contextWindow','maxOutputTokens','timeoutSeconds','reasoning','toolCalling','structuredOutput','imageUnderstanding','parallelToolCalls','verbosity','fallbacks','contextCompression','enabled'] as const;
const fieldNames:Record<string,string>={displayName:'显示名称',modelId:'API 模型名称',apiFormat:'接口格式',baseUrl:'接口地址',credentialRef:'凭据',contextWindow:'上下文窗口',maxOutputTokens:'最大输出',timeoutSeconds:'超时',reasoning:'思考设置',toolCalling:'工具调用',structuredOutput:'结构化输出',imageUnderstanding:'图片识别',parallelToolCalls:'并行工具调用',verbosity:'回答详略',fallbacks:'备用模型',contextCompression:'会话压缩',enabled:'启用状态'};
export function modelSettingsMerge(base:ModelSettingsConfiguration,mine:ModelSettingsConfiguration,current:ModelSettingsConfiguration,choices:Record<string,'mine'|'current'>={},pendingCredentialIds:readonly string[]=[]){
 const conflicts:ModelSettingsConflict[]=[],pendingCredentials=new Set(pendingCredentialIds),retainedCredentials=new Set<string>();let unresolved=0;
 const knownReferences=[...base.models,...mine.models,...current.models].every(model=>model.credentialRef===null||typeof model.credentialRef==='string'&&/^model-key:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(model.credentialRef));
 if(!knownReferences)return{configuration:null,conflicts,unresolved,discardCredentialIds:[] as string[]};
 function pick(path:string,label:string,before:unknown,local:unknown,remote:unknown,localIntent=false){if(!localIntent&&modelSettingsSame(local,before))return remote;if(modelSettingsSame(remote,before)||modelSettingsSame(local,remote))return local;conflicts.push({path,label,mine:local,current:remote});if(choices[path]!=='mine'&&choices[path]!=='current')unresolved++;return choices[path]==='mine'?local:remote;}
 const connectionFields=new Set<keyof ModelSettingsModel>(['modelId','apiFormat','baseUrl','credentialRef']);
 const connection=(model:ModelSettingsModel,pendingCredential=false)=>({modelId:model.modelId,apiFormat:model.apiFormat,baseUrl:model.baseUrl,credentialRef:model.credentialRef,pendingCredential});
 const ids=[...new Set([...current.models,...mine.models].map(model=>model.id))],models:ModelSettingsModel[]=[];
 for(const id of ids){const before=base.models.find(model=>model.id===id),local=mine.models.find(model=>model.id===id),remote=current.models.find(model=>model.id===id);
  if(!before||!local||!remote){const item=pick('models.'+id,local?.displayName||remote?.displayName||'模型记录',before,local,remote,pendingCredentials.has(id));if(item){models.push(structuredClone(item) as ModelSettingsModel);if(pendingCredentials.has(id)&&modelSettingsSame(item,local))retainedCredentials.add(id);}continue;}
  const {pendingCredential,...binding}=pick('models.'+id+'.connection',local.displayName+' · 连接设置',connection(before),connection(local,pendingCredentials.has(id)),connection(remote)) as ReturnType<typeof connection>;
  if(pendingCredential)retainedCredentials.add(id);
  const model={id,...binding} as ModelSettingsModel;for(const field of fields)if(!connectionFields.has(field))(model as unknown as Record<string,unknown>)[field]=structuredClone(pick('models.'+id+'.'+field,local.displayName+' · '+fieldNames[field],before[field],local[field],remote[field]));models.push(model);
 }
 const scenarios=Object.fromEntries(modelSettingsDomains.map(domain=>[domain,pick('scenarios.'+domain,modelSettingsDomainNames[domain],base.scenarios[domain],mine.scenarios[domain],current.scenarios[domain])])) as ModelSettingsConfiguration['scenarios'];
 return{configuration:{models,scenarios},conflicts,unresolved,discardCredentialIds:pendingCredentialIds.filter(id=>!retainedCredentials.has(id))};
}
export function modelSettingsConflictValue(value:unknown,path:string){if(path.endsWith('.credentialRef'))return value?'已配置凭据':'未配置';if(value===null||value===undefined)return'未设置';if(typeof value==='boolean')return value?'启用':'停用';if(typeof value==='number'||typeof value==='string')return String(value);if(typeof value==='object'&&('apiFormat' in value||'modelId' in value)){const model=value as Partial<ModelSettingsModel>&{pendingCredential?:boolean};return[model.displayName,model.apiFormat?modelSettingsFormatNames[model.apiFormat]:null,model.modelId||'模型名称未设置',model.baseUrl||'接口地址未设置',model.pendingCredential?'待保存的新凭据':model.credentialRef?'已保存凭据':'未配置凭据'].filter(Boolean).join(' · ');}return'设置已变化';}
export const modelSettingsPhaseNames:Record<ModelSettingsPhase,string>={prepared:'已保存操作',submitting:'正在提交',pending:'处理中',applied:'已完成',failed:'未完成','result-unknown':'结果待确认'};
export function modelSettingsProgressLabel(kind:ModelSettingsOperation['kind']){return kind==='credential-provision'?'正在保存模型连接':kind==='draft'?'正在保存草稿':'正在应用配置';}
export function modelSettingsOperationLabel(operation:ModelSettingsOperation){if(operation.phase==='applied')return operation.kind==='draft'?'草稿已保存':operation.kind==='credential-provision'?'凭据已配置':'配置已生效';const target=operation.kind==='draft'?'草稿':operation.kind==='credential-provision'?'模型连接':'配置';if(operation.phase==='failed')return target+(operation.kind==='apply'?'未能应用':'未能保存');if(operation.phase==='result-unknown')return target+'状态待更新';return modelSettingsProgressLabel(operation.kind);}
export function modelSettingsOperator(item:{operatorDisplayName?:string|null}){return typeof item.operatorDisplayName==='string'&&item.operatorDisplayName.trim()?item.operatorDisplayName.trim():'管理账户';}
export function modelSettingsCount(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value.toLocaleString('zh-CN'):'未取得';}
export function modelSettingsTime(value:unknown){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return'未记录';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));}
export const modelSettingsErrors:Record<string,string>={model_settings_revision_changed:'配置已有更新，你的修改已保留。',model_settings_draft_changed:'草稿已变化，请与当前版本合并后继续。',model_settings_operation_pending:'已有配置正在应用，完成后会自动更新。',model_settings_operation_conflict:'这次保存内容已有变化，请刷新后重试。',model_settings_native_drift:'两端配置与当前记录不一致，暂不能应用。',model_settings_native_readback_mismatch:'配置正在同步，完成后会自动更新。',model_settings_model_incomplete:'启用模型前请补齐连接与参数。',model_settings_fallback_unavailable:'备用模型尚不可用，请检查记录和启用状态。',model_settings_fallback_data_policy_unapproved:'请确认备用模型的资料处理范围。',model_settings_fallback_capability_incompatible:'备用模型的能力不足以接续当前模型，请检查工具、结构化和图片能力。',model_settings_credential_unavailable:'凭据尚未确认，请重新读取凭据状态。',model_settings_binding_unavailable:'场景所选模型尚不可用。',model_settings_data_policy_unapproved:'场景资料范围尚未确认。',model_settings_native_not_configured:'配置服务尚未接通，草稿仍可保存。',model_settings_native_unavailable:'配置服务暂时不可用，稍后可继续确认。',model_settings_permission_denied:'当前已无配置权限，操作已停止。',model_settings_authorization_unavailable:'配置授权服务暂时不可用，尚未应用。',invalid_model_settings_request:'请检查连接和参数后继续。'};
export function modelSettingsHistoryLines(item:ModelSettingsHistoryItem){
 const lines:string[]=[];for(const model of item.changes?.models??[]){const names=model.fields.map(field=>fieldNames[field.field]).filter(Boolean);if(names.length)lines.push((model.kind==='added'?'新增模型':model.kind==='removed'?'移除模型':'修改模型')+'：'+names.join('、'));}
 for(const scenario of item.changes?.scenarios??[]){const name=modelSettingsDomainNames[scenario.domain];if(name)lines.push(name+'：'+(scenario.after?'更新模型分配':'取消模型分配'));}
 return lines;
}
