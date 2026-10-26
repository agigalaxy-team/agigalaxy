import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {initialPublicReadingPage,isPublicReadingRoute,loadPublicReadingPage,loadPublicReadingRoutes} from './contract.mjs';
import {attachCopyTarget,copyStatusText} from '../../../../../apps/galaxy-site/interaction-copy.mjs';
import './workspace.css';

export {isPublicReadingRoute} from './contract.mjs';
type Node=string|{tag:string;attrs:Record<string,string>;children:Node[]};
type Page={path:string;title:string;description:string;location:string;sidebar:Node[];body:Node[];footer:Node[]};
type Props={path:string;search?:string;hash?:string;navigate:(target:string)=>void};
const propertyNames:Record<string,string>={class:'className',tabindex:'tabIndex',viewbox:'viewBox','stroke-width':'strokeWidth','stroke-linecap':'strokeLinecap','stroke-linejoin':'strokeLinejoin'};
const nodeText=(nodes:Node[]):string=>nodes.map(node=>typeof node==='string'?node:nodeText(node.children)).join('');
function ReadingCode({attributes,children,text,scope,instanceId}:{attributes:Record<string,unknown>;children:React.ReactNode;text:string;scope:string;instanceId:string}){
  const pre=useRef<HTMLPreElement>(null),button=useRef<HTMLButtonElement>(null),copy=useRef<ReturnType<typeof attachCopyTarget>|null>(null);
  const [status,setStatus]=useState<keyof typeof copyStatusText>('idle');
  useLayoutEffect(()=>{
    if(!button.current||!pre.current)return;
    const target=attachCopyTarget({scope,instanceId,trigger:button.current,content:pre.current,onStatus:setStatus});copy.current=target;
    return()=>{if(copy.current===target)copy.current=null;target.dispose();};
  },[text,scope,instanceId]);
  const command=React.Children.toArray(children).some(child=>React.isValidElement<{className?:string}>(child)&&/language-(?:bash|sh|shell|powershell|ps1|cmd|console)\b/i.test(child.props.className??''));
  return <div className="guide-code-block"><div className="guide-code-actions"><button ref={button} type="button" className="guide-code-copy" onClick={()=>void copy.current?.copy()}>{command?'复制命令':'复制内容'}</button><output className="guide-code-status"  aria-live="polite">{copyStatusText[status]}</output></div><pre {...attributes} ref={pre}>{children}</pre></div>;
}
function content(nodes:Node[],scope:string,position:{region:string;next:number}):React.ReactNode{return nodes.map((node,index)=>{
  if(typeof node==='string')return node;
  const props:Record<string,unknown>={key:index};
  for(const [name,value] of Object.entries(node.attrs))props[propertyNames[name]??name]=name==='download'&&value===''?true:value;
  const instanceId=node.tag==='pre'?position.region+':'+position.next++:'';
  const children=node.children.length?content(node.children,scope,position):null;
  if(node.tag==='pre'){const {key:_key,...attributes}=props;return <ReadingCode key={index} attributes={attributes} text={nodeText(node.children)} scope={scope} instanceId={instanceId}>{children}</ReadingCode>;}
  return node.tag==='img'?React.createElement(node.tag,props):React.createElement(node.tag,props,children);
});}

/** Public content is rendered from a checked tree, never executable HTML. */
export function PublicReadingWorkspace({path,search='',hash='',navigate}:Props){
  const [state,setState]=useState<{path:string;page:Page|null;error:string}>(()=>({path,page:initialPublicReadingPage(path),error:''}));
  const [attempt,setAttempt]=useState(0),container=useRef<HTMLDivElement>(null);
  const current=state.path===path?state.page:null;
  useEffect(()=>{
    void loadPublicReadingRoutes();
    const controller=new AbortController();let active=true;
    void loadPublicReadingPage(path,{signal:controller.signal}).then(page=>{if(active)setState({path,page,error:''});},()=>{if(active)setState({path,page:null,error:'这份说明暂时无法读取，可以重试或返回原来的页面。'});});
    return()=>{active=false;controller.abort();};
  },[path,attempt]);
  useLayoutEffect(()=>{
    if(!current)return;
    document.title=current.title;
    const description=document.querySelector('meta[name="description"]');if(description)description.setAttribute('content',current.description);
    let anchor:string;try{anchor=decodeURIComponent(hash.slice(1));}catch{anchor='';}
    const timer=requestAnimationFrame(()=>{
      if(typeof history.state?.scrollY==='number')window.scrollTo(0,history.state.scrollY);
      else if(anchor){const target=document.getElementById(anchor);if(target&&container.current?.contains(target))target.scrollIntoView({block:'start'});}
    });
    return()=>cancelAnimationFrame(timer);
  },[current,path,search,hash]);
  const follow=(event:React.MouseEvent<HTMLDivElement>)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;
    if(!(anchor instanceof HTMLAnchorElement)||anchor.hasAttribute('download')||anchor.target&&anchor.target!=='_self')return;
    const target=new URL(anchor.href,location.href);
    if(target.origin!==location.origin||!(target.pathname==='/app'||target.pathname.startsWith('/app/')||isPublicReadingRoute(target.pathname)))return;
    event.preventDefault();navigate(target.pathname+target.search+target.hash);
  };
  if(!current)return <section className="public-reading-unavailable"><h1>{state.path===path&&state.error?'暂时无法打开这份说明':'正在打开说明'}</h1>{state.path===path&&state.error?<><p>{state.error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>重新读取</button></>:<output>正在读取本页内容…</output>}</section>;
  // Native links keep their keyboard behavior; this container only delegates their navigation clicks.
  // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
  return <div className="public-reading-page" ref={container} onClick={follow} data-public-page={current.path}>
    <div className="public-page-layout">{content(current.sidebar,location.pathname,{region:'sidebar',next:0})}<div className="public-page-content">{content(current.body,location.pathname,{region:'body',next:0})}</div></div>
    {content(current.footer,location.pathname,{region:'footer',next:0})}
  </div>;
}
