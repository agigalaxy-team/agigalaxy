import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useOperationsRead} from '__HOOK__';
import {state} from './read-double';
const variant=new URLSearchParams(location.search).get('variant'),defaultLead=new URLSearchParams(location.search).has('default');
let change:(patch:any)=>void=()=>{},current:any;
function Fixture(){
 const [props,setProps]=useState({path:'/current/role-a',initial:{text:'original-history',checkedAt:Math.floor(Date.now()/1000),readExpiresAt:Math.floor(Date.now()/1000)+30}});change=patch=>setProps(previous=>({...previous,...patch}));
 const [draft,setDraft]=useState('尚未发送的思路');
 current=useOperationsRead({path:props.path,initial:props.initial,failureMessage:'当前资料暂时无法取得。',clearOnOffline:true,retryUnavailable:true,...(variant==='after'&&!defaultLead?{renewBeforeMs:20000}:{})});
 return <main><section id="panel" style={{height:140,overflow:'auto'}}><div style={{height:100}}>前文</div><article id="history">{current.verified?current.value?.text??'':''}</article><div style={{height:300}}>后文</div></section><textarea aria-label="未发送稿" value={draft} onChange={e=>setDraft(e.target.value)}/><output id="status">{JSON.stringify({verified:current.verified,loading:current.loading,refreshing:current.refreshing})}</output></main>;
}
const root=createRoot(document.getElementById('root')!);root.render(<Fixture/>);
Object.assign(window,{__renewLocal:{state,change:(patch:any)=>change(patch),background:()=>{for(const source of ['poll','stream-resync','command-progress'])void (current.renew??current.read)();},read:()=>void current.read(),renew:()=>void (current.renew??current.read)(),unmount:()=>root.unmount(),snapshot:()=>({now:Date.now(),path:current.path,text:document.querySelector('#history')?.textContent??null,valueText:current.value?.text??null,verified:current.verified,refreshing:current.refreshing,requests:state.requests.map(item=>({...item})),draft:document.querySelector('textarea')?.value??null,caret:document.querySelector('textarea')?[document.querySelector('textarea')!.selectionStart,document.querySelector('textarea')!.selectionEnd]:null,focused:document.activeElement===document.querySelector('textarea'),scrollTop:document.querySelector('#panel')?.scrollTop??null,sameMain:!window.__main||window.__main===document.querySelector('main'),sameHistory:!window.__history||window.__history===document.querySelector('#history'),sameInput:!window.__input||window.__input===document.querySelector('textarea')})}});
