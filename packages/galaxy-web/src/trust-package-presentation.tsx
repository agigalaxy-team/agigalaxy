import React,{useCallback,useEffect,useId,useRef,useState} from 'react';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {MemberAvatar,memberName} from './conversation-ui';

type PeopleKind='contacts'|'rooms';
type Person={subjectId:string;displayName?:string|null;relation?:string};
type PeopleClient={peoplePage:(kind:PeopleKind,input:{after?:string})=>Promise<{items:Person[];next:string|null}>};
type PeopleProps={
 client:PeopleClient|null;subjectId?:string;busy?:boolean;label?:string;query?:string;onQuery?:(query:string)=>void;
}&({single:true;value:string;onChange:(value:string)=>void}|{single?:false;value:string[];onChange:(value:string[])=>void});
type PeopleState={client:PeopleClient|null;people:Person[];next:Partial<Record<PeopleKind,string|null>>;loading:boolean;error:string};
const initialPeople=(client:PeopleClient|null):PeopleState=>({client,people:[],next:{},loading:!!client,error:''});

/** Current contacts are choices; the full ID remains an optional professional import. */
export function TrustPeopleChooser(props:PeopleProps){
 const {client,subjectId,busy=false,label='选择接收者',query='',onQuery}=props;
 const active=useRef(client),clients=useRef(new WeakMap<PeopleClient,{reading:Set<PeopleKind>;cursors:Set<string>}>());
 const [data,setData]=useState(()=>initialPeople(client)),searchId=useId(),identityId=useId();
 const {people,next,loading,error}=data.client===client?data:initialPeople(client);
 const load=useCallback((kind:PeopleKind,after?:string)=>{
  if(!client||active.current!==client)return Promise.resolve();
  const context=clients.current.get(client)??{reading:new Set<PeopleKind>(),cursors:new Set<string>()};clients.current.set(client,context);
  if(context.reading.has(kind))return Promise.resolve();
  const cursor=kind+':'+(after??'');
  context.reading.add(kind);
  let result:Promise<{items:Person[];next:string|null}>;
  try{result=after&&context.cursors.has(cursor)?Promise.reject(Error('local-cursor-repeat')):client.peoplePage(kind,{after});}catch(error){result=Promise.reject(error);}
  return result.then(page=>{if(active.current!==client)return;if(after)context.cursors.add(cursor);
   setData(old=>{const current=old.client===client?old:initialPeople(client);return {...current,people:[...new Map([...current.people,...page.items].map(person=>[person.subjectId,person])).values()],next:{...current.next,[kind]:page.next}};});
  }).catch((error:unknown)=>{if(active.current===client)setData(old=>({...((old.client===client)?old:initialPeople(client)),error:error instanceof Error&&error.message==='local-cursor-repeat'?'联系人列表暂时不能继续，已读到的人仍可选择。':'部分联系人暂时读不到，已选的人保留。'}));})
   .finally(()=>{context.reading.delete(kind);if(active.current===client)setData(old=>({...old,loading:context.reading.size>0}));});
 },[client]);
 useEffect(()=>{active.current=client;void Promise.all([load('contacts'),load('rooms')]);return()=>{if(active.current===client)active.current=null;};},[client,load]);
 const chosen=props.single?(props.value?[props.value]:[]):props.value??[],selected=new Set(chosen),ids=[...new Set([...people.map(person=>person.subjectId),...chosen])];
 const name=(id:string)=>memberName(id,subjectId,people.find(person=>person.subjectId===id)?.displayName??undefined);
 const shown=ids.filter(id=>!query.trim()||name(id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 function choose(id:string,checked:boolean){if(props.single)props.onChange(checked?id:'');else props.onChange(checked?[...selected,id]:chosen.filter(person=>person!==id));}
 function more(kind:PeopleKind,after:string){setData(old=>({...old,loading:true}));void load(kind,after);}
 return <section className="trust-people-selector" aria-label={label}>
  <label htmlFor={searchId}>按姓名查找<Input id={searchId} value={query} disabled={busy} onChange={event=>onQuery?.(event.target.value)} placeholder="姓名或已有称呼"/></label>
  <div className="trust-people-list">{shown.map(id=><label key={id} className={selected.has(id)?'selected':''}><input type={props.single?'radio':'checkbox'} name={searchId+'-person'} checked={selected.has(id)} disabled={busy} onChange={event=>choose(id,event.target.checked)}/><MemberAvatar subjectId={id} own={id===subjectId}/><span><strong>{name(id)}</strong><small>{id===subjectId?'我自己':people.find(person=>person.subjectId===id)?.relation??'已选的人'}</small></span></label>)}</div>
  {loading&&<p><output>正在读取联系人…</output></p>}{!loading&&!shown.length&&<p className="muted">{query?'当前已读列表没有匹配姓名。':'还没有可选联系人，也可以只给自己使用。'}</p>}
  <div className="button-row"><Button type="button" variant="ghost" disabled={busy||!subjectId} onClick={()=>{if(subjectId){if(props.single)props.onChange(subjectId);else props.onChange([subjectId]);}}}>{props.single?'用于我自己的资料包':'仅给我自己'}</Button>{next.contacts&&<Button type="button" variant="ghost" disabled={loading||busy} onClick={()=>more('contacts',next.contacts!)}>更多联系人</Button>}{next.rooms&&<Button type="button" variant="ghost" disabled={loading||busy} onClick={()=>more('rooms',next.rooms!)}>更早对话中的人</Button>}</div>
  {error&&<p><output>{error}</output></p>}
  <details><summary>使用对方提供的银河 ID</summary><label htmlFor={identityId}>准确身份<Input id={identityId} value={props.single?props.value:chosen.join(' ')} disabled={busy} onChange={event=>{if(props.single)props.onChange(event.target.value.trim());else props.onChange([...new Set(event.target.value.split(/[\s,，、]+/).filter(Boolean))]);}} placeholder="粘贴对方给出的完整身份"/></label></details>
 </section>;
}
