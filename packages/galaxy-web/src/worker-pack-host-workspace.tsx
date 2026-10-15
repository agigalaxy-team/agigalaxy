import {ReadingDetails,ReadingSummary} from './reading-details';
import React, {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Copy} from 'lucide-react';
import './tool-workspace.css';

type Pack={builderId:string;manifestId:string;manifestHash:string;delisted?:boolean;securityIssue?:unknown;manifest:{name:string;version:string;source?:string;installation?:string;environment?:string;configurationRequirements?:string}};
export function WorkerPackHostWorkspace({pack,returnTo,onReturn,onRecord}:{pack:Pack;returnTo?:string|null;onReturn?:(path:string)=>void;onRecord?:()=>void}){
 const [notice,setNotice]=useState('');
 const unavailable=Boolean(pack.delisted||pack.securityIssue),references={builderId:pack.builderId,manifestId:pack.manifestId,manifestHash:pack.manifestHash};
 async function copy(){try{await navigator.clipboard.writeText(JSON.stringify(references,null,2));setNotice('已复制这个版本的引用。');}catch{setNotice('复制未完成，可以打开准确版本引用后手动复制。');}}
 return <section className="tool-host" data-testid="worker-host-entry" aria-labelledby="tool-host-title">
  <h2 id="tool-host-title">在自己的环境中使用</h2>
  <p>回到你正在使用的 AI、聊天或运行环境，按作者说明准备这个版本。</p>
  {unavailable?<p className="message error" role="alert">此版本已下架或有待处理的安全事项。请先查看发布方维护说明，选择可用版本。</p>:<>
   {pack.manifest.installation&&<section className="tool-installation"><h3>作者的安装说明</h3><p className="reading-prose">{pack.manifest.installation}</p></section>}
   <div className="tool-actions">{pack.manifest.source&&<a className="tool-link-button" href={pack.manifest.source} target="_blank" rel="noreferrer">打开作者来源</a>}<Button type="button" variant="outline" onClick={()=>void copy()}><Copy size={15}/>复制版本引用</Button></div>
   <p className="tool-help">在自己的环境里选择本次输入、核对权限并确认执行。此网页尚未连接本机 Worker。</p>
  </>}
  {notice&&<p className="tool-help"><output>{notice}</output></p>}
  <ReadingDetails className="tool-reference"><ReadingSummary>准确版本引用</ReadingSummary><dl><dt>工具登记</dt><dd><code>{references.builderId}</code></dd><dt>清单版本</dt><dd><code>{references.manifestId}</code></dd><dt>内容校验</dt><dd><code>{references.manifestHash}</code></dd></dl></ReadingDetails>
  <div className="tool-host-next">{returnTo&&<a href={returnTo} onClick={e=>{if(onReturn){e.preventDefault();onReturn(returnTo);}}}>返回原事继续</a>}{onRecord&&!unavailable&&<button type="button" className="text-link" onClick={onRecord}>已经使用过，关联这次工作</button>}</div>
 </section>;
}
