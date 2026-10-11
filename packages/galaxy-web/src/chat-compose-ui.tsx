import React,{useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {createChatComposeDraft,type ChatComposeValue,type ChatMessageLocator} from './chat-compose-draft';
import {chatComposePageId} from './chat-compose-page';
import type {ChatRuntime} from './chat-workspace-types';

export function useChatComposeDraft(runtime:ChatRuntime,subjectId:string,roomId:string){
 const [pageId]=useState(chatComposePageId);
 const store=useMemo(()=>createChatComposeDraft(runtime,subjectId,roomId,pageId),[runtime,subjectId,roomId,pageId]);
 const view=useSyncExternalStore(store.subscribe,store.read,store.read);
 useEffect(()=>{void store.start();return store.close;},[store]);
 return{...view,change:store.change,snapshot:store.snapshot,attach:store.attach,settle:store.settle,release:store.release,readOther:store.readOther,resolve:store.resolve,retrySave:store.retrySave,flush:store.flush};
}

function DraftCopy({value,preview}:{value:ChatComposeValue;preview:(source:ChatMessageLocator)=>string}){
 return <>{value.edit&&<div><h4>正在编辑的消息</h4><p className="chat-draft-copy">{value.edit.text||'尚未输入修改内容'}</p></div>}
  {(value.text||!value.edit)&&<div><h4>{value.edit?'另有未发送文字':'未发送文字'}</h4><p className="chat-draft-copy">{value.text||'尚未输入文字'}</p></div>}
  {value.reply&&<p className="chat-draft-reference">回复：{preview(value.reply)}</p>}
  {value.attachments.length>0&&<p className="chat-draft-reference">已选择 {value.attachments.length} 个附件，发送前可在附件中核对。</p>}
 </>;
}

export function ChatDraftRecovery({draft,busy,preview,onAction}:{draft:ReturnType<typeof useChatComposeDraft>;busy:boolean;preview:(source:ChatMessageLocator)=>string;onAction:(action:()=>Promise<unknown>)=>void}){
 if(!draft.conflict)return null;
 return <section className="chat-draft-recovery" aria-label="核对两页输入"><h3>另一页也写了消息</h3><p>两页输入均已保留。保留本页修改时，没有改过的部分会沿用另一页内容。</p>
  {draft.other&&<div className="chat-draft-compare"><section><h3>本页内容</h3><DraftCopy value={draft.value} preview={preview}/></section><section><h3>另一页内容</h3><DraftCopy value={draft.other} preview={preview}/></section></div>}
  <div className="button-row">{draft.other&&<><Button type="button" disabled={busy} onClick={()=>onAction(()=>draft.resolve('mine'))}>保留本页修改</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>onAction(()=>draft.resolve('other'))}>采用另一页内容</Button></>}<Button type="button" variant="ghost" disabled={busy} onClick={()=>onAction(()=>draft.readOther())}>重新读取另一页</Button></div>
 </section>;
}
