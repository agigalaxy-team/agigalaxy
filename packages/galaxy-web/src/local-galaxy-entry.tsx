import React,{useMemo,useState,useSyncExternalStore} from 'react';
import {Copy} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {localGalaxyReturnObject} from './local-galaxy-navigation.mjs';
import {hasLocalGalaxyWindow,returnToLocalGalaxyWindow,subscribeLocalGalaxyWindow} from './local-galaxy-window.mjs';

export function LocalGalaxyEntry({purpose='access',introduction=true,returnTo,hasIdentity=false}:{purpose?:'access'|'association';introduction?:boolean;returnTo?:string;hasIdentity?:boolean}){
 const [notice,setNotice]=useState(''),[manual,setManual]=useState(false),[organization,setOrganization]=useState(false);
 const nativeWindow=useSyncExternalStore(subscribeLocalGalaxyWindow,hasLocalGalaxyWindow,()=>false);
 const request=useMemo(()=>{
  const requestId=crypto.randomUUID(),original=localGalaxyReturnObject(returnTo),object=JSON.stringify(original??{kind:'account',section:purpose});
  return `请在当前设备用银河继续${purpose==='association'?'关联我的银河账户':'当前工作'}。先读取 galaxy_native_status，沿用适用的已有 ID 与服务配置。尚无 ID 时，才通过本机 galaxy_native_initialize_preview / galaxy_native_initialize 创建${organization?'组织':'默认个人'}身份，不改已有 ID 类型。${purpose==='association'?'沿现有 galaxy_identity_account_read 的 providers / begin / status / prepare / execute 完成官方登录与关联；有原操作先 recover，不另起重复流程。':''}若需要联网，沿已有本机配置调用 galaxy_native_connect。通过 galaxy_identity_web_connect 接回 ${location.origin}，requestId=${requestId}，object=${object}。本机已有有效授权直接沿用；确需新增授权时在本机完成，再继续原内容。`;
 },[purpose,returnTo,organization]);
 async function copy(){try{await navigator.clipboard.writeText(request);setNotice('已复制，回到自己的 AI 对话发送即可。');setManual(false);}catch{setManual(true);setNotice('复制这段请求，回到自己的 AI 对话发送。');}}
 return <div className="local-galaxy-entry">{introduction&&<p>{nativeWindow?'返回发起窗口，接着原来的事情。':'在已安装银河的 AI 环境中继续。'}</p>}<div className="button-row">{nativeWindow?<Button type="button" onClick={()=>{if(!returnToLocalGalaxyWindow())setNotice('请回到刚才发起操作的窗口继续。');}}>回到发起窗口</Button>:<><Button type="button" onClick={()=>void copy()}><Copy size={15}/>复制接续请求</Button><a href="/downloads/">安装银河</a>{purpose==='access'&&!hasIdentity&&<button type="button" className="text-link" aria-pressed={organization} onClick={()=>setOrganization(value=>!value)}>{organization?'改用个人身份':'组织使用'}</button>}</>}</div>{organization&&!nativeWindow&&<p className="muted">仅在本机尚无适用 ID 时创建组织身份。</p>}{notice&&<output className="local-galaxy-notice">{notice}</output>}{manual&&!nativeWindow&&<label className="local-galaxy-manual">接续请求<textarea readOnly value={request} onFocus={event=>event.target.select()}/></label>}</div>;
}
const localPanelLabels={history:'工作履历',privacy:'同步范围',archive:'本机会话'};
export function LocalGalaxyPanelEntry({view}:{view:'history'|'privacy'|'archive'}){
 const nativeWindow=useSyncExternalStore(subscribeLocalGalaxyWindow,hasLocalGalaxyWindow,()=>false);
 const [notice,setNotice]=useState(''),[manual,setManual]=useState(false);
 const request=`请使用当前设备已安装的银河插件，调用 galaxy_local_panel，view="${view}"，在当前 AI 旁打开${localPanelLabels[view]}。沿用本机已有身份、授权和设置。${view==='privacy'?'让我选择需要同步的资料和会话范围；已有选择直接沿用。':''}`;
 async function copy(){try{await navigator.clipboard.writeText(request);setNotice('已复制，回到自己的 AI 对话发送即可。');setManual(false);}catch{setNotice('复制请求，回到自己的 AI 对话发送。');setManual(true);}}
 return <section className="local-galaxy-entry local-panel-entry"><p>在本机银河中{view==='history'?'阅读工作履历':view==='privacy'?'选择同步范围':'管理会话'}。</p><div className="button-row"><Button type="button" variant="outline" onClick={()=>{if(nativeWindow){if(!returnToLocalGalaxyWindow())setNotice('请回到刚才发起操作的窗口。');}else void copy();}}>{nativeWindow?'回到发起窗口':<><Copy size={15}/>复制本机请求</>}</Button>{!nativeWindow&&<a href="/downloads/">安装银河</a>}</div>{notice&&<output className="local-galaxy-notice">{notice}</output>}{manual&&<label className="local-galaxy-manual">本机请求<textarea readOnly value={request} onFocus={event=>event.target.select()}/></label>}</section>;
}
