import type {FileKind,ManagedFile,OperationsList} from '../components/operations-business-types';

export type FilesView='records'|'exceptions'|'rules'|'cleanup';
export type FileState='prepared'|'uploading'|'scan-pending'|'scanning'|'available'|'blocked'|'erased'|'expired'|'revoked';
export type FilesLocation={kind:FileKind|'all';state:FileState|'';processing:'scan'|'cleanup'|'';issue:'any'|'scan'|'cleanup'|'';selected:string;fileKind:FileKind|'';after:string;trail:string[];view:FilesView;plan?:string};
export type FileRecord=Omit<ManagedFile,'history'>;
export type FilesPage=OperationsList<FileRecord>&{readExpiresAt:number;metadataOnly:true};
export type FilesSummary={
 checkedAt:number;readExpiresAt:number;metadataOnly:true;scope:'configured-business-database';
 filters:{kind:FileKind|null;state:string|null;processing:'scan'|'cleanup'|null;issue:'any'|'scan'|'cleanup'|null};
 totals:{records:number;reservedBytes:number|null;actualStoredBytes:null;readyFiles:number;pendingScan:number;scanFailed:number;expired:number;revoked:number;removed:number;cleanupPending:number;cleanupResultUnknown:number;cleanupRunning:null;cleanupFailed:null};
 byKind:Array<{kind:FileKind;records:number;reservedBytes:number|null}>;
 policy:{
  relay:{state:'not-configured';enabled:false;ttlSeconds:null;startsAt:null;maxFileBytes:null;maxCacheBytes:null;automaticExpiryCleanupEnabled:false};
  existing:{chat:{processingAvailable:boolean;retentionDays:number;startsAt:'first-upload-start';maxFileBytes:number|null;maxSubjectBytes:number|null;maxGlobalBytes:number|null};forum:{processingAvailable:boolean;retention:'source-bound';maxFileBytes:number|null;maxSubjectBytes:number|null;maxGlobalBytes:number|null}};
  cleanup:{legacyWorker:'owner-and-safety-only';manualPlanRequired:true;executionObservation:'per-plan';physicalBlocksReleased:null};
 };
};
export const fileStates:readonly FileState[]=['prepared','uploading','scan-pending','scanning','available','blocked','erased','expired','revoked'];
export const fileStateNames:Record<FileState,string>={prepared:'等待上传',uploading:'上传处理中','scan-pending':'等待扫描',scanning:'扫描处理中',available:'附件状态可用',blocked:'扫描未通过',erased:'对象已移除',expired:'已到期',revoked:'已撤销'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cursor=/^(chat|forum):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function filesLocation(input:Record<string,unknown>):FilesLocation{
 const text=(key:string)=>typeof input[key]==='string'?input[key] as string:'';
 const rawKind=text('kind'),kind=rawKind==='all'?'all':rawKind==='forum'?'forum':'chat';
 const id=text('id').toLowerCase(),selected=uuid.test(id)?id:'',explicit=text('fileKind');
 const fileKind=selected?(explicit==='chat'||explicit==='forum'?explicit:rawKind==='chat'||rawKind==='forum'?rawKind:''):'';
 const rawState=text('state'),state=fileStates.includes(rawState as FileState)?rawState as FileState:'';
 const processing=text('processing')==='scan'?'scan':text('processing')==='cleanup'?'cleanup':'';
 const rawIssue=text('issue'),issue=rawIssue==='scan'||rawIssue==='cleanup'||rawIssue==='any'?rawIssue:'';
 const rawView=text('view'),view:FilesView=rawView==='rules'?'rules':rawView==='cleanup'?'cleanup':rawView==='exceptions'||issue?'exceptions':'records';
 const rawAfter=text('after').toLowerCase(),after=cursor.test(rawAfter)?rawAfter:'';
 const rawTrail=text('trail');const trail=rawTrail.length<=4096?rawTrail.split(',').map(value=>value.toLowerCase()).filter(value=>value==='start'||cursor.test(value)).slice(-30):[];
 const rawPlan=text('plan').toLowerCase();
 return {kind,state,processing,issue:view==='exceptions'?issue||'any':view==='rules'||view==='cleanup'?issue:'',selected:fileKind?selected:'',fileKind,after,trail,view,...(uuid.test(rawPlan)?{plan:rawPlan}:{})};
}
export function filesHref(location:FilesLocation,patch:Partial<FilesLocation>={}){
 const x={...location,...patch},query=new URLSearchParams();
 if(x.kind!=='chat')query.set('kind',x.kind);
 if(x.state)query.set('state',x.state);
 if(x.processing)query.set('processing',x.processing);
 if(x.issue)query.set('issue',x.issue);
 if(x.view!=='records')query.set('view',x.view);
 if(x.selected&&x.fileKind){query.set('id',x.selected);query.set('fileKind',x.fileKind);}
 if(x.after)query.set('after',x.after);
 if(x.trail.length)query.set('trail',x.trail.join(','));
 if(x.plan)query.set('plan',x.plan);
 return '/admin/operations/files'+(query.size?'?'+query.toString():'');
}
export function filesQuery(location:FilesLocation,{summary=false}: {summary?:boolean}={}){
 const query=new URLSearchParams();
 if(location.kind!=='all')query.set('kind',location.kind);
 if(location.state)query.set('state',location.state);
 if(location.processing)query.set('processing',location.processing);
 if(location.issue)query.set('issue',location.issue);
 if(!summary){query.set('limit','25');if(location.after)query.set('after',location.after);}
 return query.toString();
}
export function nextFilesPage(location:FilesLocation,next:string):Partial<FilesLocation>{
 return cursor.test(next)?{after:next,trail:[...location.trail,location.after||'start'].slice(-30)}:{};
}
export function previousFilesPage(location:FilesLocation):Partial<FilesLocation>{
 const last=location.trail.at(-1);return {after:last&&last!=='start'?last:'',trail:location.trail.slice(0,-1)};
}
export function fileKey(file:Pick<ManagedFile,'kind'|'id'>){return file.kind+':'+file.id;}
export function fileTitle(file:Pick<ManagedFile,'name'|'id'>){return file.name?.trim()||'文件记录 '+file.id.slice(0,8);}
export function fileBytes(value:number|null|undefined){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '未确认';
 if(value<1024)return value.toLocaleString('zh-CN')+' B';
 const units=['KiB','MiB','GiB','TiB'];let n=value/1024,i=0;
 while(n>=1024&&i<units.length-1){n/=1024;i++;}
 return n.toLocaleString('zh-CN',{maximumFractionDigits:1})+' '+units[i];
}
export function fileTime(value:string|null|undefined){
 if(!value||!Number.isFinite(Date.parse(value)))return '未记录';
 return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}
export type FileAccessDraft={reason:string;until:string};
export type FileAccessReceipt={state:'recorded';operationId:string;kind:FileKind;id:string;action:'stop'|'restore';revision:number;stopped:boolean;until:number|null;recordedAt:string;checkedAt:number;readExpiresAt:number;metadataOnly:true};
export function fileAccessStopped(file:{access?:ManagedFile['access']},now=Date.now()){return file.access?.stopped===true&&typeof file.access.until==='number'&&Number.isFinite(file.access.until)&&file.access.until*1000>now;}
export function fileAccessBody(file:Pick<ManagedFile,'processingVersion'|'access'>,action:'stop'|'restore',draft:FileAccessDraft,now=Date.now()){
 const reason=draft.reason.trim();if(reason.length<3||reason.length>1600||!file.access||!Number.isSafeInteger(file.access.revision)||file.access.revision<0)return null;
 const base={expectedVersion:file.processingVersion,expectedRevision:file.access.revision,action,reason};if(action==='restore')return base;
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.until))return null;
 const time=Date.parse(draft.until+':00+08:00');if(!Number.isFinite(time)||time<=now||new Date(time+8*3600000).toISOString().slice(0,16)!==draft.until)return null;
 return {...base,until:Math.floor(time/1000)};
}
export function fileAccessReceipt(value:unknown,original:{operationId:string;kind:FileKind;id:string;action:'stop'|'restore'}):FileAccessReceipt|{state:'not-recorded'}|null{
 const row=value&&typeof value==='object'?value as Record<string,unknown>:null;if(!row||row.operationId!==original.operationId||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.readExpiresAt<row.checkedAt)return null;
 if(row.state==='not-recorded')return {state:'not-recorded'};
 if(row.state!=='recorded'||row.kind!==original.kind||row.id!==original.id||row.action!==original.action||!Number.isSafeInteger(row.revision)||Number(row.revision)<0||typeof row.stopped!=='boolean'||row.until!==null&&(!Number.isSafeInteger(row.until)||Number(row.until)<0)||typeof row.recordedAt!=='string'||!Number.isFinite(Date.parse(row.recordedAt)))return null;
 return {state:'recorded',operationId:original.operationId,kind:original.kind,id:original.id,action:original.action,revision:Number(row.revision),stopped:row.stopped,until:row.until as number|null,recordedAt:row.recordedAt,checkedAt:row.checkedAt,readExpiresAt:row.readExpiresAt,metadataOnly:true};
}
export function fileStatus(file:Pick<ManagedFile,'cleanup'|'removedAt'|'state'|'scan'|'expiresAt'>&{access?:ManagedFile['access']},now=Date.now()){
 if(file.cleanup.objectRemoved||file.removedAt||file.state==='erased')return {label:'对象已移除',tone:'neutral'};
 const base=file.state==='revoked'?'已撤销':file.state==='expired'||file.expiresAt&&Date.parse(file.expiresAt)<=now?'已到期':'';
 if(file.cleanup.state==='result-unknown')return {label:(base?base+' · ':'')+'清除结果未确认',tone:'negative'};
 if(file.cleanup.state==='pending')return {label:(base?base+' · ':'')+'待清除',tone:'warning'};
 if(fileAccessStopped(file,now))return {label:'停止访问至 '+fileTime(new Date(file.access!.until!*1000).toISOString()),tone:'warning'};
 if(base)return {label:base,tone:'neutral'};
 if(file.scan.state==='failed')return {label:'扫描失败',tone:'negative'};
 if(file.scan.state==='blocked')return {label:'扫描未通过',tone:'negative'};
 if(file.state==='available')return {label:'附件状态可用',tone:'positive'};
 return {label:fileStateNames[file.state as FileState]??'状态待核对',tone:['prepared','uploading','scan-pending','scanning'].includes(file.state)?'warning':'neutral'};
}
export const fileScanNames:Record<ManagedFile['scan']['state'],string>={'not-started':'尚未扫描',pending:'等待扫描',running:'扫描处理中',failed:'扫描失败',clean:'扫描通过',blocked:'扫描未通过',unavailable:'扫描结果未确认'};
export const fileHistoryNames:Record<ManagedFile['history']['items'][number]['kind'],string>={prepared:'创建上传记录','upload-started':'开始上传','scan-result':'扫描结果已记录',revoked:'撤销文件','object-removal-recorded':'对象移除已记录','scan-retry':'重新安排扫描','cleanup-retry':'重新安排清除','access-stop':'停止访问','access-restore':'解除运营停止访问'};
export function fileHistory(file:ManagedFile){
 return file.history.items.map((item,index)=>({...item,index,label:item.kind==='scan-result'?(item.scanState==='clean'?'扫描通过':item.scanState==='blocked'?'扫描未通过':'扫描结果已记录'):fileHistoryNames[item.kind]}))
 .sort((a,b)=>(b.at?Date.parse(b.at):Number.NEGATIVE_INFINITY)-(a.at?Date.parse(a.at):Number.NEGATIVE_INFINITY)||a.index-b.index);
}
export function fileErrorText(code:string|null){
 const known:Record<string,string>={attachment_storage_unavailable:'对象存储暂时不可用。',attachment_cleanup_failed:'缓存清除结果尚未确认。',attachment_scan_failed:'扫描未完成，可在允许时重新安排。',attachment_scan_incomplete:'尚未取得完整扫描结果。',attachment_storage_integrity_failed:'文件内容未通过完整性检查。',attachment_author_unavailable:'上传来源当前不可用。'};
 return code?known[code]??'文件处理遇到异常，请查看当前状态。':'';
}

