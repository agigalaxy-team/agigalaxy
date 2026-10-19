import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {initialPublicReadingPage,isPublicReadingRoute,loadPublicReadingPage} from './public-reading-contract.mjs';
import './public-reading.css';

export {isPublicReadingRoute} from './public-reading-contract.mjs';
type Node=string|{tag:string;attrs:Record<string,string>;children:Node[]};
type Page={path:string;title:string;description:string;location:string;sidebar:Node[];body:Node[];footer:Node[]};
type Props={path:string;search?:string;hash?:string;navigate:(target:string)=>void};
const propertyNames:Record<string,string>={class:'className',tabindex:'tabIndex',viewbox:'viewBox','stroke-width':'strokeWidth','stroke-linecap':'strokeLinecap','stroke-linejoin':'strokeLinejoin'};
const nodeText=(nodes:Node[]):string=>nodes.map(node=>typeof node==='string'?node:nodeText(node.children)).join('');
type GuideCopyState={path:string;exactText:string;status:''|'已复制'|'已选中，请复制'|'请选中文字复制';focused:boolean};
const guideCopyHost=globalThis as typeof globalThis&{__GALAXY_GUIDE_COPY__?:GuideCopyState};
const matchingCopy=(text:string)=>{const value=guideCopyHost.__GALAXY_GUIDE_COPY__;return value?.path===location.pathname&&value.exactText===text?value:null;};
const backgroundFocus=()=>!document.activeElement||document.activeElement===document.body||document.activeElement===document.documentElement;
function ReadingCode({attributes,children,text}:{attributes:Record<string,unknown>;children:React.ReactNode;text:string}){
  const pre=useRef<HTMLPreElement>(null),button=useRef<HTMLButtonElement>(null),[status,setStatus]=useState(()=>matchingCopy(text)?.status??'');
  useLayoutEffect(()=>{
    const resume=()=>{
      const value=matchingCopy(text);setStatus(value?.status??'');
      if(!value?.focused||!button.current||!(backgroundFocus()||document.activeElement===button.current))return;
      button.current.focus({preventScroll:true});
      if(value.status==='已选中，请复制'&&pre.current){const selection=window.getSelection();if(selection){const range=document.createRange();range.selectNodeContents(pre.current);selection.removeAllRanges();selection.addRange(range);}}
    };
    resume();window.addEventListener('galaxy:guide-copy',resume);return()=>window.removeEventListener('galaxy:guide-copy',resume);
  },[text]);
  const command=React.Children.toArray(children).some(child=>React.isValidElement<{className?:string}>(child)&&/language-(?:bash|sh|shell|powershell|ps1|cmd|console)\b/i.test(child.props.className??''));
  async function copy(){
    const element=pre.current;if(!element)return;
    const value:GuideCopyState={path:location.pathname,exactText:element.textContent??'',status:'',focused:document.activeElement===button.current};
    guideCopyHost.__GALAXY_GUIDE_COPY__=value;window.dispatchEvent(new Event('galaxy:guide-copy'));
    const finish=(next:GuideCopyState['status'])=>{
      if(guideCopyHost.__GALAXY_GUIDE_COPY__!==value||location.pathname!==value.path)return;
      value.focused=document.activeElement===button.current||(value.focused&&!button.current?.isConnected&&backgroundFocus());value.status=next;window.dispatchEvent(new Event('galaxy:guide-copy'));
    };
    try{await navigator.clipboard.writeText(value.exactText);finish('已复制');}
    catch{finish(window.getSelection()?'已选中，请复制':'请选中文字复制');}
  }
  return <div className="guide-code-block"><div className="guide-code-actions"><button ref={button} type="button" className="guide-code-copy" onClick={()=>void copy()} onBlur={event=>{if(event.relatedTarget instanceof Element){const value=matchingCopy(text);if(value)value.focused=false;}}}>{command?'复制命令':'复制内容'}</button><span className="guide-code-status" role="status" aria-live="polite">{status}</span></div><pre {...attributes} ref={pre}>{children}</pre></div>;
}
function content(nodes:Node[]):React.ReactNode{return nodes.map((node,index)=>{
  if(typeof node==='string')return node;
  const props:Record<string,unknown>={key:index};
  for(const [name,value] of Object.entries(node.attrs))props[propertyNames[name]??name]=name==='download'&&value===''?true:value;
  const children=node.children.length?content(node.children):null;
  if(node.tag==='pre'){const {key:_key,...attributes}=props;return <ReadingCode key={index} attributes={attributes} text={nodeText(node.children)}>{children}</ReadingCode>;}
  return React.createElement(node.tag,props,children);
});}

/** Public content is rendered from a checked tree, never executable HTML. */
export function PublicReadingWorkspace({path,search='',hash='',navigate}:Props){
  const [state,setState]=useState<{path:string;page:Page|null;error:string}>(()=>({path,page:initialPublicReadingPage(path),error:''}));
  const [attempt,setAttempt]=useState(0),container=useRef<HTMLDivElement>(null);
  const current=state.path===path?state.page:null;
  useEffect(()=>{
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
    <div className="public-page-layout">{content(current.sidebar)}<div className="public-page-content">{content(current.body)}</div></div>
    {content(current.footer)}
  </div>;
}
