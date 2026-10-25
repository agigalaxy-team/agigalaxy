import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createDiscoveryClient} from '../discovery/client.mjs';
import './native-content.css';

type Item={kind:'post'|'reply';id:string;version:string;postId:string;title:string;excerpt:string;topic:string;href:string;publishedUntil:number;reason?:{label:string;code:string};recommendation?:{requestId:string};search?:{requestId:string;position:number}};
type Page={items:Item[];nextAfter?:number|null;readExpiresAt:number;checkedAt:number;source:string;search?:{requestId:string;configurationVersion:number|null;resultState:'has-results'|'no-results'|'scan-limited'}};
type Props={endpoint:string;navigate:(path:string)=>void};
function validate(value:Page){
 const now=Date.now()/1000;
 if(!value||!Array.isArray(value.items)||value.items.length>30||!Number.isFinite(value.readExpiresAt)||value.readExpiresAt<=now||value.readExpiresAt>now+31)throw Error('Invalid discovery response');
 if(value.search&&(!/^[0-9a-f-]{36}$/.test(value.search.requestId)||value.search.configurationVersion!==null&&(!Number.isSafeInteger(value.search.configurationVersion)||value.search.configurationVersion<0)||!['has-results','no-results','scan-limited'].includes(value.search.resultState)))throw Error('Invalid search response');
 for(const item of value.items){if(!['post','reply'].includes(item.kind)||!/^[0-9a-f-]{36}$/.test(item.id)||typeof item.version!=='string'||typeof item.title!=='string'||typeof item.excerpt!=='string'||!Number.isFinite(item.publishedUntil)||item.href!=='/app/community/'+(item.kind==='reply'?'replies/':'posts/')+item.id)throw Error('Invalid public source');}
 if(value.search&&value.items.some((item,index)=>item.search?.requestId!==value.search!.requestId||item.search.position!==index+1))throw Error('Invalid search result reference');
 return {...value,items:value.items.filter(item=>item.publishedUntil>now)};
}
function usePublicPage(endpoint:string,query:string|null,mode:'personalized'|'latest',attempt:number){
 const client=useMemo(()=>createDiscoveryClient({endpoint,websiteOrigin:location.origin}),[endpoint]);
 const key=JSON.stringify([endpoint,query,mode,attempt]);
 const [state,setState]=useState<{key:string;page:Page|null;phase:'loading'|'ready'|'error'|'offline'}>({key,page:null,phase:'loading'});
 useEffect(()=>{
  let active=true,ticket=0,reading=false,shown:Page|null=null,controller:AbortController|null=null;
  let expiry:ReturnType<typeof setTimeout>|null=null,renewal:ReturnType<typeof setTimeout>|null=null;
  const connectionUnavailable=()=>document.hidden||navigator.onLine===false;
  const deadline=(page:Page)=>Math.min(page.readExpiresAt,...page.items.map(item=>item.publishedUntil))*1000;
  const cancelRenewal=()=>{if(renewal)clearTimeout(renewal);renewal=null;};
  const revoke=(phase:'loading'|'error'|'offline'='loading')=>{shown=null;if(expiry)clearTimeout(expiry);expiry=null;setState({key,page:null,phase});};
  const clear=()=>{ticket++;controller?.abort();reading=false;cancelRenewal();revoke(navigator.onLine===false?'offline':'loading');};
  const read=async(quiet=false)=>{
   if(connectionUnavailable()){clear();return;}
   const retained=quiet&&shown&&deadline(shown)>Date.now();
   ticket++;controller?.abort();cancelRenewal();if(!retained)revoke();
   const current=ticket;controller=new AbortController();reading=true;
   try{
    const page=validate(query===null?await client.recommendations({mode,limit:6},{signal:controller.signal}):await client.search({query,topic:undefined,limit:3},{signal:controller.signal}));
    if(!active||current!==ticket||connectionUnavailable())return;
    shown=page;if(expiry)clearTimeout(expiry);
    setState({key,page,phase:'ready'});
    const remaining=Math.max(0,deadline(page)-Date.now());
    // The original deadline still removes the old material while renewal is
    // pending; only a newly validated response can supply the next lease.
    expiry=setTimeout(()=>{if(active&&shown===page){shown=null;expiry=null;setState({key,page:null,phase:'loading'});if(!reading)void read();}},remaining);
    renewal=setTimeout(()=>{if(active&&shown===page)void read(true);},Math.max(0,remaining-Math.min(2000,remaining/4)));
   }catch(reason){
    if(!active||current!==ticket)return;
    if(connectionUnavailable()){clear();return;}
    const denied=reason&&typeof reason==='object'&&'status'in reason&&typeof reason.status==='number'&&[401,403,404,410].includes(reason.status);
    if(!denied&&shown&&deadline(shown)>Date.now()){
     renewal=setTimeout(()=>{if(active)void read(true);},Math.min(1000,Math.max(100,(deadline(shown)-Date.now())/2)));
    }else{cancelRenewal();revoke('error');}
   }finally{if(current===ticket)reading=false;}
  };
  const resume=()=>{if(!document.hidden&&navigator.onLine!==false)void read();else clear();};
  void read();addEventListener('focus',resume);addEventListener('online',resume);addEventListener('offline',clear);document.addEventListener('visibilitychange',resume);
  return()=>{active=false;ticket++;controller?.abort();if(expiry)clearTimeout(expiry);cancelRenewal();removeEventListener('focus',resume);removeEventListener('online',resume);removeEventListener('offline',clear);document.removeEventListener('visibilitychange',resume);};
 },[client,key,query,mode]);
 const page=state.key===key&&state.page&&state.page.readExpiresAt>Date.now()/1000?state.page:null;
 return{client,page,phase:state.key===key?state.phase:'loading'};
}
const reference=(item:Item)=>({kind:item.kind,id:item.id,version:item.version});
const recommendationReference=(item:Item)=>item.recommendation?{recommendation:{requestId:item.recommendation.requestId}}:{};
const exposureKey=(item:Item)=>item.kind+item.id+item.version+':'+(item.recommendation?.requestId??'');
function PublicRow({item,navigate,onOpen,onExpose,children}:{item:Item;navigate:Props['navigate'];onOpen:()=>void;onExpose?:()=>void;children?:React.ReactNode}){
 const row=useRef<HTMLElement>(null);
 useEffect(()=>{if(!onExpose||!row.current||!globalThis.IntersectionObserver)return;const observer=new IntersectionObserver(entries=>{if(!document.hidden&&entries.some(entry=>entry.isIntersecting&&entry.intersectionRatio>=0.5))onExpose();},{threshold:0.5});observer.observe(row.current);return()=>observer.disconnect();},[onExpose]);
 if(item.publishedUntil<=Date.now()/1000)return null;
 return <article ref={row} className="content-search-row"><p className="content-search-meta">{item.kind==='reply'?'公开回复':'公开讨论'}</p><h3><a href={item.href} onClick={event=>{onOpen();if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey){event.preventDefault();navigate(item.href);}}}>{item.title||(item.kind==='reply'?'阅读这条回复':'阅读这条讨论')}</a></h3><p className="content-search-excerpt">{item.excerpt}</p>{children}</article>;
}
export function NativeCommunitySearch({endpoint,query,navigate}:Props&{query:string}){
 const [attempt,setAttempt]=useState(0),{client,page,phase}=usePublicPage(endpoint,query,'latest',attempt);
 const recorded=useRef(new Set<string>());
 useEffect(()=>{const requestId=page?.search?.requestId;if(!requestId||recorded.current.has(requestId))return;recorded.current.add(requestId);while(recorded.current.size>100)recorded.current.delete(recorded.current.values().next().value!);void client.record({name:'search',pageKey:'find',query,search:{requestId}}).catch(()=>{});},[client,query,page]);
 return <section className="content-search-group" id="search-community" aria-labelledby="search-heading-community" aria-busy={phase==='loading'}><header><h2 id="search-heading-community">社区讨论</h2><a href={'/app/community?q='+encodeURIComponent(query)} onClick={event=>{if(!event.metaKey&&!event.ctrlKey){event.preventDefault();navigate('/app/community?q='+encodeURIComponent(query));}}}>查看全部</a></header>
  {phase==='offline'?<output className="content-search-empty" role="status">暂时离线，联网后会重新查找。</output>:phase==='error'?<output className="content-search-empty">社区搜索暂时无法连接。<button type="button" onClick={()=>setAttempt(value=>value+1)}>重试</button></output>:!page?<output>正在查找…</output>:!page.items.length?<p className="content-search-empty">{page.nextAfter!==null&&page.nextAfter!==undefined?'当前读取范围未找到相符讨论，可进入社区继续查找。':'没有找到当前可读取的公开讨论。'}</p>:<div className="content-search-results">{page.items.map(item=><PublicRow key={item.kind+item.id} {...{item,navigate}} onOpen={()=>void client.record({name:'search-click',pageKey:'find',content:reference(item),...(item.search?{search:{requestId:item.search.requestId}}:{})}).catch(()=>{})}/>)}</div>}
 </section>;
}
export function PublicRecommendations({endpoint,navigate}:Props){
 const [mode,setMode]=useState<'personalized'|'latest'>('personalized'),[attempt,setAttempt]=useState(0),[excluded,setExcluded]=useState<string[]>([]),[error,setError]=useState(''),[pending,setPending]=useState<string|null>(null);
 const {client,page,phase}=usePublicPage(endpoint,null,mode,attempt),exposed=useRef(new Map<string,string>());
 function exposure(item:Item){const key=exposureKey(item);if(exposed.current.has(key))return;const exposureId=crypto.randomUUID();exposed.current.set(key,exposureId);while(exposed.current.size>100)exposed.current.delete(exposed.current.keys().next().value!);void client.record({name:'content-exposure',pageKey:'home',content:reference(item),exposureId,...recommendationReference(item)}).catch(()=>{});}
 async function negative(item:Item){if(pending)return;setPending(item.id);try{await client.record({name:'not-interested',pageKey:'home',content:reference(item),...recommendationReference(item)});setExcluded(values=>[...values,item.id]);setError('');}catch{setError('偏好暂未保存，可以稍后重试。');}finally{setPending(null);}}
 const items=page?.items.filter(item=>!excluded.includes(item.id))??[];
 return <section className="browse-section native-public-recommendations" aria-labelledby="public-recommendations-title"><header><div><h2 id="public-recommendations-title">公开讨论推荐</h2></div><div className="native-public-modes" role="group" aria-label="讨论排序"><button type="button" aria-pressed={mode==='personalized'} onClick={()=>setMode('personalized')}>推荐</button><button type="button" aria-pressed={mode==='latest'} onClick={()=>setMode('latest')}>最新</button></div></header>
  {phase==='offline'?<div className="browse-empty" role="status"><p>暂时离线，联网后会重新读取公开讨论。</p></div>:phase==='error'?<div className="browse-empty"><p>公开内容推荐暂时无法连接。</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>重新读取</button></div>:!page?<output>正在读取公开讨论…</output>:!items.length?<div className="browse-empty"><p>当前还没有可推荐的公开讨论。</p></div>:<div className="native-public-grid">{items.map(item=><PublicRow key={item.kind+item.id} {...{item,navigate}} onExpose={()=>exposure(item)} onOpen={()=>void client.record({name:'content-click',pageKey:'home',content:reference(item),...recommendationReference(item),...(exposed.current.get(exposureKey(item))?{exposureId:exposed.current.get(exposureKey(item))}:{})}).catch(()=>{})}>{item.reason&&<p className="content-search-meta">{item.reason.label}</p>}<button type="button" className="text-link" disabled={pending!==null} onClick={()=>void negative(item)}>不感兴趣</button></PublicRow>)}</div>}
  {error&&<output role="status">{error}</output>}
 </section>;
}
