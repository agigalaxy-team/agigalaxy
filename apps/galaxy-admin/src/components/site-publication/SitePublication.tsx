'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {useOperationsRead} from '../../lib/use-operations-read';
import type {Publication,PublicationPage,SnapshotSummary} from './publication-types';
const states={queued:'等待发布',building:'正在发布官网',published:'已发布',failed:'发布未完成'};
const emptyPublications:PublicationPage={items:[],nextAfter:null};
type Pending={operationId:string;snapshot:unknown};
export function SitePublication({summary,snapshotError,publications,listError,csrfToken,canPublish}:{summary:SnapshotSummary|null;snapshotError:string;publications:PublicationPage;listError:string;csrfToken:string;canPublish:boolean}){
  const inFlight=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<Pending|null>(null),[current,setCurrent]=useState<Publication|null>(publications.items.find(item=>item.state==='queued'||item.state==='building')??null);
  const search=useSearchParams(),after=search.get('after');
  const directory=useOperationsRead<PublicationPage>({path:'/v1/operations/content/publications'+(after?'?after='+encodeURIComponent(after):''),initial:publications,initialError:listError,failureMessage:'发布记录暂时无法读取。'});
  const records=directory.value??emptyPublications,id=current?.id;
  const publicationRead=useOperationsRead<{publication:Publication}>({path:id?'/v1/operations/content/publications/'+encodeURIComponent(id):null,initial:current?{publication:current}:null,failureMessage:'发布状态暂时无法取得，请重新读取。'});
  useEffect(()=>{const value=publicationRead.value?.publication;if(value&&value.id===current?.id&&value.updatedAt!==current.updatedAt)setCurrent(value);},[publicationRead.value,current]);
  useEffect(()=>{const active=records.items.find(item=>item.state==='queued'||item.state==='building');if(active&&(!current||active.id!==current.id&&['published','failed'].includes(current.state)))setCurrent(active);},[records,current]);
  async function publish(previous:Pending|null=null){
    if(inFlight.current||!canPublish)return;inFlight.current=true;setBusy(true);setError('');
    let intent=previous;
    try{
      if(intent){
        const recovery=await fetch('/v1/operations/content/publications/'+encodeURIComponent(intent.operationId),{cache:'no-store',signal:AbortSignal.timeout(20000)});
        if(recovery.ok){const value:{publication:Publication}=await recovery.json();setPending(null);setCurrent(value.publication);void directory.read();return;}
        if(recovery.status!==404)throw Error(recovery.status===403?'denied':'unknown');
      }
      if(!intent){const response=await fetch('/api/site/export',{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('snapshot');intent={operationId:crypto.randomUUID(),snapshot:await response.json()};setPending(intent);}
      const response=await fetch('/v1/operations/content/publications',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken},body:JSON.stringify(intent),signal:AbortSignal.timeout(20000)});
      if(!response.ok){if(response.status<500)setPending(null);throw Error(response.status===403?'denied':response.status===413?'large':response.status===409?'conflict':'unknown');}
      const value:{publication:Publication}=await response.json();setPending(null);setCurrent(value.publication);void directory.read();
    }catch(error){const code=error instanceof Error?error.message:'';setError(code==='snapshot'?'发布内容暂时无法取得，请确认页面和站点设置已发布。':code==='denied'?'当前登录无权发布，请重新登录。':code==='large'?'发布内容超过 1 MiB，请减少本次已发布内容。':code==='conflict'?'原发布操作的内容已变化，请读取当前记录。':'发布请求暂未确认，重试会继续原操作。');}finally{inFlight.current=false;setBusy(false);}
  }
  const waiting=current?.state==='queued'||current?.state==='building';
  return <section className="galaxy-publication"><header><h1>官网发布</h1>{canPublish&&<button type="button" disabled={busy||waiting||!summary} onClick={()=>void publish(pending)}>{busy?'正在提交…':pending?'继续原发布':'发布到官网'}</button>}</header>
    {snapshotError&&<p role="alert" className="galaxy-error">{snapshotError}<Link href="/admin/globals/site-settings">站点设置</Link></p>}
    {(error||publicationRead.error)&&<p role="alert" className="galaxy-error">{error||publicationRead.error}<button type="button" onClick={()=>void publicationRead.read()}>重新读取</button></p>}
    {current&&<section aria-live="polite"><h2>{states[current.state]}</h2><p>{new Date(current.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p>{current.error&&<p role="alert">{current.error.message}</p>}{current.result&&<a href={current.result.publicUrl}>查看官网</a>}</section>}
    {summary&&<section><h2>将发布的页面</h2><ul className="galaxy-records">{summary.pages.map(page=><li key={page.id}><Link href={'/admin/collections/site-pages/'+encodeURIComponent(page.id)}>{page.title}</Link><span>{page.path}</span><Link href={'/preview/pages/'+encodeURIComponent(page.id)}>预览</Link></li>)}</ul>{!summary.pages.length&&<p>还没有发布版本的页面。</p>}</section>}
    <section><h2>发布记录</h2>{directory.error?<p role="alert" className="galaxy-error">{directory.error}<button type="button" onClick={()=>void directory.read()}>重新读取</button></p>:records.items.length?<ol className="galaxy-records">{records.items.map(item=><li key={item.id}><strong>{states[item.state]}</strong><time>{new Date(item.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</time>{item.error&&<p>{item.error.message}</p>}{item.result&&<a href={item.result.publicUrl}>查看官网</a>}</li>)}</ol>:<p>还没有发布记录。</p>}{records.nextAfter&&<Link href={'/admin/site-publication?after='+encodeURIComponent(records.nextAfter)}>更早记录</Link>}</section>
  </section>;
}
