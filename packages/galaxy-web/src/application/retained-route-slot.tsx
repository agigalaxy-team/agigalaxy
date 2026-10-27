import React,{useLayoutEffect,useRef,useState} from 'react';
/** A page slot may retain its mounted editor while its owner saves. The host
 * owns routing throughout; this component never reads or writes browser history. */
export function RetainedPageSlot<T>({route,value,children,isProtected,leave,restore,wrap,onCommit}:{route:string;value:T;children:React.ReactNode;isProtected:(origin:string)=>boolean;leave:(complete:()=>void)=>void;restore:(origin:string)=>void;wrap:(children:React.ReactNode,previous:T,current:T)=>React.ReactNode;onCommit?:()=>void}){
 const previous=useRef({route,children,value}),[accepted,setAccepted]=useState<string|null>(null);
 const held=route!==previous.current.route&&accepted!==route&&isProtected(previous.current.route);
 const latest=useRef({leave,onCommit,accepted});latest.current={leave,onCommit,accepted};
 useLayoutEffect(()=>{if(!held){if(latest.current.accepted!==null)setAccepted(null);latest.current.onCommit?.();return;}let active=true;latest.current.leave(()=>{if(active)setAccepted(route);});return()=>{active=false;};},[held,route]);
 if(held)return <>{wrap(previous.current.children,previous.current.value,value)}<aside className="message"><p><output>正在保存原页输入。保存完成后继续打开目标页面。</output></p><button onClick={()=>latest.current.leave(()=>setAccepted(route))}>保存并继续</button><button onClick={()=>restore(previous.current.route)}>返回原页继续编辑</button></aside></>;
 previous.current={route,children,value};return <>{children}</>;
}
