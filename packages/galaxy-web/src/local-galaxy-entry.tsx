import React,{useMemo,useState} from 'react';
import {Copy,Laptop} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {ReadingDetails,ReadingSummary} from './reading-details';
import {localGalaxyReturnObject} from './local-galaxy-navigation.mjs';

export function LocalGalaxyEntry({purpose='access',introduction=true,returnTo}:{purpose?:'access'|'association';introduction?:boolean;returnTo?:string}){
 const [notice,setNotice]=useState(''),[manual,setManual]=useState(false);
 const request=useMemo(()=>{
  const requestId=crypto.randomUUID(),original=purpose==='association'?localGalaxyReturnObject(returnTo):null,object=JSON.stringify(original??{kind:'account',section:purpose});
  const association=purpose==='association'?'请在当前设备的银河插件中完成银河官方账户关联：用 galaxy_identity_account_read 读取真实 providers，再用实际 providerId 开始 begin；打开插件返回的官方登录页面让我登录。用原 loginId 查询 status；需要关联签名时，调用 galaxy_identity_account_prepare（action=link、原 loginId），再调用 galaxy_identity_account_execute（previewId）。必须让我在真实宿主表单或本机审阅页确认，不代替我批准，不用网页缓存身份签署。已有未决操作先用 galaxy_identity_account_recover 核对原记录，不重复创建登录。':'';
  return `请使用当前设备已安装的银河插件，先读取 galaxy_native_status。已有银河 ID 就沿用；只有尚无 ID 时才准备 galaxy_native_initialize_preview，并在真实本机确认后调用 galaxy_native_initialize 在本地创建。需要联网时按本机已配置的服务与公钥调用 galaxy_native_connect，不从网页替换配置。${association}最后调用 galaxy_identity_web_connect，requestId=${requestId}，object=${object}，让我在本机确认后接洽当前官网 ${location.origin}，${original?'由插件核对原对象与权限后，继续原来的页面':'返回账户中心'}。保留已有 ID、经历、权限、资料与网页原稿；登录官方账户不代表已获得任何 ID 的控制权。若没有安装银河插件，请先提示我安装，不在浏览器生成 ID。`;
 },[purpose,returnTo]);
 async function copy(){try{await navigator.clipboard.writeText(request);setNotice('已复制。回到已安装银河的 AI 环境发送，插件会带你完成本机确认。');setManual(false);}catch{setManual(true);setNotice('请复制下面的内容，发送到已安装银河的 AI 环境。');}}
 return <div className="local-galaxy-entry">{introduction&&<p>{purpose==='association'?'让当前设备的银河插件选择本地 ID，完成官方账户登录与关联确认。':'在已安装银河的 AI 环境继续，插件会读取已有 ID，或在本机确认后创建。'}</p>}
  <div className="button-row"><Button onClick={()=>void copy()}><Copy size={16}/>复制给当前 AI</Button><a href="/downloads/">安装本机银河</a></div>
  {notice&&<output className="local-galaxy-notice">{notice}</output>}
  {manual?<label className="local-galaxy-manual">交给当前 AI 的内容<textarea readOnly value={request} onFocus={event=>event.target.select()}/></label>:<ReadingDetails className="local-galaxy-request"><ReadingSummary><Laptop size={14}/>查看交接内容</ReadingSummary><p>这段请求交给当前设备的 AI，实际授权仍在银河插件中完成。</p><textarea aria-label="交给当前 AI 的内容" readOnly value={request} onFocus={event=>event.target.select()}/></ReadingDetails>}
 </div>;
}
