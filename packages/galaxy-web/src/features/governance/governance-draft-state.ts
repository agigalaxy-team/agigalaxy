export type GovernanceDraftRuntime={
 receiptStatus:{captureLease:()=>{assertCurrent:()=>void}};
 getLocal:(key:string,subjectId?:string)=>Promise<unknown>;
 updateLocal:(key:string,update:(raw:unknown)=>unknown,subjectId?:string)=>Promise<unknown>;
};
type DraftRecord<T,A>={version:1;revision:string;value:T;attempt?:A};
type DraftView<T,A>={value:T;ready:boolean;status:string;attempt:A|null};
export type DraftReceipt={state:string}|null|undefined;

function record<T extends object,A extends object>(raw:unknown):DraftRecord<T,A>|null{
 if(raw===null||raw===undefined)return null;
 if(typeof raw!=='object'||!('version' in raw)||raw.version!==1||!('revision' in raw)||typeof raw.revision!=='string'
  ||!('value' in raw)||!raw.value||typeof raw.value!=='object')throw Error('本机草稿暂时无法读取，请保留原内容。');
 // The saved envelope is checked here; the owning form validates its values
 // against the business schema before any submitted action.
 return raw as DraftRecord<T,A>;
}

/** Serial local CAS writes; only a matching acknowledged operation clears input. */
export function createGovernanceDraftState<T extends object,A extends object=Record<string,unknown>>(
 runtime:GovernanceDraftRuntime,subjectId:string|undefined,connected:boolean,key:string,initial:T,readable:(reason:unknown)=>string,
){
 const lease=connected&&subjectId?runtime.receiptStatus.captureLease():null,listeners=new Set<()=>void>();
 let head:string|null=null,tail:Promise<unknown>=Promise.resolve(),loading:Promise<void>=Promise.resolve();
 let active=false,ready=false,failed=false,generation=0,value=structuredClone(initial);
 let view:DraftView<T,A>={value,ready:false,status:'',attempt:null};
 const publish=(patch:Partial<DraftView<T,A>>)=>{view={...view,...patch};if(active)for(const listener of listeners)listener();};
 const check=()=>{if(!lease)throw Error('请先连接身份。');lease.assertCurrent();};
 const fail=(reason:unknown)=>{failed=true;if(active)publish({status:readable(reason)});};
 function start(){
  active=true;const token=++generation;ready=false;failed=false;value=structuredClone(initial);
  publish({value,ready:false,status:'',attempt:null});
  if(!lease){publish({ready:true});return Promise.resolve();}
  loading=(async()=>{
   check();const saved=record<T,A>(await runtime.getLocal(key,subjectId));check();
   if(!active||token!==generation)return;
   head=saved?.revision??null;value=saved?.value??structuredClone(initial);ready=true;
   publish({value,attempt:saved?.attempt??null,ready:true,status:saved?'已恢复本机草稿。':''});
  })().catch(reason=>{if(active&&token===generation)fail(reason);});
  return loading;
 }
 function serial<R>(action:()=>Promise<R>){const result=tail.then(async()=>{check();return action();});tail=result;void result.catch(fail);return result;}
 function change(patch:Partial<T>){
  if(!active)return;
  const next={...value,...patch};value=next;publish({value:next,attempt:null});
  if(!ready||failed)return;
  publish({status:'正在保存…'});
  void serial(async()=>{
   const expected=head;
   const saved=record<T,A>(await runtime.updateLocal(key,(raw:unknown)=>{
    check();const old=record<T,A>(raw);
    if((old?.revision??null)!==expected)throw Error('另一页已修改这份草稿。本页输入仍保留，请重新打开后核对。');
    return{version:1,revision:crypto.randomUUID(),value:structuredClone(next)};
   },subjectId));check();
   if(!saved)throw Error('草稿还未保存成功，请保留本页输入。');
   head=saved.revision;if(active&&value===next)publish({status:'草稿已保存在本机。'});
  });
 }
 async function snapshot(){await loading;await tail;check();if(!ready||failed)throw Error('草稿还未保存成功，请保留本页输入。');return{revision:head,value:structuredClone(value)};}
 async function attach(attempt:A,revision:string|null){
  if(!revision)return;
  return serial(async()=>{
   const saved=record<T,A>(await runtime.updateLocal(key,(raw:unknown)=>{check();const old=record<T,A>(raw);return old?.revision===revision?{...old,attempt}:raw;},subjectId));check();
   if(active&&head===revision&&saved?.revision===revision&&JSON.stringify(value)===JSON.stringify(saved.value))publish({attempt});
  });
 }
 async function settle(receipt:(locator:A)=>Promise<DraftReceipt>){
  await loading;await tail;check();const old=record<T,A>(await runtime.getLocal(key,subjectId));check();
  if(!old?.attempt)return false;
  const result=await receipt(old.attempt);check();if(result?.state!=='acknowledged')return false;
  return serial(async()=>{
   let removed=false;
   await runtime.updateLocal(key,(raw:unknown)=>{check();const current=record<T,A>(raw);if(current?.revision===old.revision&&JSON.stringify(current.attempt)===JSON.stringify(old.attempt)){removed=true;return null;}return raw;},subjectId);check();
   if(removed&&head===old.revision){head=null;if(JSON.stringify(value)===JSON.stringify(old.value)){value=structuredClone(initial);if(active)publish({value,attempt:null,status:''});}}
   return removed;
  });
 }
 return{read:()=>view,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  start,close:()=>{active=false;generation++;},change,snapshot,attach,settle};
}
