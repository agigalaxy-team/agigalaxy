import React, {useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Bookmark, BookmarkCheck} from 'lucide-react';
import type {z} from 'zod/v4';
import {createReadingBookmarksClient} from './reading-bookmarks-client.mjs';
import {readingBookmarkReferenceSchema, readingBookmarkStateSchema, readingBookmarksPageSchema,
  readingBookmarkKey, readingBookmarkPath} from '../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs';
import {directoryReadingState, rememberDirectoryReading, restoreDirectoryReading} from './directory-reading-state.mjs';
import './reading-bookmarks.css';

export type ReadingBookmarkReference = z.infer<typeof readingBookmarkReferenceSchema>;
export type ReadingBookmarksRuntime = Parameters<typeof createReadingBookmarksClient>[0];
type BookmarkState = z.infer<typeof readingBookmarkStateSchema>;
type BookmarkRow = z.infer<typeof readingBookmarksPageSchema>['items'][number];
type ContextProps = {runtime: ReadingBookmarksRuntime|null; connected: boolean; subjectId?: string; onNeedIdentity?: () => void};
const titles = {'forum-post':'帖子', capsule:'方法', project:'项目', person:'人物资料'};
const kinds:ReadingBookmarkReference['kind'][]=['forum-post','capsule','project','person'];
function viewKey({runtime, connected, subjectId}:ContextProps) {
  const state = runtime?.api.snapshot();
  return JSON.stringify([runtime?.api.endpoint, connected, subjectId ?? state?.subjectId, state?.bindingId, state?.generation]);
}
const errorText = (caught:unknown) => caught instanceof Error && /[\u3400-\u9fff]/.test(caught.message)
  ? caught.message : '暂时无法核对收藏。你的选择仍保留，可以重试。';

type SaveForLaterProps = ContextProps & {reference:ReadingBookmarkReference; onChanged?:(state:BookmarkState)=>void};
export function SaveForLaterButton(props:SaveForLaterProps) {
  return <SaveForLaterSession key={viewKey(props)+':'+readingBookmarkKey(props.reference)} {...props}/>;
}
function SaveForLaterSession({runtime, connected, subjectId, reference, onNeedIdentity, onChanged}:SaveForLaterProps) {
  const client = useMemo(() => runtime && connected ? createReadingBookmarksClient(runtime,{subjectId}) : null, [runtime,connected,subjectId]);
  const [state,setState] = useState<BookmarkState|null>(null), [loading,setLoading] = useState(!!client), [pending,setPending] = useState(false), [error,setError] = useState('');
  const alive = useRef(true), working = useRef(false);
  function refresh() {
    if (!client || working.current) return;
    working.current = true;
    return client.resumePending(reference).then(()=>Promise.all([client.status(reference), client.pending()])).then(([value, records])=>{
      client.current();
      if (alive.current) {setState(value); setPending(records.some(row => readingBookmarkKey(row.command.reference) === readingBookmarkKey(reference))); setError(''); onChanged?.(value);}
    }).catch((caught:unknown)=>{if (alive.current) setError(errorText(caught));})
      .finally(()=>{working.current=false; if (alive.current) setLoading(false);});
  }
  const reread = useEffectEvent(() => {if (!document.hidden) return refresh();});
  useEffect(() => {
    alive.current=true; void reread();
    const poll=window.setInterval(()=>void reread(),15000), observe=()=>void reread();
    window.addEventListener('focus',observe); window.addEventListener('online',observe);
    return()=>{alive.current=false; window.clearInterval(poll); window.removeEventListener('focus',observe); window.removeEventListener('online',observe);};
  },[client]);
  async function change(retry=false) {
    if (!client) {onNeedIdentity?.(); return;}
    if (working.current) return; working.current=true; setLoading(true); setError('');
    try {
      if (retry) {
        const record=(await client.pending()).find(row=>readingBookmarkKey(row.command.reference)===readingBookmarkKey(reference));
        const result=await client.retry(reference);
        if (record && result?.state==='absent') await client.setSaved(reference,record.command.saved);
      } else {
        const result=await client.setSaved(reference,!(state?.saved??false));
        client.current();
        if(alive.current&&result.state==='acknowledged'){setState(result.bookmark); onChanged?.(result.bookmark);}
      }
      client.current();
    } catch (caught) {if (alive.current) setError(errorText(caught));}
    finally {working.current=false; if (alive.current) {setLoading(false); await refresh();}}
  }
  return <span className="reading-bookmark-control">
    <button type="button" className="reading-bookmark-button" aria-pressed={state?.saved??false}
      disabled={loading || pending || !client&&!onNeedIdentity} onClick={()=>void change()}>
      {state?.saved?<BookmarkCheck size={16}/>:<Bookmark size={16}/>}{loading?'正在核对…':state?.saved?'取消收藏':'收藏'}
    </button>
    {pending&&<span className="reading-bookmark-message">刚才的选择正在核对。<button type="button" disabled={loading} onClick={()=>void change(true)}>继续核对</button></span>}
    {error&&<output className="reading-bookmark-message">{error}<button type="button" disabled={loading} onClick={()=>void change(true)}>重试</button></output>}
  </span>;
}

type WorkspaceProps = ContextProps & {navigate:(path:string)=>void;search?:string};
function bookmarkKind(search:string):ReadingBookmarkReference['kind']|'' {
  const value=new URLSearchParams(search).get('kind');
  return kinds.find(kind=>kind===value)??'';
}
export function ReadingBookmarksWorkspace(props:WorkspaceProps) {
  const search=props.search??location.search,kind=bookmarkKind(search);
  return <ReadingBookmarksSession key={viewKey(props)+':'+kind} {...props} search={search} kind={kind}/>;
}
function ReadingBookmarksSession({runtime,connected,subjectId,onNeedIdentity,navigate,search,kind}:WorkspaceProps&{search:string;kind:ReadingBookmarkReference['kind']|''}) {
  const client=useMemo(()=>runtime&&connected?createReadingBookmarksClient(runtime,{subjectId}):null,[runtime,connected,subjectId]);
  const [items,setItems]=useState<BookmarkRow[]>([]), [next,setNext]=useState<string|null>(null), [busy,setBusy]=useState(!!client), [ready,setReady]=useState(false), [error,setError]=useState('');
  const snapshot=runtime?.api.snapshot(),scope=JSON.stringify(['bookmarks',runtime?.api.endpoint,subjectId??snapshot?.subjectId,snapshot?.bindingId,kind]),initial=directoryReadingState(scope);
  const alive=useRef(true), serial=useRef(0), pages=useRef(initial.depth), working=useRef(false),restoring=useRef(!!initial.anchorId);
  const confirmedChanges=useRef(new Map<string,BookmarkState>());
  function read(more=false) {
    if(!client||working.current)return;working.current=true;const ticket=++serial.current;
    return client.resumePending().then(async()=>{
      const collected:BookmarkRow[]=[], count=more?1:pages.current;let after=more?next:null,readPages=0;
      for(let index=0;index<count;index++) {
        const page=await client.query({...(kind?{kind}:{}),...(after?{after}:{}),limit:20});
        client.current();if(!alive.current||ticket!==serial.current)return null;
        collected.push(...page.items);after=page.nextAfter;readPages++;if(!after)break;
      }
      return {collected,after,readPages};
    }).then(value=>{
      if(alive.current&&ticket===serial.current&&value) {
        const {collected,after,readPages}=value;
        const checkedAt=Date.now();
        setItems(previous=>[...new Map((more?[...previous,...collected]:collected).map(item=>[readingBookmarkKey(item.reference),item])).values()]
          .filter(item=>{const change=confirmedChanges.current.get(readingBookmarkKey(item.reference));return !change||change.saved||change.revision<item.revision;})
          .map(item=>item.source.state==='available'&&item.source.availableUntil*1000<=checkedAt?{...item,source:{state:'temporarily-unavailable',reason:'source-check-failed'}}:item));
        setNext(after);setReady(true);setError('');pages.current=more?pages.current+readPages:readPages;
        rememberDirectoryReading(scope,Math.max(1,pages.current),directoryReadingState(scope).anchorId);
      }
    }).catch((caught:unknown)=>{if(alive.current&&ticket===serial.current){setItems(previous=>previous.map(item=>({...item,source:{state:'temporarily-unavailable',reason:'source-check-failed'}})));setError(errorText(caught));}})
      .finally(()=>{working.current=false;if(alive.current&&ticket===serial.current)setBusy(false);});
  }
  const refresh=useEffectEvent(()=>{if(!document.hidden)return read();});
  useEffect(()=>{
    const lifecycle=serial;alive.current=true;void refresh();const observe=()=>void refresh(),poll=window.setInterval(observe,15000);
    window.addEventListener('focus',observe);window.addEventListener('online',observe);
    return()=>{alive.current=false;lifecycle.current++;window.clearInterval(poll);window.removeEventListener('focus',observe);window.removeEventListener('online',observe);};
  },[client]);
  useLayoutEffect(()=>{if(!ready||!restoring.current)return;restoring.current=false;return restoreDirectoryReading(scope);},[ready,scope]);
  useEffect(()=>{
    const deadlines=items.flatMap(item=>item.source.state==='available'?[item.source.availableUntil*1000]:[]);if(!deadlines.length)return;
    const expire=()=>{setItems(previous=>previous.map(item=>item.source.state==='available'&&item.source.availableUntil*1000<=Date.now()?{...item,source:{state:'temporarily-unavailable',reason:'source-check-failed'}}:item));void refresh();};
    const timer=window.setTimeout(expire,Math.max(0,Math.min(...deadlines)-Date.now()));return()=>window.clearTimeout(timer);
  },[items]);
  function selectKind(value:ReadingBookmarkReference['kind']|''){
    const params=new URLSearchParams(search);if(value)params.set('kind',value);else params.delete('kind');
    navigate('/app/bookmarks'+(params.size?'?'+params.toString():''));
  }
  function open(item:BookmarkRow,path:string){
    rememberDirectoryReading(scope,Math.max(1,pages.current),'directory-bookmarks-'+item.id);navigate(path);
  }
  function onChanged(value:BookmarkState){
    const key=readingBookmarkKey(value.reference),prior=confirmedChanges.current.get(key);
    if(!prior||value.revision>=prior.revision)confirmedChanges.current.set(key,value);
    if(!value.saved)setItems(previous=>previous.filter(item=>readingBookmarkKey(item.reference)!==readingBookmarkKey(value.reference)));
  }
  return <section className="reading-bookmarks-page"><header><p className="eyebrow">稍后回看</p><h1>我的收藏</h1><p>收藏只对你可见，方便稍后回看。</p></header>
    {!client?<div className="reading-bookmarks-empty"><p>使用本人的身份后，可以在不同设备回看这些收藏。</p><button type="button" onClick={onNeedIdentity} disabled={!onNeedIdentity}>使用我的身份</button></div>:<>
      <nav className="reading-bookmarks-kinds" aria-label="收藏内容"><button type="button" aria-pressed={!kind} onClick={()=>selectKind('')}>全部</button>{kinds.map(value=><button type="button" key={value} aria-pressed={kind===value} onClick={()=>selectKind(value)}>{titles[value]}</button>)}</nav>
      {error&&<p className="message error" role="alert">{error}<button type="button" disabled={busy} onClick={()=>{setBusy(true);void read();}}>重新读取</button></p>}
      {!ready&&busy&&<output>正在读取收藏…</output>}{ready&&!items.length&&!error&&<p className="reading-bookmarks-empty">这里还没有{kind?titles[kind]:''}收藏。看到想稍后再读的内容时，点“收藏”即可。</p>}
      <ol className="reading-bookmarks-list">{items.map(item=>{
        const source=item.source, available=source.state==='available';
        const path=readingBookmarkPath(item.reference);
        return <li key={readingBookmarkKey(item.reference)} id={'directory-bookmarks-'+item.id}><div className="reading-bookmark-content"><p className="reading-bookmark-kind">{titles[item.reference.kind]} · {item.savedAt?new Date(item.savedAt).toLocaleDateString('zh-CN'):''}</p>
          {available&&source.state==='available'?<><h2><a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();open(item,path);}}}>{source.title}</a></h2><p className="reading-bookmark-summary">{source.summary}</p></>:<><h2>收藏的{titles[item.reference.kind]}</h2><p>{source.state==='temporarily-unavailable'?'暂时无法核对来源。':source.state==='unavailable'&&source.reason==='source-withdrawn'?'作者已撤回这份内容。':source.state==='unavailable'&&source.reason==='source-expired'?'本次可读期限已结束。':'这份来源当前不可读取。'}引用仍保留。</p></>}
        </div><SaveForLaterButton runtime={runtime} connected={connected} subjectId={subjectId} reference={item.reference} onNeedIdentity={onNeedIdentity} onChanged={onChanged}/></li>;
      })}</ol>{next&&<button className="load-more" type="button" disabled={busy} onClick={()=>{setBusy(true);void read(true);}}>{busy?'正在读取…':'更早的收藏'}</button>}
    </>}
  </section>;
}
