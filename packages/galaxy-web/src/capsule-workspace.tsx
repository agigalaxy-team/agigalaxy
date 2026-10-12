import {HistoryFields} from './history-facts';
import {ContentCard,browseReturnPath,browseReturnLabel} from './public-browse-workspace';
import {ArrowRight,BookOpen,X} from 'lucide-react';
import {MemberAvatar,memberName,useMemberNames,readableTime} from './conversation-ui';
import {CapsuleOperationStatus} from './capsule-operation-status';
import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {createCapsuleWebClient,capsuleDeviceHasScope} from './capsule-workspace-client.mjs';
import {CapsuleAuthoring,CapsulePermissionWorkspace} from './capsule-authoring';
import {capsuleInputDraftKey,settleCapsuleInput} from './capsule-authoring-state';
import {CapsuleAuthorPreview} from './capsule-author-preview';
import {CapsuleApplication} from './capsule-application';
import {CapsuleConsentControls} from './capsule-consent-controls';
import {CapsuleAttributionResponses} from './capsule-attribution-responses';
import {SaveForLaterButton} from './reading-bookmarks-workspace';
import {directoryReadingState,rememberDirectoryReading,restoreDirectoryReading} from './directory-reading-state.mjs';
import {helpOriginLocator} from './help-origin-client.mjs';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {capsuleEventV2Schema,capsulePermissionV2Schema,capsuleUseV2Schema} from '../../galaxy-official/src/shared/capsule-v2-schema.mjs';
import type {CapsuleAuthorMode,CapsuleCaseHistory,CapsuleDetail,CapsuleDirectoryItem,CapsuleDisclosure,CapsuleOperationKind,CapsuleOriginWork,CapsulePermissionView,CapsulePreview,CapsulePreviewContext,CapsulePreviewDisplay,CapsuleReceipt,CapsuleRegisterDraft,CapsuleUses,CapsuleUseView,CapsuleVersionItem,CapsuleVersions,CapsuleWorkspaceClient,CapsuleWorkspaceRuntime} from './capsule-authoring-types';

const labels:Record<string,string>={
  current:'来源当前可用','source-unavailable':'来源目前不可用','source-result-superseded':'来源结果已有纠正版本',
  'source-currentness-unavailable':'来源结果的当前支持状态未知','application-result-superseded':'应用结果已有纠正版本',
  'application-currentness-unavailable':'应用结果的当前支持状态未知','capsule-source-unavailable':'方法来源不可用',
  'application-source-unavailable':'应用来源不可用','prior-application-unavailable':'先前应用已不可用',
  'legacy-v1-source-policy':'历史版本的作者声明来源规则',reference:'加入参考',apply:'实际应用',reverify:'再次验证',
  succeeded:'报告达到目标',partial:'部分达到',failed:'未达到',inconclusive:'尚无定论',conflicting:'结论冲突',
  deprecate:'已停用','security-issue':'安全事项','resolve-security':'安全事项已处理',
};
const errors:Record<string,string>={
  consent_required:'这份内容当前没有可用的展示许可，正文已收起。',
  capsule_source_permission_required:'某些实际来源还缺原作者许可。请在许可区取得对应授权，或去掉未获准的选定材料。',
  configuration_content_unavailable:'所选配置内容已撤回或目前不可读。可保留草稿，重新核对选定来源与许可。',
  capsule_resolution_required:'正式版本需要实际报告达到目标的来源结果。失败或不明确的记录可以继续完善，不能改写成成功。',
  capsule_unavailable:'这份方法的所选版本当前不可读取。',
  capsule_not_applicable:'当前版本的状态或来源支持条件不允许新增应用，请重新核对。',
  capsule_new_case_required:'实际应用应来自另一件真实工作，不把源案例自己算作复用。',
  capsule_use_already_recorded:'这一条精确应用或再验证已经记录，请刷新查看。',
  consent_reauthorization_required:'原授权已失效。先查询原操作；当前界面保留原记录，不自动换一个授权重复发布。',
};
export const capsuleLabel=(value:string)=>labels[value]??value;
export function capsuleError(error:unknown){
  const value=error&&typeof error==='object'?error:null;
  const code=value&&'code' in value&&typeof value.code==='string'?value.code:'';
  const message=value&&'message' in value&&typeof value.message==='string'?value.message:'';
  return (errors[code||message]??message)||'操作未完成。';
}
export const exactCapsulePath=(id:string,versionId?:string)=>'/app/capsules/'+id+(versionId?'/versions/'+versionId:'');

type WorkspaceProps={runtime:CapsuleWorkspaceRuntime|null;subjectId?:string;connected:boolean;navigate:(path:string)=>void;capsuleId?:string;versionId?:string};
type Mode='browse'|'permissions'|CapsuleAuthorMode;
type PermissionView='owned'|'granted';
type PreviewSelection={original:CapsulePreview;display:CapsulePreviewDisplay};
function requestedMode(writable:boolean,capsuleId?:string):Mode{
  const mode=new URLSearchParams(location.search).get('mode');
  if(writable&&(mode==='author'||mode==='permissions'||!!capsuleId&&(mode==='revision'||mode==='maintenance')))return mode;
  return 'browse';
}
function isCapsulePreview(value:unknown):value is CapsulePreview{
  if(!value||typeof value!=='object'||!('type' in value)||!('payload' in value)
    ||!('operationId' in value)||typeof value.operationId!=='string'||!('payloadHash' in value)||typeof value.payloadHash!=='string'
    ||!('endpoint' in value)||typeof value.endpoint!=='string'||!('subjectId' in value)||typeof value.subjectId!=='string'
    ||!('visibility' in value)||(value.visibility!=='Private'&&value.visibility!=='Public')
    ||!('viewers' in value)||!Array.isArray(value.viewers)||!value.viewers.every(id=>typeof id==='string'))return false;
  return value.type==='publication'?capsuleEventV2Schema.safeParse(value.payload).success:
    value.type==='permission'?capsulePermissionV2Schema.safeParse(value.payload).success:
    value.type==='use'&&capsuleUseV2Schema.safeParse(value.payload).success;
}
function readCapsuleUseRecord(client:CapsuleWorkspaceClient,input:Parameters<CapsuleWorkspaceClient['useRecord']>[0]){
  return client.useRecord(input);
}
function capsuleDirectoryScope(endpoint:string|undefined,subjectId:string|undefined,bindingId:string|undefined){
  const params=new URLSearchParams(location.search);
  return JSON.stringify(['capsules',endpoint,subjectId,bindingId,params.get('q')??'',params.get('view')==='mine']);
}
export function CapsuleWorkspace(props:WorkspaceProps){
  const view=useChoiceViewLease(props.runtime,props.subjectId),[navigationVersion,setNavigationVersion]=useState(0);
  useEffect(()=>{const changed=()=>setNavigationVersion(value=>value+1);addEventListener('popstate',changed);return()=>removeEventListener('popstate',changed);},[]);
  const connectionKey=JSON.stringify([props.runtime?.api.endpoint,props.subjectId,props.connected,view.key,props.capsuleId,props.versionId,navigationVersion,!props.capsuleId?location.search:'']);
  return <CapsuleWorkspaceSession key={connectionKey} {...props} connected={props.connected&&!!view.lease} lease={view.lease} connectionKey={connectionKey}/>;
}
function CapsuleWorkspaceSession({runtime,subjectId,connected,navigate,capsuleId,versionId,lease,connectionKey}:WorkspaceProps&{lease:ChoiceViewLease|null;connectionKey:string}){
  const originPath=location.pathname+location.search+location.hash,helpOrigin=useMemo(()=>helpOriginLocator(originPath),[originPath]);
  const client:CapsuleWorkspaceClient|null=useMemo(()=>{
    if(!runtime)return null;
    const value=createCapsuleWebClient({api:runtime.api,getLocal:runtime.getLocal,putLocal:runtime.putLocal,updateLocal:runtime.updateLocal,subjectId:connected&&lease?subjectId??null:null});
    return{...value,async prepare(type:CapsuleOperationKind,payload:unknown,scope:CapsuleDisclosure){
      const preview=await value.prepare(type,payload,scope);
      if(!isCapsulePreview(preview))throw Error('预览的操作类别或内容不一致，请重新核对。');
      // Keep the exact original object registered in the client's WeakMap.
      return preview;
    },execute(preview:CapsulePreview,options:Parameters<CapsuleWorkspaceClient['execute']>[1]){
      const journal=options.onJournal;
      return value.execute(preview,{confirmed:options.confirmed,...(journal?{onJournal:async locator=>{await journal(locator);}}:{})});
    }};
  },[runtime,subjectId,connected,lease]);
  const bound=!!(client&&connected&&subjectId&&lease),writable=bound&&!!runtime&&capsuleDeviceHasScope(runtime.api);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),
    [query,setQuery]=useState(()=>new URLSearchParams(location.search).get('q')??''),
    [onlyMine,setOnlyMine]=useState(()=>new URLSearchParams(location.search).get('view')==='mine');
  const [items,setItems]=useState<CapsuleDirectoryItem[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false),
    [detail,setDetail]=useState<CapsuleDetail|null>(null),[versions,setVersions]=useState<CapsuleVersions>({items:[]});
  const [uses,setUses]=useState<CapsuleUses>({items:[]}),[history,setHistory]=useState<CapsuleCaseHistory[]>([]),
    [historyNext,setHistoryNext]=useState<string|null>(null),[historyLoaded,setHistoryLoaded]=useState(false);
  const [readError,setReadError]=useState(''),[newerVersion,setNewerVersion]=useState<{versionId:string;version:number}|null>(null),
    [originWork,setOriginWork]=useState<CapsuleOriginWork|null>(null),[originError,setOriginError]=useState('');
  const [permissions,setPermissions]=useState<Record<PermissionView,CapsulePermissionView[]>>({owned:[],granted:[]}),
    [permissionNext,setPermissionNext]=useState<Partial<Record<PermissionView,string|null>>>({}),
    [selection,setPreview]=useState<PreviewSelection|null>(null),[mode,setMode]=useState<Mode>(()=>requestedMode(writable,capsuleId));
  const [useOpen,setUseOpen]=useState(false),[lastUsedTarget,setLastUsedTarget]=useState<string|null>(null),
    useDialog=useRef<HTMLDialogElement>(null),previewDialog=useRef<HTMLDialogElement>(null),previewHeading=useRef<HTMLHeadingElement>(null);
  const previewContexts=useRef(new WeakMap<CapsulePreview,CapsulePreviewContext>()),
    draftHandlers=useRef(new Map<string,(receipt:CapsuleReceipt)=>Promise<boolean>>());
  const registerDraft:CapsuleRegisterDraft=useCallback((key,settle)=>{draftHandlers.current.set(key,settle);return()=>{if(draftHandlers.current.get(key)===settle)draftHandlers.current.delete(key);};},[]);
  const preview=selection?.original??null,previewDisplay=selection?.display??{},previewOpen=!!preview;
  const memberNames=useMemberNames(runtime,subjectId,connected,[detail?.authorId,...uses.items.map(use=>use.subjectId),...(preview?.viewers??[]),
    ...(preview?.type==='publication'&&preview.payload.kind==='version'?preview.payload.contributors:[]),
    ...(preview?.type==='permission'&&preview.payload.kind==='grant'?preview.payload.grantees:[]),
    ...(previewDisplay.sources??[]).map(item=>item.authorId),...(previewDisplay.permissions??[]).map(item=>item.authorId),
    ...(detail?.permissions??[]).map(permission=>permission.authorId),...(detail?.attributions??[]).flatMap(attribution=>[attribution.subjectId,
      ...(typeof attribution.contributionResponses==='object'?attribution.contributionResponses.responses:[]).map(response=>response.actorId)])]);
  useEffect(()=>{if(useOpen)useDialog.current?.showModal();else useDialog.current?.close();},[useOpen]);
  useEffect(()=>{
    const dialog=previewDialog.current;if(!dialog)return;
    if(previewOpen){
      if(dialog.open)return;dialog.showModal();
      // Native focus would otherwise skip Save's disabled header button.
      previewHeading.current?.focus({preventScroll:true});dialog.scrollTop=0;
    }else if(dialog.open)dialog.close();
  },[previewOpen]);
  const epoch=useRef(0),active=useRef(true),operation=useRef(0),detailRead=useRef(0),directoryRead=useRef(0),originRead=useRef(0),working=useRef(false),
    pinnedVersion=useRef<string|undefined>(versionId),detailLoading=useRef(false),usePages=useRef(1),versionPages=useRef(1);
  const initialDirectoryScope=capsuleDirectoryScope(runtime?.api.endpoint,subjectId,runtime?.api.snapshot()?.bindingId),
    directoryPages=useRef(0),directoryRestore=useRef(!!directoryReadingState(initialDirectoryScope).anchorId);
  const current=useCallback((token:number)=>{if(!active.current||token!==epoch.current)return false;try{lease?.assertCurrent();return true;}catch{return false;}},[lease]);
  const assertCurrent=useCallback((token:number)=>{if(!current(token))throw Error('页面或身份已改变。');},[current]);
  const requiredClient=useCallback(()=>{if(!client)throw Error('请先连接当前身份。');assertCurrent(epoch.current);return client;},[client,assertCurrent]);
  const guard=useCallback(async<T,>(promise:Promise<T>)=>{const token=epoch.current,value=await promise;assertCurrent(token);return value;},[assertCurrent]);
  const readOrigin=useCallback(async()=>{
    if(!runtime||!connected||!lease||!helpOrigin?.taskId)throw Error('请先连接原身份，再读取原工作。');
    const token=epoch.current,ticket=++originRead.current,valid=()=>current(token)&&ticket===originRead.current;
    const check=()=>{assertCurrent(token);if(ticket!==originRead.current)throw Error('原工作已有更新的核对结果，请重新选择。');};
    const requireScope=(scope:string)=>{check();if(!capsuleDeviceHasScope(runtime.api,scope))throw Error('当前浏览器设备未获准读取原工作的 '+scope+' 范围，请在已有 Agent 核对所需权限。');};
    try{
      requireScope('assistance');
      const task:CapsuleOriginWork['task']=await runtime.api.call('/v2/tasks/'+helpOrigin.taskId,null,{method:'GET',authenticated:true});check();
      if(task.taskId!==helpOrigin.taskId||task.schemaVersion!==2)throw Error('原任务位置或版本不一致，请重新读取。');
      // Use follows current Task/Case authority, including confirmed participants.
      let facts:CapsuleCaseHistory|null=null;
      if(task.caseId){requireScope('case-teaser');facts=await runtime.api.call('/v2/cases/'+task.caseId+'/read',{taskId:task.taskId},{authenticated:true});check();}
      if(facts&&facts.caseId!==task.caseId)throw Error('原任务与工作事实不一致，请重新核对。');
      const value={task,facts};setOriginWork(value);setOriginError('');return value;
    }catch(error){if(valid()){setOriginWork(null);setOriginError(capsuleError(error));}throw error;}
  },[runtime,connected,lease,helpOrigin?.taskId,current,assertCurrent]);
  const find=useCallback(async(after?:string,token=epoch.current)=>{
    assertCurrent(token);const ticket=++directoryRead.current,params=new URLSearchParams(location.search);
    const scope=capsuleDirectoryScope(runtime?.api.endpoint,subjectId,runtime?.api.snapshot()?.bindingId),
      depth=after?1:directoryReadingState(scope).depth,rows:CapsuleDirectoryItem[]=[];
    let cursor=after??null,pages=0;
    for(let index=0;index<depth;index++){
      const page=await requiredClient().query({query:params.get('q')??'',...(params.get('view')==='mine'&&subjectId?{authorId:subjectId}:{}),...(cursor?{after:cursor}:{}),limit:12});
      if(!current(token)||ticket!==directoryRead.current)return;
      rows.push(...page.items);cursor=page.nextAfter;pages++;if(!cursor)break;
    }
    if(!current(token)||ticket!==directoryRead.current)return;
    directoryPages.current=after?directoryPages.current+pages:pages;
    setItems(old=>[...new Map((after?[...old,...rows]:rows).map(item=>[item.capsuleId,item])).values()]);setNext(cursor);setLoaded(true);
    rememberDirectoryReading(scope,Math.max(1,directoryPages.current),directoryReadingState(scope).anchorId);
  },[assertCurrent,requiredClient,subjectId,current,runtime]);
  useLayoutEffect(()=>{
    if(capsuleId||!loaded||!directoryRestore.current)return;
    directoryRestore.current=false;return restoreDirectoryReading(initialDirectoryScope);
  },[capsuleId,loaded,initialDirectoryScope]);
  const readDetail=useCallback(async(id=capsuleId,version=versionId,token=epoch.current,preserveInteraction=false)=>{
    assertCurrent(token);if(!id)throw Error('请选择一份方法。');
    const source=requiredClient();
    const ticket=++detailRead.current,selected=version??pinnedVersion.current,valid=()=>{try{assertCurrent(token);return ticket===detailRead.current;}catch{return false;}};
    const check=()=>{assertCurrent(token);if(ticket!==detailRead.current)throw Error('这份方法已有更新的读取结果。');};
    detailLoading.current=true;
    try{
      if(!preserveInteraction){setDetail(null);setUses({items:[]});setPreview(null);setUseOpen(false);setLastUsedTarget(null);}
      const readVersionPages=async()=>{
        let after:string|undefined,page:CapsuleVersions={items:[]};const rows:CapsuleVersionItem[]=[];
        for(let index=0;index<versionPages.current;index++){check();page=await source.versions({capsuleId:id,limit:50,...(after?{after}:{})});check();rows.push(...page.items);after=page.nextAfter??undefined;if(!after)break;}
        return{...page,items:rows};
      };
      const [reading,readVersions,latest]=await Promise.allSettled([
        source.get({capsuleId:id,...(selected?{versionId:selected}:{})}),readVersionPages(),
        selected?source.get({capsuleId:id}):Promise.resolve(null),
      ]);
      if(!valid())return;
      setVersions(readVersions.status==='fulfilled'?readVersions.value:{items:[]});
      if(reading.status==='rejected'){setDetail(null);setUses({items:[]});setUseOpen(false);setPreview(null);setNewerVersion(null);setReadError(capsuleError(reading.reason));throw reading.reason;}
      const value=reading.value;pinnedVersion.current=value.versionId;setReadError('');setDetail(value);
      if(!value.version){setUseOpen(false);setPreview(null);}
      const currentNumber=value.version?.version??(readVersions.status==='fulfilled'?readVersions.value.items.find(item=>item.versionId===value.versionId)?.version:undefined),
        newer=latest.status==='fulfilled'?latest.value:null;
      setNewerVersion(newer?.version&&typeof currentNumber==='number'&&newer.versionId!==value.versionId&&newer.version.version>currentNumber?{versionId:newer.versionId,version:newer.version.version}:null);
      try{
        let after:string|undefined,page:CapsuleUses={items:[]};const rows:CapsuleUseView[]=[];
        for(let index=0;index<usePages.current;index++){check();page=await source.uses({capsuleId:id,versionId:value.versionId,limit:20,...(after?{after}:{})});check();rows.push(...page.items);after=page.nextAfter??undefined;if(!after)break;}
        if(valid())setUses({...page,items:rows,loaded:true});
      }catch{if(valid())setUses({items:[],loaded:true,unavailable:true});}
    }finally{if(ticket===detailRead.current)detailLoading.current=false;}
  },[capsuleId,versionId,assertCurrent,requiredClient]);
  useEffect(()=>{
    const viewEpoch=epoch,mounted=active;mounted.current=true;viewEpoch.current++;const token=viewEpoch.current;
    const initial=window.setTimeout(()=>{
      if(connected&&helpOrigin?.taskId)void readOrigin().catch(()=>{});
      if(!client)return;
      if(capsuleId)void readDetail(capsuleId,versionId,token).catch(error=>{if(current(token))setReadError(capsuleError(error));});
      else void find(undefined,token).catch(error=>{if(current(token))setError(capsuleError(error));});
    },0);
    const reload=()=>{
      if(document.visibilityState!=='visible'||working.current||detailLoading.current||!client||!current(token))return;
      // Public directories stay stable while browsing and paging.
      if(capsuleId)void readDetail(capsuleId,versionId,token,true).catch(()=>{});
    };
    const timer=capsuleId?window.setInterval(reload,10000):null;document.addEventListener('visibilitychange',reload);
    return()=>{mounted.current=false;viewEpoch.current++;window.clearTimeout(initial);if(timer!==null)window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};
  },[client,connected,capsuleId,versionId,helpOrigin?.taskId,readOrigin,readDetail,find,current]);
  async function run(work:()=>Promise<unknown>){
    const token=epoch.current;if(working.current||!current(token))return;
    const owner=++operation.current,valid=()=>current(token)&&owner===operation.current;
    working.current=true;setBusy(true);setError('');setNotice('');
    try{await work();}catch(error){if(valid())setError(capsuleError(error));}
    finally{if(valid()){working.current=false;setBusy(false);}}
  }
  function changeMode(nextMode:Mode){
    const url=new URL(location.href);if(nextMode==='browse')url.searchParams.delete('mode');else url.searchParams.set('mode',nextMode);
    if((nextMode==='author'||nextMode==='permissions')&&capsuleId)url.pathname='/app/capsules';
    setPreview(null);setMode(nextMode);
    const target=url.pathname+url.search+url.hash;if(url.pathname!==location.pathname)navigate(target);else window.history.replaceState(window.history.state,'',target);
  }
  async function moreVersions(){
    if(!capsuleId||!versions.nextAfter)return;
    const page=await guard(requiredClient().versions({capsuleId,after:versions.nextAfter,limit:50}));
    versionPages.current++;setVersions(old=>({...page,items:[...old.items,...page.items]}));
  }
  async function loadHistory(after?:string){
    const page=await guard(requiredClient().history(after?{after}:{})),cases=page.items.filter(item=>item.kind==='case-history');
    setHistory(old=>after?[...old,...cases]:cases);setHistoryNext(page.nextCursor??null);setHistoryLoaded(true);
  }
  async function loadPermissions(view:PermissionView,after?:string){
    const page=await guard(requiredClient().permissions({view,limit:30,...(after?{after}:{})}));
    setPermissions(old=>({...old,[view]:after?[...old[view],...page.items]:page.items}));
    setPermissionNext(old=>({...old,[view]:page.nextAfter}));
  }
  async function propose(type:CapsuleOperationKind,payload:unknown,disclosure:CapsuleDisclosure,context?:CapsulePreviewContext){
    const token=epoch.current;assertCurrent(token);
    const value=await requiredClient().prepare(type,payload,disclosure);assertCurrent(token);
    if(context)previewContexts.current.set(value,context);
    setPreview({original:value,display:context?.display??{}});setNotice('');
  }
  async function copyCapsuleConnection(){
    if(!runtime)return;const token=epoch.current;assertCurrent(token);
    const scopes=[...new Set([...(runtime.api.snapshot()?.scopes??[]).filter((scope:string)=>browserScopes.includes(scope)),'binding','consent','case-teaser','history','assistance','context','capsules'])];
    const method=detail?.capsuleId&&detail.versionId?{kind:'capsule',id:detail.capsuleId,versionId:detail.versionId}:null;
    const request={object:helpOrigin?{kind:'task',id:helpOrigin.taskId}:method??{kind:'capsules'},...(helpOrigin&&method?{continueWith:method}:{}),scopes};
    const text='请用当前已有的银河 Agent 身份调用 galaxy_identity_web_connect，并核对以下公开定位与所需权限：'+JSON.stringify(request)+'。保留同一个银河 ID；请让我在本机审阅页明确批准新的浏览器设备。原设备、本机草稿与原任务仍保留，授权后回到这份精确方法。';
    try{await navigator.clipboard.writeText(text);assertCurrent(token);setNotice('已复制原任务、所选方法版本与所需权限。交给正在使用的本机 Agent 发起接续，再在本机审阅页批准。');}
    catch{if(current(token))setNotice(text);}
  }
  async function settleMatchingDrafts(receipt:CapsuleReceipt){
    if(!runtime||!subjectId)return;
    const id=receipt.capsuleId??capsuleId,version=receipt.versionId??versionId,keys=new Set<string>([
      capsuleInputDraftKey(runtime.api.endpoint,subjectId,'author'),capsuleInputDraftKey(runtime.api.endpoint,subjectId,'permissions'),
      ...(id?[capsuleInputDraftKey(runtime.api.endpoint,subjectId,'revision',id)]:[]),
      ...(version?[capsuleInputDraftKey(runtime.api.endpoint,subjectId,'maintenance',version)]:[]),
      ...(receipt.permissionId?[capsuleInputDraftKey(runtime.api.endpoint,subjectId,'permission-revoke',receipt.permissionId)]:[]),
      ...draftHandlers.current.keys(),
    ]);
    for(const key of keys){const mounted=draftHandlers.current.get(key);if(mounted)await guard(mounted(receipt));else await guard(settleCapsuleInput(runtime,subjectId,key,requiredClient(),receipt));}
  }
  async function execute(){
    if(!preview)return;
    const chosen=preview,token=epoch.current,context=previewContexts.current.get(chosen);assertCurrent(token);
    let receipt:CapsuleReceipt;
    try{receipt=await guard(requiredClient().execute(chosen,{confirmed:true,onJournal:context?.onJournal}));}
    catch(error){
      if(current(token)){
        // Retain the exact journal, then refresh current source authority.
        setPreview(null);
        if(capsuleId)try{await readDetail(capsuleId,versionId,token);}catch{}
        if(current(token)&&connected&&helpOrigin)try{await readOrigin();}catch{}
      }
      throw error;
    }
    if(context?.onAcknowledged)await guard(context.onAcknowledged(receipt));else await settleMatchingDrafts(receipt);
    assertCurrent(token);setPreview(null);
    setNotice(chosen.type==='use'?(chosen.payload.kind==='reference'?'已加入这项工作的参考。':'已记录本次应用。'):'已保存。');
    if(chosen.type==='use'){setUseOpen(false);setLastUsedTarget(chosen.payload.taskId?'/app/tasks/'+chosen.payload.taskId+'?section=collaboration&view=work':null);}
    if(chosen.type==='publication')navigate(exactCapsulePath(chosen.payload.capsuleId,chosen.payload.kind==='version'?chosen.payload.id:chosen.payload.versionId));
    else if(chosen.type==='permission'){await loadPermissions('owned');await loadPermissions('granted');}
    else if(capsuleId)await readDetail(capsuleId,versionId,token,true);
  }
  async function readCurrent(kind:string,input:unknown){
    if(!input||typeof input!=='object')throw Error('缺少所选来源的准确位置。');
    if(kind==='capsule'&&'capsuleId' in input&&typeof input.capsuleId==='string'&&'versionId' in input&&typeof input.versionId==='string')
      return guard(requiredClient().get({capsuleId:input.capsuleId,versionId:input.versionId}));
    if(kind==='case'&&'caseId' in input&&typeof input.caseId==='string')
      return guard(requiredClient().caseFacts({caseId:input.caseId,...('taskId' in input&&typeof input.taskId==='string'?{taskId:input.taskId}:{})}));
    if(kind==='use'&&'eventId' in input&&typeof input.eventId==='string'&&'capsuleId' in input&&typeof input.capsuleId==='string'
      &&'versionId' in input&&typeof input.versionId==='string'&&'caseId' in input&&typeof input.caseId==='string'){
      return guard(readCapsuleUseRecord(requiredClient(),{eventId:input.eventId,capsuleId:input.capsuleId,versionId:input.versionId,caseId:input.caseId}));
    }
    if(kind==='verification'&&'id' in input&&typeof input.id==='string'&&'version' in input&&typeof input.version==='number')
      return guard(requiredClient().verification({id:input.id,version:input.version}));
    throw Error('所选来源的位置或版本不完整，请重新选择。');
  }
  const owned=!!subjectId&&detail?.authorId===subjectId,selectedVersion=versions.items.find(version=>version.versionId===detail?.versionId),
    appliedPreview=preview?.type==='use'&&preview.payload.kind!=='reference'?preview.payload:null,
    reverifiedPreview=appliedPreview?.kind==='reverify'?appliedPreview:null;
  const directoryParams=new URLSearchParams(location.search),appliedQuery=directoryParams.get('q')??'',appliedMine=directoryParams.get('view')==='mine';
  function openDirectoryItem(item:CapsuleDirectoryItem,path:string){
    rememberDirectoryReading(capsuleDirectoryScope(runtime?.api.endpoint,subjectId,runtime?.api.snapshot()?.bindingId),Math.max(1,directoryPages.current),'directory-capsules-'+item.capsuleId);navigate(path);
  }
  return (
    <section className={capsuleId?'method-detail':'directory-page'} aria-busy={busy}>
      {capsuleId&&<a className="back-link" href={browseReturnPath('/app/capsules')} onClick={e=>{e.preventDefault();navigate(browseReturnPath('/app/capsules'));}}>← {browseReturnLabel('/app/capsules')}</a>}
      <header className="directory-heading"><div><p className="eyebrow">{capsuleId&&mode==='browse'?'方法与经验':'把经验带进下一件工作'}</p><h1 className="small">{mode==='author'?'整理一份方法':mode==='revision'?'编写方法新版本':mode==='maintenance'?'维护方法版本':mode==='permissions'?'来源许可':capsuleId?(detail?.version?.title??'方法详情'):'方法与经验'}</h1><p className="lead">{['author','revision'].includes(mode)?'从实际结果中整理做法，保留适用条件和来源。':mode==='permissions'?'查看收到的许可，或为自己拥有的来源指定使用范围。':capsuleId?detail?.version?.problemPattern:'阅读可以借鉴的做法，了解它从哪里来、在什么条件下适用。'}</p></div>{mode==='browse'&&!capsuleId&&writable&&<Button disabled={busy} onClick={()=>changeMode('author')}>整理一份方法</Button>}</header>
      {(!capsuleId||mode!=='browse')&&(writable||mode!=='browse')&&<nav className="purpose-tabs method-content-tabs" aria-label="方法内容"><button aria-current={mode==='browse'?'page':undefined} onClick={()=>{changeMode('browse');if(capsuleId)navigate('/app/capsules');}}>浏览方法</button><button aria-current={mode==='author'?'page':undefined} disabled={!writable||busy} onClick={()=>changeMode('author')}>我的草稿</button><button aria-current={mode==='permissions'?'page':undefined} disabled={!writable||busy} onClick={()=>changeMode('permissions')}>来源许可</button>{capsuleId&&['revision','maintenance'].includes(mode)&&<button onClick={()=>changeMode('browse')}>返回当前版本</button>}</nav>}
      {bound&&!writable&&<aside className="browse-note"><p>当前可以阅读公开方法。记录使用或整理新方法前，需要在已有 AI 中确认浏览器权限。</p><Button type="button" variant="outline" onClick={()=>void copyCapsuleConnection()}>在已有 AI 中继续授权</Button></aside>}
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {capsuleId&&readError&&<div className="message error" role="alert"><p>{readError}</p><Button variant="outline" disabled={busy} onClick={()=>run(()=>readDetail())}>重新读取</Button></div>}
      {notice && <div className="message"><output>{notice}</output>{lastUsedTarget&&<Button variant="ghost" onClick={()=>navigate(lastUsedTarget)}>回到这项工作<ArrowRight size={14}/></Button>}</div>}
      {helpOrigin?.returnTo&&<aside className="browse-note"><a href={helpOrigin.returnTo} onClick={e=>{e.preventDefault();navigate(helpOrigin.returnTo!);}}>返回原工作继续处理</a><p>{originWork?`从“${originWork.task.request.title}”继续。引用或应用前，仍需明确选择这份工作作为目标。`:'已保留原任务位置；连接原身份后核对当前可读的工作。'}</p>{originError&&<p role="alert">{originError}</p>}{originWork&&!originWork.task.caseId&&<p>原任务还没有关联实际工作事实。可以继续阅读，或返回原任务记录已经发生的工作。</p>}</aside>}
      <CapsuleOperationStatus runtime={runtime} subjectId={subjectId} client={client} connected={writable} paused={busy||!!preview} scopeKey={connectionKey} onComplete={async(receipt)=>{const token=epoch.current;assertCurrent(token);await settleMatchingDrafts(receipt);assertCurrent(token);setNotice('上次提交已保存。');if(capsuleId)await readDetail(capsuleId,versionId,epoch.current,true);else await find();}}/>
      {!capsuleId && mode === 'browse' && (
        <>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              const p=new URLSearchParams();if(query.trim())p.set('q',query.trim());if(onlyMine)p.set('view','mine');window.history.replaceState(window.history.state,'','/app/capsules'+(p.size?'?'+p.toString():''));void run(() => find());
            }}
          >
            <Input
              aria-label="查找方法"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="问题模式或方法标题"
            />
            <Button type="submit" disabled={!client || busy}>
              查找
            </Button>
            <label>
              <input
                type="checkbox"
                checked={onlyMine}
                disabled={!writable || busy}
                onChange={(e) => setOnlyMine(e.target.checked)}
              />
              仅我发布的
            </label>
          </form>
          {(appliedQuery||appliedMine)&&<p className="browse-note">当前范围：{appliedMine?'我发布的方法':'所有当前可读方法'}{appliedQuery?' · '+appliedQuery:''} <button type="button" disabled={busy} onClick={()=>navigate('/app/capsules')}>清除，浏览全部方法</button></p>}
          <div className="content-grid">{items.map(item=><ContentCard key={item.capsuleId} kind="capsules" item={item} navigate={path=>openDirectoryItem(item,path)} saveForLater={<SaveForLaterButton runtime={runtime} connected={bound} subjectId={subjectId} reference={{kind:'capsule',capsuleId:item.capsuleId,versionId:item.versionId}} onNeedIdentity={()=>navigate('/app/settings/identity')}/>}/>)}</div>
          {loaded&&!items.length&&!error&&<div className="directory-empty"><BookOpen size={30}/><h2>{query?'没有找到符合条件的方法':'还没有可浏览的公开方法'}</h2><p>{query?'试试不同的问题模式或标题。':'作者整理并公开方法后，你可以在这里阅读它的做法、适用环境和来源。'}</p><a href="/how-it-works/">了解方法如何成为下一份帮助 <ArrowRight size={15}/></a></div>}
          {next && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => run(() => find(next))}
            >
              更多方法
            </Button>
          )}
        </>
      )}
      {capsuleId && mode==='browse' && (
        <>
          {!detail&&!readError&&<p className="empty-state"><output>正在打开这份方法…</output></p>}
          {detail&&<>
            <div className="method-reading-meta"><MemberAvatar subjectId={detail.authorId}/><span>{memberName(detail.authorId,subjectId,(detail.authorId?memberNames[detail.authorId]:undefined)??undefined)}</span><span>第 {detail.version?.version??selectedVersion?.version??'所选'} 版</span>{detail.synthetic&&<span className="tag">合成演示</span>}{detail.sourceStatus&&detail.sourceStatus!=='current'&&<span>{detail.sourceStatus?capsuleLabel(detail.sourceStatus):'尚未读取'}</span>}</div>
            {detail.version&&detail.versionId&&<SaveForLaterButton runtime={runtime} connected={bound} subjectId={subjectId} reference={{kind:'capsule',capsuleId:detail.capsuleId,versionId:detail.versionId}} onNeedIdentity={()=>navigate('/app/settings/identity')}/>}
            {newerVersion&&<p className="method-new-version">另有第 {newerVersion.version} 版可读。<button type="button" className="text-link" onClick={()=>navigate(exactCapsulePath(capsuleId,newerVersion.versionId))}>阅读新版 →</button></p>}
            <article className="method-prose">
              {detail.version?<>
                <p className="method-environment">适用环境：{detail.version.environment.name} / {detail.version.environment.version}</p>
                <section><h2>做法</h2><p className="reading-prose">{detail.version.solutionStrategy}</p></section>
                <section><h2>如何验证</h2><p className="reading-prose">{detail.version.verificationMethod}</p></section>
                <section><h2>适用范围</h2><p className="reading-prose">{detail.version.applicableScope}</p></section>
                {detail.version.limitations.length>0&&<section><h2>限制与可能失败的条件</h2><ul>{detail.version.limitations.map((value:string,index:number)=><li key={index}>{value}</li>)}</ul></section>}
                {(detail.version.tools.length+detail.version.skills.length+detail.version.mcpRefs.length)>0&&<section><h2>使用的工具</h2><p>{[...detail.version.tools,...detail.version.skills,...detail.version.mcpRefs].join('、')}</p></section>}
                <p className="method-license">使用许可：{detail.version.license}</p>
                {(detail.version.externalReferences??[]).length>0&&<section><h2>延伸阅读</h2>{(detail.version.externalReferences??[]).map((reference)=><p key={reference.url}>{/^https?:\/\//i.test(reference.url)?<a href={reference.url} target="_blank" rel="noreferrer">{reference.description} ↗</a>:reference.description}{reference.license&&<small> · {reference.license}</small>}</p>)}</section>}
                <details className="method-source-details"><summary>了解来源与署名</summary>
                  <CapsuleAttributionResponses attributions={detail.attributions} navigate={navigate} subjectId={subjectId} names={memberNames}/>
                  {(detail.permissions??[]).length>0&&<section className="method-source-permissions"><h3>作者允许怎样使用</h3>{(detail.permissions??[]).map((permission)=><article key={permission.permissionId}><h4>{memberName(permission.authorId,subjectId,memberNames[permission.authorId]??undefined)}</h4><p className="reading-prose">{permission.scope}</p><p className="source-reading-note">署名要求：{permission.attribution} · {permission.license}</p></article>)}</section>}
                  <details className="source-reference-details"><summary>方法与来源的准确版本</summary><dl><dt>方法</dt><dd>{detail.capsuleId}</dd><dt>这一版</dt><dd>{detail.versionId}</dd><dt>来源工作</dt><dd>{detail.version.sourceResolution.caseId}</dd><dt>来源结果</dt><dd>{detail.version.sourceResolution.resultId} · 第 {detail.version.sourceResolution.resultVersion??'历史未记录'} 版</dd><dt>来源状态</dt><dd>{detail.sourceStatus?capsuleLabel(detail.sourceStatus):'尚未读取'}</dd></dl></details>
                </details>
              </>:<p className="message">这份方法的来源当前不可读取，正文已收起。</p>}
              {detail.sourceStatus==='source-result-superseded'&&<p className="message">原工作已有纠正结果，使用前请结合当前来源判断。</p>}
              {detail.sourceStatus==='source-currentness-unavailable'&&<p className="message">来源结果的当前状态暂时无法核对。</p>}
              {(detail.deprecated||detail.securityIssue||!detail.newApplicationAllowed)&&<p className="message">{detail.securityIssue?'这份版本有尚未处理的安全事项。':detail.deprecated?'作者已停用这份版本。':'当前来源暂不支持新增实际应用或再验证。'}</p>}
              {(detail.notices??[]).map((item)=><p className="message" key={item.id}>{capsuleLabel(item.kind)}：{item.summary}</p>)}
              {writable&&detail.version&&<div className="method-primary-action"><p>选择一件工作，留下参考或实际采用的记录。</p><Button onClick={()=>setUseOpen(true)}>用于我的工作<ArrowRight size={15}/></Button></div>}
              {owned&&writable&&<details className="method-owner-actions"><summary>编辑与维护这份方法</summary><div className="button-row"><Button disabled={busy} onClick={()=>changeMode('revision')}>{detail.version?'整理新版本':'选择新来源整理修复版本'}</Button><Button variant="outline" disabled={busy} onClick={()=>changeMode('maintenance')}>维护这一版本</Button><Button variant="ghost" disabled={busy} onClick={()=>changeMode('permissions')}>来源许可</Button></div></details>}
            </article>
          </>}
          {versions.items.length>1||versions.nextAfter?<details className="method-versions"><summary>其他可读版本</summary><div className="button-row">{[...versions.items].sort((a,b)=>b.version-a.version).map((item)=><Button type="button" variant={item.versionId===detail?.versionId?'secondary':'outline'} key={item.versionId} disabled={item.versionId===detail?.versionId} onClick={()=>navigate(exactCapsulePath(capsuleId,item.versionId))}>第 {item.version} 版{item.sourceStatus!=='current'?' · '+capsuleLabel(item.sourceStatus):''}</Button>)}</div>{versions.nextAfter&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>run(moreVersions)}>更多可读版本</Button>}</details>:null}
          {detail&&<section className="method-uses">
            <h2>大家怎样使用</h2>
            {uses.unavailable?<p className="empty-state">使用记录暂时无法读取。</p>:!uses.items.length&&<p className="empty-state">{uses.loaded?'还没有当前可读的使用记录。':'正在读取使用记录…'}</p>}
            <div className="reading-list">{uses.items.map((use)=><article className="method-use-record" key={use.eventId}>
              <div className="member-line"><MemberAvatar subjectId={use.subjectId}/><div><h3>{memberName(use.subjectId,subjectId,memberNames[use.subjectId]??undefined)}</h3><p className="record-meta">{capsuleLabel(use.kind)}{use.recordedAt?' · '+readableTime(use.recordedAt):''}{use.synthetic?' · 合成演示':''}</p></div></div>
              {use.record?<>
                <p className="reading-prose">{use.record.note||'将这份方法加入了工作参考。'}</p>
                {use.reportedOutcome&&<p className="method-outcome">{capsuleLabel(use.reportedOutcome)}</p>}
                {use.record.kind!=='reference'&&use.record.adoptedParts.length>0&&<p>实际采用：{use.record.adoptedParts.join('；')}</p>}
                {use.record.kind!=='reference'&&<p className="record-meta">{use.record.environment.name==='unknown'?'环境未记录':use.record.environment.name}{use.record.environment.version!=='unknown'?' / '+use.record.environment.version:''}{use.record.environmentDifference?' · '+use.record.environmentDifference:''}</p>}
                {use.sourceStatus!=='current'&&<p className="record-meta">{capsuleLabel(use.sourceStatus)}</p>}
                {use.capsuleSourceStatus==='source-currentness-unavailable'&&<p className="record-meta">所用方法的来源状态暂时无法核对。</p>}
                <div className="button-row">{use.record.taskId&&<Button type="button" variant="link" onClick={()=>navigate('/app/tasks/'+use.record?.taskId)}>查看相关工作</Button>}{use.subjectId===subjectId&&<Button type="button" variant="link" onClick={()=>navigate('/app/history')}>我的工作经历</Button>}</div>
                <details className="technical-details"><summary>使用来源与核对记录</summary>{use.originRef&&use.record.kind!=='reference'&&<p>{use.originRef.kind==='intervention'?'实际介入':'尝试'} · 第 {use.originRef.version} 版 · 结果第 {use.record.resultRef.version} 版</p>}{use.environmentSource==='unknown-origin-conditions'&&<p>原介入没有引用环境配置，环境条件尚不明确。</p>}{use.verifications?.map((verification)=><p key={verification.id+':'+verification.version}>检查第 {verification.version} 版 · {verification.referenceStatus}：{verification.record?.summary??'正文当前不可读'}</p>)}<p>记录 {use.eventId} · {capsuleLabel(use.sourceStatus)}</p></details>
              </>:<p className="record-meta">这条使用记录的来源当前不可读取。</p>}
            </article>)}</div>
            {uses.nextAfter&&<Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const page=await guard(requiredClient().uses({capsuleId,versionId:detail.versionId??undefined,after:uses.nextAfter??undefined,limit:20}));usePages.current++;setUses((old)=>({...page,loaded:true,items:[...old.items,...page.items]}));})}>更多使用记录</Button>}
            {uses.counts&&Object.values(uses.counts).some(value=>typeof value==='number'&&value>0)&&<details className="technical-details"><summary>使用记录统计</summary><dl><dt>加入参考</dt><dd>{uses.counts.references}</dd><dt>实际应用</dt><dd>{uses.counts.applications}</dd><dt>再次验证</dt><dd>{uses.counts.reverifications}</dd><dt>演示应用</dt><dd>{uses.counts.syntheticApplications}</dd><dt>当前真实目标工作</dt><dd>{uses.counts.distinctTargetCases}</dd></dl></details>}
            {writable && detail?.version && (
              <dialog ref={useDialog} className="workspace-dialog method-use-dialog" onCancel={()=>setUseOpen(false)}><header className="dialog-heading"><div><h2>用于我的工作</h2><p>{detail.version.title} · 版本 {detail.version.version}</p></div><button type="button" className="icon-button" aria-label="关闭方法使用" onClick={()=>setUseOpen(false)}><X size={19}/></button></header>{error&&<p className="message error" role="alert">{error}</p>}{useOpen&&<fieldset disabled={busy || !!preview}>
                <CapsuleApplication
                  runtime={runtime}
                  key={detail.versionId}
                  loadConfiguration={(ref:{id:string;version:number})=>guard(requiredClient().configuration(ref))}
                  readCurrent={readCurrent}
                  {...{
                    detail,
                    history,
                    historyLoaded,
                    historyNext,
                    loadHistory,
                    uses,
                    subjectId,
                    busy,
                    run,
                    propose,
                    navigate,
                    helpOrigin,
                    originWork,
                  }}
                  readOrigin={readOrigin}
                />
              </fieldset>}</dialog>
            )}
            {!bound&&detail?.version&&<div className="browse-note"><p>想把这份方法用在自己的工作中？连接身份后可以记录引用和实际应用。</p><a href="/app/settings/identity" onClick={e=>{e.preventDefault();navigate('/app/settings/identity');}}>连接身份后继续 →</a></div>}
          </section>}
        </>
      )}
      {writable && runtime && client && subjectId && (mode==='author'||((mode==='revision'||mode==='maintenance')&&detail)) && (
        <fieldset disabled={busy || !!preview}>
          <CapsuleAuthoring
            key={`${connectionKey}:${mode}:${detail?.versionId ?? 'new'}`}
            registerDraft={registerDraft}
            {...{
              runtime,
              client,
              subjectId,
              history,
              historyLoaded,
              historyNext,
              loadHistory,
              permissions,
              permissionNext,
              loadPermissions,
              busy,
              run,
              propose,
              navigate,
            }}
            mode={mode}
            detail={detail}
            management={versions.management}
            disclosure={selectedVersion?.disclosure}
            versionOptions={versions.items}
          />
        </fieldset>
      )}
      {writable && runtime && subjectId && mode === 'permissions' && (
        <fieldset disabled={busy || !!preview}>
          <CapsulePermissionWorkspace
            key={connectionKey}
            client={client}
            registerDraft={registerDraft}
            {...{
              runtime,
              subjectId,
              history,
              historyLoaded,
              historyNext,
              loadHistory,
              permissions,
              permissionNext,
              loadPermissions,
              busy,
              run,
              propose,
              navigate,
            }}
          />
        </fieldset>
      )}
      <dialog ref={previewDialog} aria-labelledby="capsule-preview-title" className="workspace-dialog method-preview-dialog" onCancel={event=>{event.preventDefault();if(!busy)setPreview(null);}}>{preview && (
        <section className="method-preview">
          <header className="dialog-heading"><h2 ref={previewHeading} id="capsule-preview-title" tabIndex={-1}>确认这次内容</h2><button type="button" className="icon-button" aria-label="关闭方法预览" disabled={busy} onClick={()=>setPreview(null)}><X size={19}/></button></header>
          {preview.type!=='use'&&subjectId&&<CapsuleAuthorPreview preview={preview} display={previewDisplay} subjectId={subjectId} names={memberNames}/>}
          {preview.type==='use'&&<><p>{capsuleLabel(preview.payload.kind)}</p><p>范围：{preview.visibility==='Public'?'面向公众':'仅本人及选定人员'}{preview.viewers.length?'；'+preview.viewers.map((id:string)=>memberName(id,subjectId,memberNames[id]??undefined)).join('、'):''}。</p><p className="reading-prose">{preview.payload.note}</p></>}
          {preview.type === 'use' && (
            <>
              <dl className="fact-details">
                <dt>选定方法</dt><dd>{detail?.version?.title??'当前所读方法'} · v{detail?.version?.version??'所选版本'}</dd>
                <dt>原工作</dt><dd>{originWork?.task.caseId===preview.payload.caseId?originWork.task.request.title:history.find((h)=>h.caseId===preview.payload.caseId)?.title??'本人所选的原工作'}</dd>
                {appliedPreview&&<><dt>原结果</dt><dd>{history.find((h)=>h.caseId===appliedPreview?.caseId)?.results?.find((r)=>r.id===appliedPreview?.resultRef.id&&r.version===appliedPreview?.resultRef.version)?.summary??'所选结果'} · v{appliedPreview.resultRef.version} · {capsuleLabel(appliedPreview.outcome)}</dd><dt>实际采用</dt><dd>{appliedPreview.adoptedParts.join('；')}</dd><dt>环境与差异</dt><dd>{appliedPreview.environment.name==='unknown'?'环境未知':appliedPreview.environment.name} / {appliedPreview.environment.version==='unknown'?'版本未知':appliedPreview.environment.version}；{appliedPreview.environmentDifference}</dd><dt>工作来源</dt><dd>{appliedPreview.originRef?.kind==='intervention'?'实际介入':'尝试'} · v{appliedPreview.originRef?.version}，保留准确的原工作和结果版本。</dd></>}
                {reverifiedPreview&&<><dt>本次再验证</dt><dd>沿用原应用，引用 {reverifiedPreview.verificationRefs.length} 条指向原结果准确版本的检查。</dd></>}
              </dl>
              <details><summary>精确引用与技术详情</summary><HistoryFields value={{capsuleId:preview.payload.capsuleId,versionId:preview.payload.versionId,caseId:preview.payload.caseId,taskId:preview.payload.taskId,originRef:appliedPreview?.originRef,resultRef:appliedPreview?.resultRef,configurationRef:appliedPreview?.configurationRef,priorUseId:reverifiedPreview?.priorUseId,verificationRefs:reverifiedPreview?.verificationRefs,payloadHash:preview.payloadHash}}/></details>
            </>
          )}
          {error&&<p className="message error" role="alert">{error}</p>}
          <div className="button-row">
            <Button type="button" disabled={busy} onClick={() => run(execute)}>
              确认保存
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              继续修改
            </Button>
          </div>
        </section>
      )}</dialog>
      {writable && capsuleId && !detail && versions.management && <section className="task-card"><p>本人管理关系仍有效，但当前版本正文不可读取。可重新选择合法来源整理空白新版本，旧授权和旧正文不会恢复。</p><Button type="button" disabled={busy} onClick={()=>{setDetail({capsuleId,versionId:versionId??null,authorId:subjectId,version:null});setMode('revision');setPreview(null);}}>整理空白修复版本</Button></section>}
      {writable && runtime && subjectId && (mode==='permissions'||capsuleId&&mode==='browse') && <CapsuleConsentControls {...{runtime,subjectId,busy,run}} targets={[
        ...versions.items.flatMap(v=>v.ownerControl?[{...v.ownerControl,label:`本人发布版本 v${v.version}`}]:[]),
        ...uses.items.flatMap(u=>u.ownerControl?[{...u.ownerControl,label:`本人${capsuleLabel(u.kind)} · ${u.recordedAt}`}]:[]),
      ]} onChanged={async()=>{if(capsuleId)try{await readDetail();}catch(e){if(!e||typeof e!=='object'||!('status' in e)||(e.status!==403&&e.status!==404))throw e;setDetail(null);setUses({items:[]});setNotice('当前展示已关闭；原事实与授权回执按各自规则保留。');}else await find();}}/>}

    </section>
  );
}
