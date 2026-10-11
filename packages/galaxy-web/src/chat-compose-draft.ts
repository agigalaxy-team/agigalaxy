import type {ChatAttachmentReference,ChatRuntime} from './chat-workspace-types';

export type ChatMessageLocator={messageId:string;sequence:string;subjectId:string};
export type ChatComposeValue={text:string;reply:ChatMessageLocator|null;edit:(ChatMessageLocator&{revision:number;text:string})|null;attachments:ChatAttachmentReference[]};
export type ChatComposeAttempt={kind:'send'|'edit';id:string;messageId?:string;requestHash?:string;draftRevision:string};
type DraftRecord={version:2;revision:string;value:ChatComposeValue;attempt:ChatComposeAttempt|null};
type PageCopy={version:1;base:DraftRecord|string|null;value:ChatComposeValue;attempt:ChatComposeAttempt|null};
type DraftView={value:ChatComposeValue;ready:boolean;saving:boolean;status:string;conflict:boolean;other:ChatComposeValue|null;attempt:ChatComposeAttempt|null};
type Runtime=Pick<ChatRuntime,'getLocal'|'updateLocal'|'receiptStatus'>;
export const emptyChatCompose=():ChatComposeValue=>({text:'',reply:null,edit:null,attachments:[]});
const same=(a:unknown,b:unknown)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const locator=(value:unknown):value is ChatMessageLocator=>!!value&&typeof value==='object'&&'messageId'in value&&uuid(value.messageId)&&'sequence'in value&&typeof value.sequence==='string'&&/^[1-9][0-9]*$/.test(value.sequence)&&'subjectId'in value&&typeof value.subjectId==='string';
function input(value:unknown):ChatComposeValue{
 if(!value||typeof value!=='object'||!('text'in value)||typeof value.text!=='string'||!('reply'in value)||value.reply!==null&&!locator(value.reply)||!('edit'in value)||value.edit!==null&&(!locator(value.edit)||!('revision'in value.edit)||!Number.isInteger(value.edit.revision)||!('text'in value.edit)||typeof value.edit.text!=='string')||!('attachments'in value)||!Array.isArray(value.attachments)||value.attachments.some(item=>!item||!uuid(item.id)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)))throw Error('本机草稿暂时无法读取，原内容仍保留。');
 // Rebuild only the allowed fields: a reply never persists another person's body.
 const parsed=value as ChatComposeValue,copy=(item:ChatMessageLocator)=>({messageId:item.messageId,sequence:item.sequence,subjectId:item.subjectId});
 return{text:parsed.text,reply:parsed.reply?copy(parsed.reply):null,edit:parsed.edit?{...copy(parsed.edit),revision:parsed.edit.revision,text:parsed.edit.text}:null,attachments:parsed.attachments.map(item=>({id:item.id,sha256:item.sha256}))};
}
function record(raw:unknown):DraftRecord|string|null{
 if(raw==null)return null;if(typeof raw==='string')return raw;
 if(typeof raw!=='object'||!('version'in raw)||raw.version!==2||!('revision'in raw)||!uuid(raw.revision)||!('value'in raw))throw Error('本机草稿暂时无法读取，原内容仍保留。');
 const value=input(raw.value),attempt='attempt'in raw?raw.attempt:null;
 if(attempt!==null&&(!attempt||typeof attempt!=='object'||!('kind'in attempt)||!['send','edit'].includes(String(attempt.kind))||!('id'in attempt)||!uuid(attempt.id)||!('draftRevision'in attempt)||!uuid(attempt.draftRevision)))throw Error('刚才发送的记录暂时无法核对，原输入仍保留。');
 return{version:2,revision:raw.revision,value,attempt:attempt as ChatComposeAttempt|null};
}
const valueOf=(raw:DraftRecord|string|null)=>typeof raw==='string'?{...emptyChatCompose(),text:raw}:raw?.value??emptyChatCompose();
const attemptOf=(raw:DraftRecord|string|null)=>typeof raw==='object'?raw?.attempt??null:null;

/** Each tab keeps its conflicting input; only an exact, acknowledged attempt clears it. */
export function createChatComposeDraft(runtime:Runtime,subjectId:string,roomId:string,pageId:string|Promise<string>){
 const lease=runtime.receiptStatus.captureLease(),key=`chat-draft:${roomId}`,listeners=new Set<()=>void>();
 let copyKey='';
 let active=false,generation=0,head:DraftRecord|string|null=null,base=emptyChatCompose(),tail:Promise<unknown>=Promise.resolve(),loading=Promise.resolve();
 let view:DraftView={value:emptyChatCompose(),ready:false,saving:false,status:'',conflict:false,other:null,attempt:null};
 const check=()=>lease.assertCurrent();
 const publish=(patch:Partial<DraftView>)=>{view={...view,...patch};if(active)listeners.forEach(listener=>listener());};
 const failure=(reason:unknown)=>{publish({saving:false,status:reason instanceof Error&&/[\u3400-\u9fff]/.test(reason.message)?reason.message:'本机草稿暂未保存，本页输入仍保留。'});};
 const serial=<T,>(action:()=>Promise<T>)=>{const result=tail.catch(()=>{}).then(async()=>{check();return action();});tail=result;void result.catch(failure);return result;};
 const preserve=async(value=view.value)=>{check();await runtime.updateLocal(copyKey,()=>({version:1,base:head,value:input(value),attempt:view.attempt} satisfies PageCopy),subjectId);check();};
 const removeCopy=async()=>{await runtime.updateLocal(copyKey,()=>null,subjectId);check();};
 async function write(value:ChatComposeValue){
  if(view.conflict){await preserve(value);return;}
  const expected=head,next:DraftRecord={version:2,revision:crypto.randomUUID(),value:input(value),attempt:view.attempt};
  let other:DraftRecord|string|null=null,conflicted=false;
  const stored=record(await runtime.updateLocal(key,(raw:unknown)=>{check();const old=record(raw);if(!same(old,expected)){conflicted=true;other=old;return raw;}return next;},subjectId));check();
  if(conflicted){publish({conflict:true,other:valueOf(other),saving:false,status:'另一页也修改了这份草稿。本页输入仍保留。'});await preserve(view.value);return;}
  head=stored;base=input(value);if(same(view.value,value))publish({saving:false,status:''});await removeCopy();
 }
 function start(){
  active=true;const token=++generation;publish({ready:false});
  loading=(async()=>{check();const id=await pageId;check();if(!active||token!==generation)return;copyKey=`chat-draft-page:${roomId}:${id}`;const [stored,backup]=await Promise.all([runtime.getLocal(key,subjectId),runtime.getLocal(copyKey,subjectId)]);check();if(!active||token!==generation)return;
   head=record(stored);base=valueOf(head);
   if(backup!=null){if(typeof backup!=='object'||!('version'in backup)||backup.version!==1||!('value'in backup)||!('base'in backup))throw Error('本页保留的草稿暂时无法读取，原内容仍保留。');
    const value=input(backup.value),original=record(backup.base);base=valueOf(original);
    const conflict=!same(value,valueOf(head));if(conflict)head=original;else base=valueOf(head);publish({value,ready:true,saving:false,conflict,other:conflict?valueOf(record(stored)):null,attempt:'attempt'in backup?backup.attempt as ChatComposeAttempt|null:null,status:conflict?'本页和另一页的输入均已保留，请核对后继续。':''});
   }else publish({value:valueOf(head),attempt:attemptOf(head),ready:true,saving:false,status:'',conflict:false,other:null});
  })().catch(reason=>{if(active&&token===generation)failure(reason);});return loading;
 }
 function change(patch:Partial<ChatComposeValue>){if(!view.ready)return;const value=input({...view.value,...patch});publish({value,saving:true,status:''});void serial(()=>write(value));}
 async function snapshot(){await loading;await tail;check();if(!view.ready||view.conflict)throw Error('请先核对两页的输入，再继续发送。');if(typeof head!=='object'||!head||!same(head.value,view.value)){await serial(()=>write(view.value));if(view.conflict||typeof head!=='object'||!head)throw Error('本机草稿还未保存，原输入仍保留。');}return{revision:head.revision,value:input(view.value)};}
 async function attach(attempt:Omit<ChatComposeAttempt,'draftRevision'>,revision:string){return serial(async()=>{
  let selected={...attempt,draftRevision:revision},applied=false;
  const next=record(await runtime.updateLocal(key,(raw:unknown)=>{check();const current=record(raw);if(typeof current==='object'&&current?.revision===revision){
   const prior=current.attempt;
   if(prior&&(prior.kind!==attempt.kind||prior.id!==attempt.id||prior.messageId!==attempt.messageId||prior.draftRevision!==revision||prior.requestHash&&attempt.requestHash&&prior.requestHash!==attempt.requestHash))throw Error('另一页已在确认这份输入，原内容与提交均保留。');
   selected={...attempt,...(prior?.requestHash?{requestHash:prior.requestHash}:{}),draftRevision:revision};applied=true;return{...current,attempt:selected};
  }return raw;},subjectId));check();
  if(!applied){publish({conflict:true,other:valueOf(next),saving:false,status:'另一页刚刚更新了草稿，请核对后继续。'});await preserve();throw Error('另一页刚刚更新了草稿，请核对后继续。');}head=next;publish({attempt:selected});
 });}
 async function settle(id:string){await loading;return serial(async()=>{
  let cleared=false,matched=false,before:DraftRecord|string|null=null;
  const stored=record(await runtime.updateLocal(key,(raw:unknown)=>{check();const current=record(raw);before=current;if(typeof current!=='object'||!current||current.attempt?.id!==id)return raw;
   matched=true;
   if(current.attempt.draftRevision!==current.revision)return{...current,attempt:null};
   const value=current.attempt.kind==='edit'?{...current.value,edit:null}:{...current.value,text:'',reply:null,attachments:[]};cleared=true;return{version:2,revision:crypto.randomUUID(),value,attempt:null} satisfies DraftRecord;},subjectId));check();
  if(!matched)return false;
  if(same(head,before)&&!view.conflict){const unchanged=same(view.value,valueOf(head));head=stored;base=valueOf(stored);publish({...(unchanged?{value:base}:{}),attempt:null,status:''});await removeCopy();}
  else if(view.attempt?.id===id)publish({attempt:null});
  return cleared;
 });}
 async function readOther(){await loading;await tail.catch(()=>{});check();const latest=record(await runtime.getLocal(key,subjectId));check();publish({conflict:true,other:valueOf(latest),status:''});return latest;}
 async function release(id:string){await loading;return serial(async()=>{let before:DraftRecord|string|null=null;const stored=record(await runtime.updateLocal(key,(raw:unknown)=>{check();before=record(raw);return typeof before==='object'&&before?.attempt?.id===id?{...before,attempt:null}:raw;},subjectId));check();if(same(head,before)&&!view.conflict)head=stored;if(view.attempt?.id===id)publish({attempt:null,status:''});});}
 async function resolve(choice:'mine'|'other'){
  await loading;await tail.catch(()=>{});if(!view.conflict)return;
  return serial(async()=>{check();const expected=record(await runtime.getLocal(key,subjectId));check();if(!same(valueOf(expected),view.other)){publish({other:valueOf(expected)});throw Error('另一页的输入又有变化，请再核对一次。');}
   const mine=view.value,other=valueOf(expected),value=choice==='other'?other:{text:mine.text===base.text?other.text:mine.text,reply:same(mine.reply,base.reply)?other.reply:mine.reply,edit:same(mine.edit,base.edit)?other.edit:mine.edit,attachments:same(mine.attachments,base.attachments)?other.attachments:mine.attachments};
   const next:DraftRecord={version:2,revision:crypto.randomUUID(),value:input(value),attempt:null};
   const stored=record(await runtime.updateLocal(key,(raw:unknown)=>{check();if(!same(record(raw),expected))throw Error('另一页的输入又有变化，请重新读取后核对。');return next;},subjectId));check();head=stored;base=input(value);publish({value:base,attempt:null,conflict:false,other:null,status:'',saving:false});await removeCopy();
  });
 }
 async function retrySave(){await loading;check();if(!view.ready)throw Error('请先重新打开本机草稿。');return serial(()=>write(input(view.value)));}
 async function flush(){
  await loading;
  for(;;){const queued=tail;await queued;check();if(queued!==tail)continue;if(!view.ready)throw Error('本机草稿尚未读取，请留在本页稍后再试。');
   const value=input(view.value),saved=serial(()=>preserve(value));await saved;check();
   if(saved===tail&&same(view.value,value))return;
  }
 }
 return{read:()=>view,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},start,close:()=>{active=false;generation++;},change,snapshot,attach,settle,release,readOther,resolve,retrySave,flush};
}
