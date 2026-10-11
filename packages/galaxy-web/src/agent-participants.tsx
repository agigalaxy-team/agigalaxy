import React,{useEffect,useMemo,useSyncExternalStore} from 'react';
import {Bot} from 'lucide-react';
import {createChatAgentClient} from './chat-agent-client.mjs';
import {memberName,useMemberNames} from './conversation-ui';
import {useChoiceViewLease,type ChoiceViewLease} from './choice-retained-operations';
import type {createWebRuntime} from './runtime.mjs';
import './agent-participants.css';

export const agentAuthorizationActionEvent='galaxy-agent-authorization-action';
export const agentParticipationChangedEvent='galaxy-agent-participation-changed';
const states:Record<string,string>={revoked:'已撤销',expired:'已到期','binding-unavailable':'客户端已断开','room-inactive':'对话已停止新增内容'};
const modes:Record<string,string>={read:'可读取获准的消息',draft:'可读取消息并准备草稿',respond:'可读取消息、准备草稿并回复'};
type Runtime=Pick<Awaited<ReturnType<typeof createWebRuntime>>,'api'|'status'|'receiptStatus'|'getLocal'|'putLocal'|'updateLocal'>;
type Participant={grantId:string;subjectId:string;mode:string;primaryResponder:boolean;expiresAt:number;state:string};
type ParticipantState={items:Participant[];next:string|null;busy:boolean;loaded:boolean;error:string};
function createParticipantView(runtime:Runtime,roomId:string,lease:ChoiceViewLease|null){
 const connection={...runtime.api.snapshot(),endpoint:runtime.api.endpoint},owner=connection.subjectId;
 const client=createChatAgentClient(runtime),listeners=new Set<()=>void>();
 let state:ParticipantState={items:[],next:null,busy:false,loaded:false,error:''},epoch=0,alive=false,reading=false,again=false,pages=1;
 const current=(version=epoch)=>{try{lease?.assertCurrent();const value=runtime.api.snapshot();return alive&&version===epoch&&runtime.api.endpoint===connection.endpoint&&value?.subjectId===connection.subjectId&&value?.bindingId===connection.bindingId&&value?.generation===connection.generation;}catch{return false;}};
 const update=(patch:Partial<ParticipantState>)=>{state={...state,...patch};for(const changed of listeners)changed();};
 async function load(){
  if(!current())return;if(reading){again=true;return;}const version=epoch;reading=true;update({busy:true});
  try{let after:string|undefined;const rows:Participant[]=[];
   for(let page=0;page<pages;page++){
    const result:{items:Participant[];next?:string|null}=await client.participants(roomId,{...(after?{after}:{}),limit:20});if(!current(version))return;
    for(const item of result.items)if(!rows.some(row=>row.grantId===item.grantId))rows.push(item);
    const more=result.next??undefined;if(more&&more===after)throw Error('AI 参与范围暂时不能继续读取。');after=more;if(!after)break;
   }
   update({items:rows,next:after??null,error:'',loaded:true});
  }catch{if(current(version))update({items:[],next:null,error:'暂时无法读取 AI 的参与范围。',loaded:true});}
  finally{if(current(version)){reading=false;update({busy:false});if(again){again=false;void load();}}}
 }
 const read=()=>{if(!document.hidden)void load();};
 const changed=(event:Event)=>{const value:unknown=event instanceof CustomEvent?event.detail:null;if(value&&typeof value==='object'&&'roomId'in value&&'endpoint'in value&&'subjectId'in value&&value.roomId===roomId&&value.endpoint===connection.endpoint&&value.subjectId===owner)read();};
 return{
  owner,read:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},load,
  start(){alive=true;epoch++;reading=false;again=false;read();const timer=setInterval(read,20000);document.addEventListener('visibilitychange',read);window.addEventListener(agentParticipationChangedEvent,changed);
   return()=>{alive=false;epoch++;clearInterval(timer);document.removeEventListener('visibilitychange',read);window.removeEventListener(agentParticipationChangedEvent,changed);};},
  more(){if(current()){pages++;void load();}},
  request(kind:'edit'|'revoke'|'inspect',item:Participant){if(!current()||item.subjectId!==owner)return;window.dispatchEvent(new CustomEvent(agentAuthorizationActionEvent,{detail:{kind,roomId,grantId:item.grantId,subjectId:owner,endpoint:connection.endpoint,observed:{mode:item.mode,primaryResponder:!!item.primaryResponder,expiresAt:item.expiresAt,state:item.state}}}));},
 };
}
export function AgentParticipants(props:{runtime:Runtime;roomId:string}){
 const subjectId=props.runtime.api.snapshot()?.subjectId,scope=useChoiceViewLease(props.runtime,subjectId);
 return <AgentParticipantsView key={props.roomId+':'+scope.key+':'+props.runtime.api.endpoint} {...props} lease={scope.lease}/>;
}
function AgentParticipantsView({runtime,roomId,lease}:{runtime:Runtime;roomId:string;lease:ChoiceViewLease|null}){
 const view=useMemo(()=>createParticipantView(runtime,roomId,lease),[runtime,roomId,lease]),{items,next,busy,loaded,error}=useSyncExternalStore(view.subscribe,view.read,view.read),owner=view.owner;
 useEffect(()=>view.start(),[view]);
 const names=useMemberNames(runtime,owner,!!owner,items.map(item=>item.subjectId));
 const render=(item:Participant)=><li key={item.grantId}><Bot size={20} aria-hidden="true"/><div><strong>{memberName(item.subjectId,owner,names[item.subjectId]??undefined)}的 AI</strong><p>{item.state==='active'?modes[item.mode]??'有限参与':states[item.state]??'当前不可使用'}{item.primaryResponder&&item.state==='active'?' · 主要回复者':''}</p>
  {item.subjectId===owner&&item.state==='active'&&<div className="agent-participation-actions"><button className="text-link" onClick={()=>view.request('edit',item)}>调整参与方式</button><button className="text-link" onClick={()=>view.request('revoke',item)}>撤销</button></div>}
  <details><summary>参与范围</summary><dl><dt>允许的行为</dt><dd>{modes[item.mode]??'有限参与'}</dd><dt>{item.state==='active'?'有效至':'原有效期至'}</dt><dd>{new Date(item.expiresAt*1000).toLocaleString('zh-CN')}</dd></dl>{item.subjectId===owner&&<button className="text-link" onClick={()=>view.request('inspect',item)}>查看这项授权的记录</button>}</details></div></li>;
 const active=items.filter(item=>item.state==='active'),previous=items.filter(item=>item.state!=='active');
 return <section className="agent-participants" aria-label="对话中的 AI">
  <h4>当前参与</h4>
  {!loaded&&<output>正在读取…</output>}
  {error&&<output className="message error">{error} <button className="text-link" disabled={busy} onClick={()=>void view.load()}>再试一次</button></output>}
  {loaded&&!error&&!active.length&&<p className="muted">{next?'已加载的记录中，暂未看到当前可参与的 AI。':'目前没有已授权参与的 AI。'}</p>}
  <ul>{active.map(render)}</ul>
  {!!previous.length&&<details className="agent-participants-history"><summary>以前的参与范围</summary><ul>{previous.map(render)}</ul></details>}
  {next&&<button className="text-link" disabled={busy} onClick={()=>view.more()}>更多参与记录</button>}
 </section>;
}
