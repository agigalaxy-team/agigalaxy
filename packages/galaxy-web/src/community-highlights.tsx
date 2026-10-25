import {forumBodyExcerpt} from './community-forum-browse.mjs';
import { ReadingDetails, ReadingSummary, ReadingSurface } from './reading-details';
import React,{useEffect,useState} from 'react';
import {Search} from 'lucide-react';
import {availableForumContent,type ForumCardView,type ForumPostView} from './community-forum-view-types';
import {forumVersionPath} from './community-forum-origin.mjs';
import {forumTopics} from '../../galaxy-official/src/shared/community-forum-topics-v1.mjs';
import type {createWebRuntime} from './runtime.mjs';
import {MemberLink,useMemberNames,memberName} from './conversation-ui';
import {ContentCover,contentCoverFromLinks,EmptyContent,type ContentImage} from './community-content-visuals';
import {communityBrowsePath,communitySelection,type CommunityFormat} from './community-navigation';
import {externalCommunityCovers,externalCommunityCoverCredits} from './community-external-covers';
type Props={runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void};
export function CommunityHighlights({runtime,navigate}:Props){
 const [items,setItems]=useState<ForumPostView[]>([]),[state,setState]=useState(()=>globalThis.navigator?.onLine===false?'offline':'loading'),[attempt,setAttempt]=useState(0),[now,setNow]=useState(()=>Date.now()/1000);
 useEffect(()=>{let active=true,working=false;
  const read=async()=>{if(!runtime||working||navigator.onLine===false)return;working=true;setState(value=>value==='offline'||value==='unavailable'?'loading':value);try{const page:{items:ForumPostView[]}=await runtime.api.call('/v2/community/posts/query',{limit:3,order:'published'},{authenticated:false});if(active){setItems(page.items);setNow(Date.now()/1000);setState('ready');}}catch{if(active){setItems([]);setState('error');}}finally{working=false;}};
  const offline=()=>{if(active)setState(value=>value==='loading'?'offline':value);};
  const resume=()=>{if(document.hidden)return;if(navigator.onLine===false){offline();return;}if(!runtime){setState(value=>value==='offline'?'unavailable':value);return;}void read();};
  if(navigator.onLine===false)offline();else void read();
  const timer=window.setInterval(resume,30000);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);window.addEventListener('offline',offline);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);window.removeEventListener('offline',offline);};
 },[runtime,attempt]);
 const deadline=Math.min(...items.flatMap(item=>typeof item.publishedUntil==='number'&&item.publishedUntil>now?[item.publishedUntil]:[]));
 useEffect(()=>{if(!Number.isFinite(deadline))return;const timer=window.setTimeout(()=>setNow(Date.now()/1000),Math.min(2147483647,Math.max(0,deadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[deadline]);
 const available=items.filter(item=>availableForumContent(item,now));
 const names=useMemberNames(runtime,undefined,false,available.flatMap(item=>item.authorId?[item.authorId]:[]));
 const link=(path:string,children:React.ReactNode)=><a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{children}</a>;
 return <section className="browse-section browse-section-community" aria-labelledby="browse-community"><header><div><h2 id="browse-community">社区里正在聊</h2><p>作品、想法与日常，都可以从一段交流开始。</p></div>{link('/app/community',<>查看全部</>)}</header>
  {state==='offline'?<output className="browse-loading">暂时离线，公开讨论尚未加载。</output>:state==='unavailable'?<div className="browse-empty"><p>公开讨论暂时无法连接。</p></div>:state==='loading'?<output className="browse-loading">正在读取公开讨论…</output>:state==='error'?<div className="browse-empty"><p>暂时没有读到公开讨论。</p><button onClick={()=>{setState('loading');setAttempt(value=>value+1);}}>重新读取</button></div>:available.length?<div className="browse-highlights">{available.map(item=><article className="browse-highlight browse-discussion" key={item.locator.postId}><div className="browse-discussion-byline"><MemberLink subjectId={item.authorId??undefined} name={item.authorId?memberName(item.authorId,undefined,names[item.authorId]??undefined):item.author?.displayName?.trim()||(item.author?.uid?'银河账户 · '+item.author.uid:'银河账户')} navigate={navigate} avatar/><span>{forumTopics.find(topic=>topic.id===item.topic)?.label??'未分类'}</span></div><h3>{link(forumVersionPath(item.locator.postId,item.locator.versionId??item.currentVersionId)??'/app/community',<>{item.payload!.title}</>)}</h3><p className="browse-highlight-summary">{forumBodyExcerpt(item.payload!.body)}</p></article>)}</div>:<EmptyContent kind="post" title="第一段交流，从这里开始" description="当前还没有公开讨论。先看看主题，或分享自己正在做的事。" action={link('/app/community',<>浏览社区主题</>)}/>}
 </section>;
}

type ExternalReading={id:string;title:string;summary:string;source:string;url:string;topic:string;format:Exclude<CommunityFormat,'all'>;keywords:string[];image?:ContentImage};
/** Independent short summaries of the public pages observed on 2026-10-13. No Galaxy activity is implied. */
export const communityExternalReadings:readonly ExternalReading[]=[
 {id:'webb-pillars',title:'韦布镜头里的创生之柱',summary:'从近红外影像辨认气体、尘埃与正在形成的恒星，看看这片恒星诞生区域。',source:'NASA Science',url:'https://science.nasa.gov/asset/webb/pillars-of-creation-nircam-image/',topic:'learning',format:'article',keywords:['科学','天文','影像'],image:externalCommunityCovers['webb-pillars']},
 {id:'navigation-api',title:'Navigation API：让网页导航与历史接续',summary:'从导航事件、历史条目与状态出发，理解单页应用如何处理前进、后退和页面切换。',source:'MDN Web Docs',url:'https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API',topic:'technology',format:'method',keywords:['编程','网页','JavaScript']},
 {id:'alice',title:'重读《爱丽丝梦游仙境》',summary:'进入刘易斯·卡罗尔的经典英文原作；原站提供在线阅读与多种电子书格式。',source:'Project Gutenberg',url:'https://www.gutenberg.org/ebooks/11',topic:'learning',format:'work',keywords:['文学','阅读','书籍'],image:externalCommunityCovers.alice},
 {id:'bbscope',title:'bbScope：从更多角度观察电路板',summary:'一个为数字显微镜增加旋转光学视角的项目，原页介绍结构、材料与装配过程。',source:'Hackaday.io · RealCorebb',url:'https://hackaday.io/project/206957-bbscope-3d-multi-angle-rotating-inspection-micros',topic:'technology',format:'work',keywords:['硬件','显微镜','开源']},
];

function ReadingLink({target,navigate,children,...props}:{target:string;navigate:(path:string)=>void;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){
 return <a {...props} href={target} onClick={event=>{if(target.startsWith('/app/')&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target);}}}>{children}</a>;
}

function ExternalCoverCredit({id}:{id:string}){
 const credit=externalCommunityCoverCredits[id];if(!credit)return null;
 return <ReadingDetails className="forum-image-credit"><ReadingSummary>{id==='alice'?'配图：Tenniel · Gutenberg':'配图：NASA / ESA / CSA / STScI'}</ReadingSummary><p>{credit.credit}</p><p><a href={credit.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">图片出处</a><span> · </span><a href={credit.licenseUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{credit.license}</a></p></ReadingDetails>;
}

export function filterExternalReadings(topic:string,query:string,format:CommunityFormat='all'){
 const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
 return communityExternalReadings.filter(item=>(!topic||item.topic===topic)&&(format==='all'||item.format===format)&&terms.every(term=>[item.title,item.summary,item.source,...item.keywords].join(' ').toLocaleLowerCase().includes(term)));
}

function readFollowedChannels(key:string):string[]{
 try{const value:unknown=JSON.parse(localStorage.getItem(key)??'[]');return Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'&&forumTopics.some(topic=>topic.id===id)))]:[];}catch{return[];}
}

type ChannelSidebarProps={runtime:Props['runtime'];subjectId?:string;navigate:(path:string)=>void;posts?:ForumCardView[];source?:'galaxy'|'external'};
export function CommunityReadingSidebar(props:ChannelSidebarProps){
 const preferenceKey='galaxy-community-channels-v1:'+(props.runtime?.api.endpoint??'public')+':'+(props.subjectId??'visitor');
 return <CommunityReadingSidebarView key={preferenceKey} {...props} preferenceKey={preferenceKey}/>;
}
function CommunityReadingSidebarView({preferenceKey,navigate,posts=[],source='galaxy'}:ChannelSidebarProps&{preferenceKey:string}){
 const [followed,setFollowed]=useState(()=>readFollowedChannels(preferenceKey)),[editing,setEditing]=useState(false),[storageNote,setStorageNote]=useState('');
 const [now,setNow]=useState(()=>Date.now()/1000);
 useEffect(()=>{const deadline=Math.min(...posts.flatMap(post=>typeof post.publishedUntil==='number'&&post.publishedUntil>now?[post.publishedUntil]:[]));if(!Number.isFinite(deadline))return;const timer=window.setTimeout(()=>setNow(Date.now()/1000),Math.min(2147483647,Math.max(0,deadline*1000-Date.now()+1)));return()=>window.clearTimeout(timer);},[posts,now]);
 const toggle=(id:string)=>{
  const next=followed.includes(id)?followed.filter(value=>value!==id):[...followed,id];setFollowed(next);
  try{localStorage.setItem(preferenceKey,JSON.stringify(next));setStorageNote('');}catch{setStorageNote('当前无法保存到此浏览器，切换或关闭页面后可能需要重新选择。');}
 };
 const visiblePosts=posts.filter(item=>availableForumContent(item,now)).slice(0,3);
 return <aside className="forum-community-aside" aria-label="频道与内容选读">
  <section className="forum-followed-channels"><header><h2>关注的频道</h2><button type="button" aria-haspopup="dialog" onClick={()=>setEditing(true)}>管理</button></header><p className="forum-aside-note">仅保存在此浏览器</p>
   {followed.length?<nav aria-label="已关注频道">{followed.map(id=>{const topic=forumTopics.find(item=>item.id===id)!;return <ReadingLink key={id} target={communityBrowsePath({topic:id,source})} navigate={navigate}><strong>{topic.label}</strong><span>{topic.description}</span></ReadingLink>;})}</nav>:<div className="forum-followed-empty"><p>还没有关注的频道。</p><button type="button" onClick={()=>setEditing(true)}>选择感兴趣的频道</button></div>}
   <ReadingSurface open={editing} title="关注的频道" onClose={()=>setEditing(false)}><fieldset className="forum-channel-choices"><legend>选择关注的频道</legend>{forumTopics.map(topic=><label key={topic.id}><input type="checkbox" checked={followed.includes(topic.id)} onChange={()=>toggle(topic.id)}/><span>{topic.label}</span></label>)}</fieldset><p className="forum-aside-note">选择即时保存在此浏览器。</p></ReadingSurface>
   {storageNote&&<output className="forum-aside-note">{storageNote}</output>}
  </section>
  {visiblePosts.length>0&&<section className="forum-aside-readings"><h2>近期讨论</h2>{visiblePosts.map(post=><ReadingLink key={post.locator.postId} target={forumVersionPath(post.locator.postId,('versionId'in post.locator?post.locator.versionId:null)??post.currentVersionId)??'/app/community'} navigate={navigate}><ContentCover image={contentCoverFromLinks(post.payload?.links??[],post.payload?.title??'')} compact/><span><strong>{post.payload?.title}</strong><small>{forumTopics.find(topic=>topic.id===post.topic)?.label??'未分类'} · 银河讨论</small></span></ReadingLink>)}</section>}
  <section className="forum-aside-readings"><h2>外部选读</h2>{communityExternalReadings.slice(0,3).map(item=><a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ContentCover image={item.image} compact/><span><strong>{item.title}</strong><small>{item.source}</small></span></a>)}<ReadingLink target={communityBrowsePath({source:'external'})} navigate={navigate} className="forum-aside-all">浏览外部精选</ReadingLink><p className="forum-aside-note">独立摘要，原文保留出处。</p>{communityExternalReadings.slice(0,3).filter(item=>item.image).map(item=><ExternalCoverCredit key={item.id} id={item.id}/>)}</section>
 </aside>;
}

export function CommunityExternalWorkspace({runtime,subjectId,navigate,routeSearch=''}:Props&{subjectId?:string;routeSearch?:string}){
 const {topic,query,format}=communitySelection(routeSearch),[search,setSearch]=useState(query),selection=forumTopics.find(item=>item.id===topic);
 const formatName=({all:'外部精选',work:'精选作品',method:'精选方法',article:'精选文章'})[format];
 const title=query?`“${query}”的搜索结果`:selection?.label??(topic==='unclassified'?'未分类精选':formatName);
 const description=query?'搜索范围：'+['外部精选',selection?.label??(topic==='unclassified'?'未分类':''),format!=='all'?formatName:''].filter(Boolean).join(' · '):topic||format!=='all'?`${formatName}，打开原站阅读。`:'从公开文章、作品与方法中选读。';
 const target=(changes:{topic?:string;query?:string;format?:CommunityFormat}={})=>communityBrowsePath({source:'external',topic,query,format,...changes});
 const readings=filterExternalReadings(topic,query,format);
 return <section className="forum-workspace forum-discovery forum-external-workspace">
  <div className="forum-heading"><div><h1 className="small" style={{overflowWrap:'anywhere'}}>{title}</h1><p>{description}</p></div></div>
  <nav className="forum-tabs" aria-label="社区内容"><ReadingLink target={communityBrowsePath({topic,query})} navigate={navigate}>银河讨论</ReadingLink><ReadingLink target={target()} navigate={navigate} aria-current="page" className="active">外部精选</ReadingLink></nav>
  <div className="forum-discovery-layout"><section className="forum-results" aria-label="外部精选内容">
   <div className="forum-feed-toolbar"><span className="forum-order-label">编辑选读</span><nav className="forum-formats" aria-label="精选内容形式">{([['all','全部'],['work','作品'],['method','方法'],['article','文章']] as const).map(([id,label])=><ReadingLink key={id} target={target({format:id})} navigate={navigate} aria-current={format===id?'page':undefined}>{label}</ReadingLink>)}</nav></div>
   <search><form className="forum-search" onSubmit={event=>{event.preventDefault();navigate(target({query:search}));}}><label><span className="forum-search-label">搜索外部精选</span><input type="search" aria-label="搜索外部精选" maxLength={160} value={search} onChange={event=>setSearch(event.target.value)} placeholder={selection?'在'+selection.label+'中搜索':'搜索外部精选的标题与摘要'}/></label><button type="submit"><Search size={16} aria-hidden/><span>搜索</span></button></form></search>
   {(topic||query)&&<div className="forum-search-context"><ReadingLink target={target({topic:'',query:''})} navigate={navigate}>清除筛选</ReadingLink></div>}
   <p className="forum-source-note">外部公开内容 · 独立摘要 · 打开原站阅读，不是银河成员帖子</p>
   <div className="forum-feed forum-external-feed">{readings.map(item=><article className="forum-card forum-content-row" key={item.id}><ContentCover image={item.image} href={item.url}/><div className="forum-card-copy"><h2><a href={item.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{item.title}</a></h2><p className="forum-excerpt">{item.summary}</p><div className="forum-meta"><span className="forum-external-source">{item.source}</span><span>{forumTopics.find(value=>value.id===item.topic)?.label}</span><span>{({work:'作品',method:'方法',article:'文章'})[item.format]}</span></div><ExternalCoverCredit id={item.id}/></div></article>)}</div>
   {!readings.length&&<div className="forum-result-empty"><h2>这里暂时没有相符的外部精选</h2><p>试试其他频道或关键词，也可以清除筛选。</p><ReadingLink target={communityBrowsePath({source:'external'})} navigate={navigate}>浏览全部外部精选</ReadingLink></div>}
  </section><CommunityReadingSidebar key={(runtime?.api.endpoint??'')+':'+(subjectId??'visitor')} runtime={runtime} subjectId={subjectId} navigate={navigate} source="external"/></div>
 </section>;
}
