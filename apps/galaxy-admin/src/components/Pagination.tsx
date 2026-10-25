'use client';

import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {paginationJumpTarget,paginationPageNumbers} from '../lib/pagination-model';
import './pagination.css';

export type PaginationProps={
  page:number;
  pageSize:number;
  total:number|null;
  totalPages:number|null;
  hasPrevious:boolean;
  hasNext:boolean;
  onPage:(page:number)=>void;
  onPageSize:(pageSize:number)=>void;
  pageSizeOptions?:readonly number[];
  pageHref?:(page:number)=>string;
  /** A page is being read. Navigation waits; choosing another page size remains available. */
  loading?:boolean;
  /** The caller cannot permit any pagination change, including a page-size change. */
  disabled?:boolean;
  showNavigation?:boolean;
  showTotal?:boolean;
  layout?:'inline'|'stacked';
  ariaLabel?:string;
  unitLabel?:string;
  className?:string;
  /** Optional caller-owned identity/source boundary for this instance's explicit paging focus. */
  focusScope?:string|null;
  /** The requested page has been freshly read within that boundary. */
  focusReady?:boolean;
  children?:ReactNode;
};

type PagingControl='previous'|'next'|'page'|'jump'|'jump-input';
type PagingFocus={scope:string;target:number;control:PagingControl;origin:HTMLElement;stop:()=>void};

const defaultPageSizes=[20,30,50,100] as const;

export function Pagination({page,pageSize,total,totalPages,hasPrevious,hasNext,onPage,onPageSize,pageSizeOptions=defaultPageSizes,pageHref,loading=false,disabled=false,showNavigation=true,showTotal=true,layout='inline',ariaLabel='列表分页',unitLabel='条',className,focusScope,focusReady=false,children}:PaginationProps){
  const [jump,setJump]=useState(String(page));
  const rootRef=useRef<HTMLElement>(null),previousRef=useRef<HTMLButtonElement>(null),nextRef=useRef<HTMLButtonElement>(null),jumpRef=useRef<HTMLInputElement>(null),jumpButtonRef=useRef<HTMLButtonElement>(null);
  const pageRefs=useRef(new Map<number,HTMLElement>()),pendingFocus=useRef<PagingFocus|null>(null);
  useEffect(()=>{setJump(String(page));},[page]);

  const exactTotal=total!==null&&Number.isSafeInteger(total)&&total>=0?total:null;
  const exactPages=totalPages!==null&&Number.isSafeInteger(totalPages)&&totalPages>=0?totalPages:null;
  const locked=loading||disabled;
  const previousAvailable=hasPrevious&&page>1&&(exactPages===null||page-1<=exactPages);
  const nextAvailable=hasNext&&(exactPages===null||page<exactPages);
  const pages=exactPages===null?[]:paginationPageNumbers(page,exactPages);

  function clearFocus(){
    const pending=pendingFocus.current;pendingFocus.current=null;pending?.stop();
  }
  function rememberFocus(target:number,control:PagingControl,origin?:HTMLElement){
    clearFocus();
    if(!focusScope||!focusReady||!origin||!rootRef.current?.contains(origin)||origin.ownerDocument.activeElement!==origin)return;
    const doc=origin.ownerDocument;
    // A later user focus or click owns its destination, even if focus returns to BODY.
    const onFocus=(event:FocusEvent)=>{if(event.target!==origin&&event.target!==doc.body)clearFocus();};
    const onPointer=(event:PointerEvent)=>{if(event.target instanceof Node&&!origin.contains(event.target))clearFocus();};
    doc.addEventListener('focusin',onFocus,true);doc.addEventListener('pointerdown',onPointer,true);
    pendingFocus.current={scope:focusScope,target,control,origin,stop:()=>{doc.removeEventListener('focusin',onFocus,true);doc.removeEventListener('pointerdown',onPointer,true);}};
  }
  function go(target:number,control:PagingControl='page',origin?:HTMLElement){
    if(locked||!Number.isSafeInteger(target)||target<1||target===page||exactPages!==null&&target>exactPages)return;
    rememberFocus(target,control,origin);
    onPage(target);
  }
  useLayoutEffect(()=>{
    const pending=pendingFocus.current;if(!pending)return;
    if(!focusScope||pending.scope!==focusScope){clearFocus();return;}
    if(!focusReady||locked||!showNavigation)return;
    if(page!==pending.target){clearFocus();return;}
    const doc=pending.origin.ownerDocument;
    const available=(element:HTMLElement|null|undefined)=>element?.isConnected&&!element.hasAttribute('disabled')&&element.getAttribute('aria-disabled')!=='true'?element:null;
    const preferred=pending.control==='previous'?previousRef.current:pending.control==='next'?nextRef.current:pending.control==='jump'?jumpButtonRef.current:pending.control==='jump-input'?jumpRef.current:pageRefs.current.get(page);
    const target=available(preferred)??available(pageRefs.current.get(page))??available(previousRef.current)??available(nextRef.current)??available(jumpRef.current);
    clearFocus();
    if(doc.activeElement===doc.body)target?.focus({preventScroll:true});
  },[focusScope,focusReady,locked,page,showNavigation]);
  useLayoutEffect(()=>()=>clearFocus(),[]);

  return <nav ref={rootRef} className={['galaxy-pagination',className].filter(Boolean).join(' ')} aria-label={ariaLabel} aria-busy={loading||undefined} data-layout={layout}>
    <div className="galaxy-pagination-options">
      {showTotal&&exactTotal!==null&&<span className="galaxy-pagination-total">共 {exactTotal.toLocaleString('zh-CN')} {unitLabel}</span>}
      <label>每页 <select aria-label="每页条数" value={pageSize} disabled={disabled} onChange={event=>{
        const size=Number(event.target.value);
        if(!disabled&&pageSizeOptions.includes(size)&&size!==pageSize)onPageSize(size);
      }}>{pageSizeOptions.map(size=><option key={size} value={size}>{size} {unitLabel}</option>)}</select></label>
      {children}
      {showNavigation&&(exactPages===null||exactPages>0)&&<span className="galaxy-pagination-current">第 {page.toLocaleString('zh-CN')} 页{exactPages!==null&&<> / 共 {exactPages.toLocaleString('zh-CN')} 页</>}</span>}
    </div>
    {showNavigation&&<div className="galaxy-pagination-navigation">
      <div className="galaxy-pagination-links">
        <button type="button" disabled={locked||!previousAvailable} ref={previousRef} onClick={event=>go(page-1,'previous',event.currentTarget)}>上一页</button>
        {pages.map((item,index)=>item===null?<span className="galaxy-pagination-gap" key={'gap'+index} aria-hidden="true">…</span>:pageHref?<Link key={item} ref={element=>{if(element)pageRefs.current.set(item,element);else pageRefs.current.delete(item);}} href={pageHref(item)} scroll={false} prefetch={false} aria-label={'第 '+item+' 页'} aria-current={page===item?'page':undefined} aria-disabled={locked||undefined} onClick={event=>{if(locked||item===page)event.preventDefault();else if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey)rememberFocus(item,'page',event.currentTarget);}} onAuxClick={event=>{if(locked)event.preventDefault();}}>{item.toLocaleString('zh-CN')}</Link>:<button key={item} ref={element=>{if(element)pageRefs.current.set(item,element);else pageRefs.current.delete(item);}} type="button" aria-label={'第 '+item+' 页'} aria-current={page===item?'page':undefined} disabled={locked} onClick={event=>go(item,'page',event.currentTarget)}>{item.toLocaleString('zh-CN')}</button>)}
        <button type="button" disabled={locked||!nextAvailable} ref={nextRef} onClick={event=>go(page+1,'next',event.currentTarget)}>下一页</button>
      </div>
      {exactPages!==null&&exactPages>0&&<form className="galaxy-pagination-jump" onSubmit={event=>{
        event.preventDefault();
        const target=paginationJumpTarget(jump,exactPages);
        if(target!==null){const origin=event.currentTarget.ownerDocument.activeElement;go(target,origin===jumpRef.current?'jump-input':'jump',origin instanceof HTMLElement?origin:undefined);}
      }}>
        <label>跳至 <input ref={jumpRef} aria-label="跳转页码" type="number" inputMode="numeric" min={1} max={exactPages} step={1} required value={jump} disabled={disabled} onChange={event=>setJump(event.target.value)}/></label>
        <button ref={jumpButtonRef} type="submit" disabled={locked}>前往</button>
      </form>}
    </div>}
  </nav>;
}
