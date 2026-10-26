import React,{useEffect,useState} from 'react';
import {ContentShareFlow,type ContentShareContext} from './content-share-flow';
import type {createWebRuntime} from "../../runtime.mjs";
type Runtime=Awaited<ReturnType<typeof createWebRuntime>>;
type Props={runtime:Runtime;subjectId?:string;connected:boolean;context:ContentShareContext;navigate:(path:string)=>void;label?:string};
export function ContentShareAction({label='分享内容',...props}:Props){
 const [open,setOpen]=useState(false);
 const {runtime,subjectId,connected}=props;
 const binding=runtime.api.snapshot(),scope=JSON.stringify([subjectId,connected,binding?.bindingId,binding?.generation]);
 return open?<OpenedShare key={props.context.kind+':'+props.context.id+':'+scope} {...props} onClose={()=>setOpen(false)}/>:<button type="button" className="text-link" onClick={()=>setOpen(true)}>{label}</button>;
}
function OpenedShare({runtime,subjectId,connected,context,navigate,onClose}:Props&{onClose:()=>void}){
 const [nativeConnected,setNativeConnected]=useState(false);
 useEffect(()=>{let active=true;if(subjectId&&connected)void runtime.status().then(status=>{if(active&&status.identity?.subjectId===subjectId&&status.identity.source==='native-handoff'&&status.connection?.subjectId===subjectId)setNativeConnected(true);}).catch(()=>{});return()=>{active=false;};},[runtime,subjectId,connected]);
 return <ContentShareFlow runtime={runtime} subjectId={subjectId} connected={connected} nativeConnected={nativeConnected} context={context} onClose={onClose} navigate={navigate}/>;
}
