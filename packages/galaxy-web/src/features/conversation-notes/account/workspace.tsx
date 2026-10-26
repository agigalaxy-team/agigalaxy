import React,{useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {createAccountConversationNotes} from "./store.mjs";
import {LoadingFeedback} from "../../../shared/feedback/interaction-feedback";
import "../../trust-packages/content-share-flow.css";

export type AccountNotesAuthority=Parameters<typeof createAccountConversationNotes>[0];
type Saved={version:number;endpoint:string;accountId:string;roomId:string;note:string;noteRevision:number;references:{messageId:string;revision:number}[];draft:{id:string;text:string;baseRevision:number}|null};
export type AccountNotesMessage={messageId:string;revision:number;text:string|null;state:string;expiresAt?:string|null;sharedSummaryId?:string|null};
type Props={authority:AccountNotesAuthority;accountId:string;roomId:string;messages?:AccountNotesMessage[];onLocate?:(messageId:string)=>void;onShare?:(text:string)=>Promise<unknown>};
const notice=(error:unknown)=>error instanceof Error&&error.message==='conversation_notes_conflict'
  ?'另一页已更新备注。两份内容都保留，请选择继续使用的内容。'
  :error instanceof Error&&error.message==='conversation_notes_limit'?'这段对话的收藏已满，可以先移除不再需要的重点。':'暂时无法保存，当前输入仍保留。';

export function AccountConversationNotes(props:Props){
  return <AccountConversationNotesSession key={JSON.stringify([props.authority.endpoint,props.accountId,props.roomId])} {...props}/>;
}
function AccountConversationNotesSession({authority,accountId,roomId,onShare}:Props){
  const noteId=useId();
  const store=useMemo(()=>createAccountConversationNotes(authority,{accountId,roomId}),[authority,accountId,roomId]);
  const [saved,setSaved]=useState<Saved|null>(null),[text,setText]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[conflict,setConflict]=useState<Saved|null>(null);
  const live=useRef(true),edited=useRef(false),value=useRef(''),base=useRef(0),head=useRef<string|null>(null),queue=useRef<Promise<unknown>>(Promise.resolve()),stopped=useRef(false);
  const adopt=useCallback((next:Saved)=>{setSaved(next);base.current=next.draft?.baseRevision??next.noteRevision;head.current=next.draft?.id??null;value.current=next.draft?.text??next.note;setText(value.current);edited.current=!!next.draft;const changed=!!next.draft&&next.draft.baseRevision!==next.noteRevision;stopped.current=changed;setConflict(changed?next:null);setError(changed?'备注已有较新的版本，两份内容都保留。':'');},[]);
  useEffect(()=>{live.current=true;let active=true;store.read().then(next=>{if(active)adopt(next);}).catch(error=>{if(active)setError(notice(error));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;live.current=false;};},[store,adopt]);
  function change(next:string){setText(next);value.current=next;edited.current=true;setMessage('');
    const selected=next,revision=base.current;
    queue.current=queue.current.then(async()=>{if(stopped.current)return;const result=await store.saveDraft({text:selected,baseRevision:revision,expectedDraftId:head.current});head.current=result.draft?.id??null;}).catch(async error=>{stopped.current=true;await failed(error);});
  }
  async function failed(reason:unknown){if(!live.current)return;setError(notice(reason));if(reason instanceof Error&&reason.message==='conversation_notes_conflict'){try{const current=await store.read();if(live.current){stopped.current=true;setConflict(current);}}catch{}}}
  async function save(){if(!saved||busy)return;setBusy(true);setError('');const selected=value.current;
    try{await queue.current;if(stopped.current)return;const result=await store.saveNote({text:selected,expectedRevision:base.current,expectedDraftId:head.current});if(!live.current)return;setSaved(result);base.current=result.noteRevision;head.current=null;
      if(value.current===selected){edited.current=false;setMessage('备注已保存。');}
    }catch(error){await failed(error);}finally{if(live.current)setBusy(false);}
  }
  async function reload(){setBusy(true);try{const next=await store.read();if(live.current)adopt(next);}catch(error){if(live.current)setError(notice(error));}finally{if(live.current)setBusy(false);}}
  async function resolve(useMine:boolean){if(!conflict||busy)return;setBusy(true);try{const selected=useMine?value.current:conflict.draft?.text??conflict.note;const next=await store.saveNote({text:selected,expectedRevision:conflict.noteRevision,expectedDraftId:conflict.draft?.id??null});if(live.current){adopt(next);setMessage('备注已保存。');}}catch(error){await failed(error);}finally{if(live.current)setBusy(false);}}
  if(loading)return <LoadingFeedback label="正在读取对话备注…"/>;
  return <section className="summary-workspace conversation-notes" aria-label="对话备注">
    {error&&<p role="alert" className="message error">{error}{!saved?<button type="button" className="text-link" onClick={()=>void reload()}>重新读取</button>:stopped.current&&!conflict&&<button type="button" className="text-link" onClick={()=>{stopped.current=false;setError('');change(value.current);}}>重试保存输入</button>}</p>}
    {message&&<output className="privacy-notice">{message}</output>}
    {conflict&&<section className="summary-conflicts"><h3>另一页保留的备注</h3><p className="reading-prose">{(conflict.draft?.text??conflict.note)||'（空白备注）'}</p><div className="button-row"><Button disabled={busy} onClick={()=>void resolve(true)}>保存我的当前输入</Button><Button variant="outline" disabled={busy} onClick={()=>void resolve(false)}>采用另一页内容</Button></div></section>}
    <form className="summary-editor" onSubmit={event=>{event.preventDefault();void save();}}><label htmlFor={noteId}>我的备注<Textarea id={noteId} maxLength={8000} value={text} disabled={!saved||busy} onChange={event=>change(event.target.value)} placeholder="记下与你有关的重点…"/></label><div className="button-row"><Button type="submit" disabled={!saved||busy||!edited.current||stopped.current}>保存备注</Button>{onShare&&text.trim()&&<Button type="button" variant="outline" disabled={busy||stopped.current} onClick={()=>{setBusy(true);setError('');void onShare(text.trim()).then(()=>{if(live.current)setMessage('已发送到对话。');}).catch(()=>{if(live.current)setError('暂时未确认发送，备注仍保留。');}).finally(()=>{if(live.current)setBusy(false);});}}>发送到对话</Button>}</div></form>
  </section>;
}
