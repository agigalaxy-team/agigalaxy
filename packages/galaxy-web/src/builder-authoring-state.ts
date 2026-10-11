import * as z from 'zod/v4';
import type {createWebRuntime} from './runtime.mjs';
import {builderDeclarationSchema,builderEventSchema} from '../../galaxy-official/src/shared/builders-schema.mjs';
import {builderExtensionEventSchema,builderSupportProfileSchema,workerPackManifestSchema} from '../../galaxy-official/src/shared/builder-support-v2-schema.mjs';

export type BuilderDeclaration=z.infer<typeof builderDeclarationSchema>;
export type BuilderSupport=z.infer<typeof builderSupportProfileSchema>;
export type WorkerPack=z.infer<typeof workerPackManifestSchema>;
export type BuilderExtensionEvent=z.infer<typeof builderExtensionEventSchema>;
export type BuilderReport=Extract<BuilderExtensionEvent,{kind:'scope-report'}>;
export type BuilderEvent=z.infer<typeof builderEventSchema>|BuilderExtensionEvent;
export type BuilderType=BuilderDeclaration['type'];
export type BuilderMaintenance=Extract<BuilderEvent,{kind:'maintenance'}>;

// Editing permits empty fields and unset dates. Only the existing business
// schemas validate a completed event; restoring a draft grants no permission.
const text=z.string(),strings=z.array(text),version=z.object({name:text,version:text});
const release=z.object({version:text,buildHash:text,sourceCommit:text,artifact:text,
  dependencies:z.array(z.object({name:text,version:text,sha256:text})),upgrade:text,rollback:text});
const common={name:text,scope:text,policy:text,contact:text,release,redactionConfirmed:z.literal(true),proofIds:strings};
export const declarationDraftSchema=z.discriminatedUnion('type',[
  z.object({...common,type:z.literal('worker'),nodeId:text,
    configuration:z.object({id:text,summary:text,modelFamily:text,tools:strings,taskTypes:strings,maxConcurrentTasks:z.union([z.number(),z.literal('')])}),
    capabilities:z.array(z.object({id:text,claim:text,limitations:text})),
    a2a:z.object({protocol:z.literal('a2a/1.0'),transport:z.literal('JSONRPC'),endpoint:text,cardUrl:text,tenant:text}).optional()}),
  z.object({...common,type:z.literal('bridge'),mapping:z.object({sourceSystem:text,sourceObjects:strings,targetObjects:strings,
    rules:text,strengthCeiling:z.enum(['source-assertion','execution-observation']),authorization:text,version:text,deduplication:text,revocation:text,provenance:text})}),
  z.object({...common,type:z.literal('hub'),operator:text,charter:text,region:text,endpoint:text,
    manifest:z.object({url:text,sha256:text,specVersion:text}),exit:text,export:text}),
]);
const supportMappingSchema=z.object({version:text,sourceSystem:text,sourceObjects:strings,
  fields:z.array(z.object({source:text,target:text,meaning:z.enum(['source-fact','source-claim','derived','unknown']),rule:text})),
  strengthCeiling:z.enum(['source-assertion','execution-observation']),sourceIdentity:text,deduplication:text,
  observationTime:text,authorization:text,revocation:text,excludedData:text});
export const supportDraftSchema=z.object({profile:z.literal('galaxy-builder-support/2'),implementation:version,galaxySchema:text,
  protocols:z.array(version),sdks:z.array(version),objectActions:strings,missingCapabilities:strings,
  authorization:text,limitations:text,mapping:supportMappingSchema.optional()});
export const packDraftSchema=z.object({profile:z.literal('galaxy-worker-pack/1'),name:text,version:text,source:text,sha256:text,license:text,licenseSource:text,
  dependencies:z.array(z.object({kind:z.enum(['skill','mcp','tool','runtime','model-interface']),name:text,version:text,source:text,license:text,sha256:text.optional()})),
  modelRequirements:text,environment:text,permissions:z.array(z.object({resource:text,purpose:text,required:z.boolean()})),
  configurationRequirements:text,capabilities:strings,changes:text,installation:text,upgrade:text,rollback:text,
  runtimeLocation:z.literal('user-controlled'),automaticActivation:z.literal(false)});
const reportCheckSchema=z.object({action:text,status:z.enum(['pass','fail','not-tested']),detail:text});
export const reportDraftSchema=z.object({profile:z.literal('galaxy-builder-scope-report/1'),suite:z.object({name:text,version:text,sha256:text,source:text}),
  run:z.object({id:text,sourceHash:text,reportHash:text,runnerVersion:text,environment:text,testClass:z.enum(['format','source-flow','independent-interop','host-experience']),peer:version.optional()}),
  checks:z.array(reportCheckSchema),observedAt:z.number().int().nonnegative().nullable(),expiresAt:z.number().int().nonnegative().nullable(),limitations:text});
const maintenanceDraftSchema=z.object({action:z.enum(['delist','relist','correction','security-issue','resolve-security']),summary:text});
export const builderFormSchemas={declare:declarationDraftSchema,'support-profile':supportDraftSchema,'pack-manifest':packDraftSchema,'scope-report':reportDraftSchema,maintenance:maintenanceDraftSchema};
export type BuilderFormKind=keyof typeof builderFormSchemas;
export type BuilderForms={[K in BuilderFormKind]:z.infer<(typeof builderFormSchemas)[K]>};
export type BuilderContent=BuilderForms[BuilderFormKind];
export type BuilderDeclarationDraft=BuilderForms['declare'];
export const isBuilderFormKind=(value:string):value is BuilderFormKind=>Object.hasOwn(builderFormSchemas,value);
const baseSchema=z.object({baseDeclarationId:text.nullable(),baseSupportId:text.nullable(),basePackId:text.nullable()});
const formKinds=z.enum(['declare','support-profile','pack-manifest','scope-report','maintenance']);
export const builderInputSchema=baseSchema.extend({kind:text,
  forms:z.object({declare:declarationDraftSchema.optional(),'support-profile':supportDraftSchema.optional(),'pack-manifest':packDraftSchema.optional(),'scope-report':reportDraftSchema.optional(),maintenance:maintenanceDraftSchema.optional()}),
  visibility:z.enum(['Private','Public']),viewers:strings,bases:z.partialRecord(formKinds,baseSchema),unmatchedChecks:z.array(reportCheckSchema),
  declarationVariants:z.partialRecord(z.enum(['worker','bridge','hub']),declarationDraftSchema)});
export type BuilderInput=z.infer<typeof builderInputSchema>;
export type BuilderInputPatch=Partial<BuilderInput>;
export type BuilderDisclosure={visibility:'Private'|'Public';viewers:string[]};
export type BuilderEntry={builderId:string;ownerId:string;type:BuilderType;revision:number;declarationId:string|null;declarationHash:string|null;declaration?:BuilderDeclaration|null;disclosure?:BuilderDisclosure;allowedActions?:string[]};
export type BuilderExtensions={canSubmitReport:boolean;support:{eventId?:string;payloadHash?:string;record:BuilderSupport|null};pack:{eventId?:string;record:WorkerPack|null};disclosure?:BuilderDisclosure|null;reportDisclosure?:BuilderDisclosure|null};
export type BuilderRead={entry:BuilderEntry;extensions:BuilderExtensions};
export const builderLocatorSchema=z.object({endpoint:text,ownerId:text,builderId:z.uuid(),eventId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),kind:text.optional()});
export type BuilderLocator=z.infer<typeof builderLocatorSchema>;
export type BuilderReceipt={state:'acknowledged';builderId:string;locator:BuilderLocator}|{state:'absent'|'unknown'|'unconfirmed';reason?:string};
export type BuilderPreview={event:BuilderEvent;visibility:'Private'|'Public';viewers:string[];draftRevision:string|null};
export type BuilderLease={endpoint:string;subjectId:string;assertCurrent:()=>void};
export type BuilderRuntime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'receiptStatus'|'getLocal'|'updateLocal'|'status'>;
export type BuilderClient={read:(id:string,authenticated:boolean)=>Promise<BuilderRead>;manage:(id:string)=>Promise<BuilderEntry>;
  receiptFor:(locator:BuilderLocator)=>Promise<BuilderReceipt>;
  submit:(event:BuilderEvent,options:{visibility:'Private'|'Public';viewers:string[];confirmed:true;onJournal:(locator:BuilderLocator)=>Promise<void>})=>Promise<Extract<BuilderReceipt,{state:'acknowledged'}>>};
export const builderContactsSchema=z.object({items:z.array(z.object({initiatorId:text,recipientId:text})),nextAfter:text.nullable().optional()});

export function newBuilderDeclaration(type:string='worker'):BuilderDeclarationDraft {
  const fields={name:'',scope:'',policy:'',contact:'',release:{version:'',buildHash:'',sourceCommit:'',artifact:'',dependencies:[],upgrade:'',rollback:''},redactionConfirmed:true as const,proofIds:[]};
  if(type==='bridge')return{...fields,type,mapping:{sourceSystem:'',sourceObjects:[''],targetObjects:[''],rules:'',strengthCeiling:'source-assertion',authorization:'',version:'',deduplication:'',revocation:'',provenance:''}};
  if(type==='hub')return{...fields,type,operator:'',charter:'',region:'',endpoint:'',manifest:{url:'',sha256:'',specVersion:''},exit:'',export:''};
  return{...fields,type:'worker',nodeId:'',configuration:{id:crypto.randomUUID(),summary:'',modelFamily:'',tools:[],taskTypes:[''],maxConcurrentTasks:1},capabilities:[{id:crypto.randomUUID(),claim:'',limitations:''}]};
}
export function newSupportMapping():z.infer<typeof supportMappingSchema>{return{version:'',sourceSystem:'',sourceObjects:[''],fields:[{source:'',target:'',meaning:'source-fact',rule:''}],strengthCeiling:'source-assertion',sourceIdentity:'',deduplication:'',observationTime:'',authorization:'',revocation:'',excludedData:''};}
export function initialBuilderForms(selected:BuilderRead|null):BuilderForms {
  const d=selected?.entry.declaration,ext=selected?.extensions;
  return{declare:d?structuredClone(d):newBuilderDeclaration(),
    'support-profile':ext?.support.record?structuredClone(ext.support.record):{profile:'galaxy-builder-support/2',implementation:{name:d?.name??'',version:d?.release.version??''},galaxySchema:'',protocols:[],sdks:[],objectActions:[],missingCapabilities:[],authorization:'',limitations:''},
    'pack-manifest':ext?.pack.record?structuredClone(ext.pack.record):{profile:'galaxy-worker-pack/1',name:d?.name??'',version:d?.release.version??'',source:'',sha256:'',license:'',licenseSource:'',dependencies:[],modelRequirements:'',environment:'',permissions:[],configurationRequirements:'',capabilities:[''],changes:'',installation:'',upgrade:'',rollback:'',runtimeLocation:'user-controlled',automaticActivation:false},
    'scope-report':{profile:'galaxy-builder-scope-report/1',suite:{name:'',version:'',sha256:'',source:''},run:{id:'',sourceHash:'',reportHash:'',runnerVersion:'',environment:'',testClass:'source-flow'},checks:(ext?.support.record?.objectActions??[]).map(action=>({action,status:'not-tested',detail:''})),observedAt:null,expiresAt:null,limitations:''},maintenance:{action:'correction',summary:''}};
}
export function initialBuilderInput(selected:BuilderRead|null,management:BuilderEntry|null,subjectId:string,kind:string):BuilderInput {
  const all=initialBuilderForms(selected),entry=selected?.entry??management,extensions=selected?.extensions;
  if(!selected&&management)all.declare=newBuilderDeclaration(management.type);
  const forms=selected&&selected.entry.ownerId!==subjectId?{'scope-report':all['scope-report']}:all;
  const base={baseDeclarationId:entry?.declarationId??null,baseSupportId:extensions?.support.eventId??null,basePackId:extensions?.pack.eventId??null};
  return{kind,forms,visibility:extensions?.disclosure?.visibility??management?.disclosure?.visibility??'Private',viewers:extensions?.disclosure?.viewers??management?.disclosure?.viewers??[],...base,bases:Object.fromEntries(Object.keys(forms).map(k=>[k,base])),unmatchedChecks:[],declarationVariants:{}};
}
export function builderBaseChanged(input:BuilderInput,current:BuilderRead|null,entry:BuilderEntry|null):boolean {
  if(!entry?.builderId)return false;
  const base=isBuilderFormKind(input.kind)?input.bases[input.kind]??input:input;
  return base.baseDeclarationId!==(current?.entry.declarationId??entry.declarationId??null)
    ||(['support-profile','scope-report'].includes(input.kind)&&base.baseSupportId!==(current?.extensions.support.eventId??null))
    ||(input.kind==='pack-manifest'&&base.basePackId!==(current?.extensions.pack.eventId??null));
}
export function copyDeclarationCommon<T extends BuilderDeclarationDraft>(target:T,source:BuilderDeclarationDraft):T {
  return{...target,name:source.name,scope:source.scope,policy:source.policy,contact:source.contact,release:structuredClone(source.release),proofIds:[...source.proofIds]};
}
export function builderContentPatch(input:BuilderInput,next:unknown):BuilderInputPatch {
  switch(input.kind){
    case'declare':{const declaration=declarationDraftSchema.parse(next),previous=input.forms.declare;
      const variants=previous&&previous.type!==declaration.type?{...input.declarationVariants,[previous.type]:previous}:input.declarationVariants;
      const restored=previous?.type!==declaration.type?variants[declaration.type]:null;
      return{declarationVariants:variants,forms:{...input.forms,declare:restored?copyDeclarationCommon(restored,declaration):declaration}};}
    case'support-profile':return{forms:{...input.forms,'support-profile':supportDraftSchema.parse(next)}};
    case'pack-manifest':return{forms:{...input.forms,'pack-manifest':packDraftSchema.parse(next)}};
    case'scope-report':return{forms:{...input.forms,'scope-report':reportDraftSchema.parse(next)}};
    case'maintenance':return{forms:{...input.forms,maintenance:maintenanceDraftSchema.parse(next)}};
    default:throw Error('请选择当前可用的资料。');
  }
}
export function builderCurrentSourcePatch(input:BuilderInput,entry:BuilderEntry,extensions?:BuilderExtensions):BuilderInputPatch {
  if(!isBuilderFormKind(input.kind))throw Error('请选择当前可用的资料。');
  const patch:BuilderInputPatch={bases:{...input.bases,[input.kind]:{baseDeclarationId:entry.declarationId,baseSupportId:extensions?.support.eventId??null,basePackId:extensions?.pack.eventId??null}}};
  if(input.kind==='scope-report'&&input.forms['scope-report']){
    const content=input.forms['scope-report'],actions=extensions?.support.record?.objectActions??[],old=content.checks;
    patch.forms={...input.forms,'scope-report':{...content,checks:actions.map(action=>old.find(c=>c.action===action)??{action,status:'not-tested',detail:''})}};
    patch.unmatchedChecks=[...input.unmatchedChecks,...old.filter(c=>!actions.includes(c.action))];
  }
  return patch;
}

export function builderField(value:unknown,path:string):unknown {
  let at:unknown=value;for(const key of path.split('.')){if(typeof at!=='object'||at===null)return undefined;at=Reflect.get(at,key);}return at;
}
export function replaceBuilderField<T extends object>(value:T,path:string,next:unknown):T {
  const copy=structuredClone(value),keys=path.split('.');let at:object=copy;
  for(const key of keys.slice(0,-1)){let child:unknown=Reflect.get(at,key);if(!child){child={};Reflect.set(at,key,child);}if(typeof child!=='object'||child===null)throw Error('这项资料的格式暂时无法编辑。');at=child;}
  Reflect.set(at,keys[keys.length-1],next);return copy;
}
export function builderRows(value:unknown):object[]{if(value===undefined||value===null)return[];if(!Array.isArray(value)||!value.every(row=>typeof row==='object'&&row!==null))throw Error('这项资料的格式暂时无法编辑。');return value;}
export function builderLines(value:unknown):string[]{if(value===undefined||value===null)return[];return z.array(z.string()).parse(value);}
export function builderDateValue(value:unknown):string {
  if(value===null||value===undefined)return'';
  if(typeof value!=='number'||!Number.isFinite(value))return'';
  const date=new Date(value*1000);if(!Number.isFinite(date.getTime()))return'';
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);
}
export function builderDateSeconds(input:string):number|null|undefined {if(!input)return null;const next=Math.floor(new Date(input).getTime()/1000);return Number.isFinite(next)?next:undefined;}

export function normalizedBuilderContent(kind:BuilderFormKind,value:unknown):BuilderContent {
  const trimmed=(items:string[])=>items.map(s=>s.trim()).filter(Boolean);
  switch(kind){
    case'declare':{const v=declarationDraftSchema.parse(value);v.proofIds=trimmed(v.proofIds);if(v.type==='worker'){v.configuration.tools=trimmed(v.configuration.tools);v.configuration.taskTypes=trimmed(v.configuration.taskTypes);}if(v.type==='bridge'){v.mapping.sourceObjects=trimmed(v.mapping.sourceObjects);v.mapping.targetObjects=trimmed(v.mapping.targetObjects);}return v;}
    case'support-profile':{const v=supportDraftSchema.parse(value);if(v.mapping)v.mapping.sourceObjects=trimmed(v.mapping.sourceObjects);return v;}
    case'pack-manifest':{const v=packDraftSchema.parse(value);v.capabilities=trimmed(v.capabilities);for(const dependency of v.dependencies)if(dependency.sha256==='')delete dependency.sha256;return v;}
    case'scope-report':return reportDraftSchema.parse(value);
    case'maintenance':return maintenanceDraftSchema.parse(value);
  }
}
export function prepareBuilderPreview(input:BuilderInput,draftRevision:string|null,current:BuilderEntry|null,extensions?:BuilderExtensions,builderId?:string):BuilderPreview {
  if(!isBuilderFormKind(input.kind))throw Error('请选择当前可用的资料。');
  const kind=input.kind,body=normalizedBuilderContent(kind,input.forms[kind]);
  if(kind!=='declare'&&!current)throw Error('先打开需要更新的项目。');
  if(kind==='pack-manifest'&&current?.type!=='worker')throw Error('Pack 版本仅适用于 Agent / Worker 项目。原输入仍保存在本机。');
  if(kind==='scope-report'&&!extensions?.canSubmitReport)throw Error('当前身份没有提交这份范围报告的权限。');
  const base={id:crypto.randomUUID(),builderId:builderId??crypto.randomUUID(),expectedRevision:current?.revision??0};
  let event:BuilderEvent;
  if(kind==='declare'){
    const declaration=builderDeclarationSchema.parse(body);if(current&&declaration.type!==current.type)throw Error('同一项目需要沿用原类型。不同类型请回到目录另行登记。');
    event=builderEventSchema.parse({...base,kind,declaration});
  }else if(kind==='maintenance'){
    const maintenance=maintenanceDraftSchema.parse(body);if(current?.allowedActions&&!current.allowedActions.includes(maintenance.action))throw Error('当前资料状态不支持这项维护操作，请选择当前可用的事项。');
    event=builderEventSchema.parse({...base,kind,declarationId:current?.declarationId,...maintenance});
  }else{
    const reference={...base,kind,declarationId:current?.declarationId,declarationHash:current?.declarationHash};
    event=builderExtensionEventSchema.parse({...reference,...(kind==='support-profile'?{support:body}:kind==='pack-manifest'?{manifest:body}:{...body,supportId:extensions?.support.eventId,supportHash:extensions?.support.payloadHash})});
  }
  if(event.kind==='scope-report'&&event.expiresAt<=event.observedAt)throw Error('报告适用截止时间应晚于实际观察时间。');
  const disclosure=kind==='scope-report'?extensions?.reportDisclosure:kind==='declare'?null:extensions?.disclosure??current?.disclosure;
  const visibility=disclosure?.visibility??input.visibility,viewers=visibility==='Public'?[]:[...new Set(disclosure?.viewers??input.viewers)];
  if(viewers.length>16)throw Error('这份资料最多可指定 16 位查看者，请调整可见范围。');
  return{event,visibility,viewers,draftRevision};
}

export function builderContentFromImport(kind:string,value:unknown,entry?:BuilderEntry|null,extensions?:BuilderExtensions):BuilderContent {
  const source=builderField(value,'event')??value;
  if(kind==='declare')return builderDeclarationSchema.parse(builderField(source,'declaration')??source);
  if(kind==='support-profile')return builderSupportProfileSchema.parse(builderField(source,'support')??source);
  if(kind==='pack-manifest')return workerPackManifestSchema.parse(builderField(source,'manifest')??source);
  if(kind==='maintenance'){const parsed=maintenanceDraftSchema.safeParse(source);if(!parsed.success||!parsed.data.summary.trim()||parsed.data.summary.length>2000)throw Error('维护公告需包含有效事项与完整说明。');return parsed.data;}
  const event=builderExtensionEventSchema.parse({id:crypto.randomUUID(),kind:'scope-report',builderId:entry?.builderId,expectedRevision:entry?.revision,declarationId:entry?.declarationId,declarationHash:entry?.declarationHash,supportId:extensions?.support.eventId,supportHash:extensions?.support.payloadHash,
    profile:builderField(source,'profile'),suite:builderField(source,'suite'),run:builderField(source,'run'),checks:builderField(source,'checks'),observedAt:builderField(source,'observedAt'),expiresAt:builderField(source,'expiresAt'),limitations:builderField(source,'limitations')});
  if(event.kind!=='scope-report')throw Error('这份文件不是范围实测报告。');
  const{profile,suite,run,checks,observedAt,expiresAt,limitations}=event;return{profile,suite,run,checks,observedAt,expiresAt,limitations};
}
