'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import type {Publication,PublicationPage,SnapshotSummary} from './publication-types';
const states={queued:'等待发布',building:'正在生成官网',published:'已发布',failed:'发布未完成'};
type Pending={operationId:string;snapshot:unknown};
export function SitePublication({summary,snapshotError,publications,listError,csrfToken,canPublish}:{summary:SnapshotSummary|null;snapshotError:string;publications:PublicationPage;listError:string;csrfToken:string;canPublish:boolean}){
  const router=useRouter(),inFlight=useRef(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<Pending|null>(null),[current,setCurrent]=useState<Publication|null>(publications.items.find(item=>item.state==='queued'||item.state==='building')??null);
  const id=current?.id,state=current?.state;
  useEffect(()=>{
    if(!id||!['queued','building'].includes(state??''))return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(controller.signal.aborted)return;
      if(document.visibilityState==='visible')try{
        const response=await fetch('/v1/operations/content/publications/'+encodeURIComponent(id),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!response.ok){if(response.status===401||response.status===403){setError('请重新登录以查看发布状态。');return;}throw Error('read_failed');}const value:{publication:Publication}=await response.json();
        if(controller.signal.aborted)return;setError('');setCurrent(value.publication);
        if(value.publication.state==='published'||value.publication.state==='failed'){router.refresh();return;}
      }catch{if(!controller.signal.aborted)setError('发布状态暂时无法取得，正在重试。');}
      if(!controller.signal.aborted)timer=setTimeout(poll,3000);
    };
    timer=setTimeout(poll,1500);return()=>{controller.abort();clearTimeout(timer);};
  },[id,state,router]);
  async function publish(previous:Pending|null=null){
    if(inFlight.current||!canPublish)return;inFlight.current=true;setBusy(true);setError('');
    let intent=previous;
    try{
      if(!intent){const response=await fetch('/api/site/export',{cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('snapshot');intent={operationId:crypto.randomUUID(),snapshot:await response.json()};setPending(intent);}
      const response=await fetch('/v1/operations/content/publications',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':csrfToken},body:JSON.stringify(intent),signal:AbortSignal.timeout(20000)});
      if(!response.ok){if(response.status<500)setPending(null);throw Error(response.status===403?'denied':response.status===413?'large':response.status===409?'conflict':'unknown');}
      const value:{publication:Publication}=await response.json();setPending(null);setCurrent(value.publication);router.refresh();
    }catch(error){const code=error instanceof Error?error.message:'';setError(code==='snapshot'?'发布内容暂时无法取得，请确认页面和站点设置已发布。':code==='denied'?'当前登录无权发布，请重新登录。':code==='large'?'发布内容超过 1 MiB，请减少本次已发布内容。':code==='conflict'?'原发布操作的内容已变化，请读取当前记录。':'发布请求暂未确认，重试会继续原操作。');}finally{inFlight.current=false;setBusy(false);}
  }
  const waiting=current?.state==='queued'||current?.state==='building';
  return <section className="galaxy-publication"><header><h1>官网发布</h1>{canPublish&&<button type="button" disabled={busy||waiting||!summary} onClick={()=>void publish(pending)}>{busy?'正在提交…':pending?'继续原发布':'发布到官网'}</button>}</header>
    {snapshotError&&<p role="alert" className="galaxy-error">{snapshotError}<Link href="/admin/globals/site-settings">站点设置</Link></p>}
    {error&&<p role="alert" className="galaxy-error">{error}</p>}
    {current&&<section aria-live="polite"><h2>{states[current.state]}</h2><p>{new Date(current.updatedAt).toLocaleString('zh-CN')}</p>{current.error&&<p role="alert">{current.error.message}</p>}{current.result&&<a href={current.result.publicUrl}>查看官网</a>}</section>}
    {summary&&<section><h2>将发布的页面</h2><ul className="galaxy-records">{summary.pages.map(page=><li key={page.id}><Link href={'/admin/collections/site-pages/'+encodeURIComponent(page.id)}>{page.title}</Link><span>{page.path}</span><Link href={'/preview/pages/'+encodeURIComponent(page.id)}>预览</Link></li>)}</ul>{!summary.pages.length&&<p>还没有发布版本的页面。</p>}</section>}
    <section><h2>发布记录</h2>{listError?<p role="alert" className="galaxy-error">{listError}<button type="button" onClick={()=>router.refresh()}>重新读取</button></p>:publications.items.length?<ol className="galaxy-records">{publications.items.map(item=><li key={item.id}><strong>{states[item.state]}</strong><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time>{item.error&&<p>{item.error.message}</p>}{item.result&&<a href={item.result.publicUrl}>查看官网</a>}</li>)}</ol>:<p>还没有发布记录。</p>}{publications.nextAfter&&<Link href={'/admin/site-publication?after='+encodeURIComponent(publications.nextAfter)}>更早记录</Link>}</section>
  </section>;
}
