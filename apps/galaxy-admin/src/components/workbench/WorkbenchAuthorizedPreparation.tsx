'use client';

import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useOperationsRead} from '../../lib/use-operations-read';
import type {AgentOsCommand,AgentOsDomain,AgentOsOptions} from "../../lib/workbench/agentos-client";
import {authorizedPreparation,automationContentLabel,grantIncludesContent,preparationUntil,preparedContentHref,type AuthorizedPreparationBody,type AuthorizedPreparationDraft} from "../../lib/workbench/authorized-preparation-model";
import type {PublicContentDetail,PublicContentKind} from "../content-governance/public-content-types";
import {AutomationContentPicker} from "../permissions/AutomationContentPicker";
import {ReadStatus} from '../OperationControls';
import './authorized-preparation.css';

type Target={kind:PublicContentKind;id:string};
type Memory={csrfToken:string;grantId:string;targets:Record<string,Target|null>;actions:Record<string,AuthorizedPreparationDraft['action']>;drafts:Record<string,Pick<AuthorizedPreparationDraft,'until'|'reason'>>;settled:string[]};
// Same-document input memory. No source text, titles, snapshots or credentials
// are written to storage. A changed, verified management session clears it.
const memories=new Map<string,Memory>();
const empty=():Memory=>({csrfToken:'',grantId:'',targets:{},actions:{},drafts:{},settled:[]});
type Props={operatorId:string;csrfToken:string;domain:AgentOsDomain;identityEnded:boolean;options:AgentOsOptions|null;verified:boolean;loading:boolean;error:string;retry:()=>void|Promise<unknown>;canReadContent:boolean;canManagePermissions:boolean;canReadStrategies:boolean;busy:boolean;committed?:{operationId:string;body:AuthorizedPreparationBody};onPrepare:(body:AuthorizedPreparationBody)=>Promise<AgentOsCommand|undefined>};
export function WorkbenchAuthorizedPreparation({operatorId,csrfToken,domain,identityEnded,options,verified,loading,error,retry,canReadContent,canManagePermissions,canReadStrategies,busy,committed,onPrepare}:Props){
  const key=operatorId+':'+domain,initial=useRef(memories.get(key)??empty()),lastToken=useRef(initial.current.csrfToken||csrfToken);
  const [grantId,setGrantId]=useState(initial.current.grantId),[targets,setTargets]=useState(initial.current.targets),[actions,setActions]=useState(initial.current.actions),[drafts,setDrafts]=useState(initial.current.drafts),[settled,setSettled]=useState(initial.current.settled);
  const available=verified?(options?.items??[]).filter(item=>item.domain===domain&&item.mode==='assisted'):[],grant=available.find(item=>item.id===grantId)??null;
  const target=grant?targets[grant.id]??null:null,action=grant?actions[grant.id]??'':'',draftKey=grant&&target?grant.id+'|'+target.kind+':'+target.id+'|'+action:'',text=drafts[draftKey]??{until:'',reason:''};
  const source=useOperationsRead<PublicContentDetail>({path:canReadContent&&grant&&target&&grantIncludesContent(grant,target.id)?'/v1/operations/community/content/'+target.kind+'/'+target.id:null,failureMessage:'当前公开内容暂时无法核对。',clearOnOffline:true});
  const current=source.verified?source.value:null,preparation=authorizedPreparation({grant,domain,target,draft:{action,...text},source:current,verified:source.verified});
  useLayoutEffect(()=>{
    if(identityEnded){memories.delete(key);setGrantId('');setTargets({});setActions({});setDrafts({});source.clear();return;}
    if(!csrfToken)return;
    if(lastToken.current&&lastToken.current!==csrfToken){memories.delete(key);setGrantId('');setTargets({});setActions({});setDrafts({});source.clear();}
    lastToken.current=csrfToken;
  },[key,csrfToken,identityEnded,source.clear]);
  useEffect(()=>{if(!identityEnded)memories.set(key,{csrfToken:lastToken.current,grantId,targets,actions,drafts,settled});},[key,identityEnded,grantId,targets,actions,drafts,settled]);
  useEffect(()=>{if(verified&&!available.some(item=>item.id===grantId)&&grantId&&!busy)setGrantId('');},[verified,options,domain,grantId,busy]);
  useEffect(()=>{
    if(!committed||settled.includes(committed.operationId))return;
    setSettled(previous=>[...previous,committed.operationId]);
    if(!grant||!target||committed.body.grantId!==grant.id||committed.body.preparedCommand.targetId!==target.id||committed.body.preparedCommand.targetKind!==target.kind||committed.body.preparedCommand.input.kind!==action)return;
    const input=committed.body.preparedCommand.input;
    setDrafts(previous=>{const stored=previous[draftKey];if(!stored||stored.reason.trim()!==input.reason||action==='hide'&&preparationUntil(stored.until)!==input.until)return previous;const next={...previous};delete next[draftKey];return next;});
  },[committed?.operationId]);
  function update(patch:Partial<Pick<AuthorizedPreparationDraft,'until'|'reason'>>){if(!draftKey||busy)return;setDrafts(previous=>({...previous,[draftKey]:{...(previous[draftKey]??{until:'',reason:''}),...patch}}));}
  async function prepare(){
    const body=preparation.body;if(!body||!verified||busy||!navigator.onLine||document.visibilityState==='hidden')return;
    const result=await onPrepare(body);
    if(result?.execution)setDrafts(previous=>{const stored=previous[draftKey];if(!stored||stored.reason!==text.reason||stored.until!==text.until)return previous;const next={...previous};delete next[draftKey];return next;});
  }
  const readCurrent=!!target&&source.verified&&current?.content.id===target.id&&current.content.kind===target.kind;
  return <section className="wb-authorized-preparation" aria-label="准备已授权处理">
    <div className="wb-preparation-actions"><h3>已授权事项</h3>{canManagePermissions&&<Link href="/admin/operations/permissions?tab=automatic" prefetch={false}>管理执行授权</Link>}</div>
    <ReadStatus loading={loading} error={error} retry={async()=>{await retry();}}/>
    {verified&&!available.length?<p className="wb-preparation-muted">当前没有可用的专项代办授权。</p>:!verified&&!loading&&!error?<p className="wb-preparation-muted">专项授权尚未取得。</p>:null}
    {!!available.length&&<><label>本次使用的授权<select aria-label="本次专项执行授权" value={grant?.id??''} disabled={busy} onChange={event=>setGrantId(event.target.value)}><option value="">选择本领域的代办授权</option>{available.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {grant&&<fieldset disabled={busy}><p className="wb-preparation-muted">{grant.resourceScope.kind==='selected'?'仅限这项授权明确指定的内容。':grant.resourceScope.kind==='eligible'?'仅能从当前符合条件的公开内容中选择。':'对象范围尚未确定，不能准备处理。'}</p>
        {domain==='governance'&&grant.actions.includes('content.read')&&grant.actions.some(code=>code==='content.hide'||code==='content.restore')&&grant.resourceScope.kind!=='unresolved'?<>
          <AutomationContentPicker key={key+':'+grant.id} selected={target?[target.id]:[]} maxSelected={1} allowedIds={grant.resourceScope.kind==='selected'?grant.resourceScope.resourceIds:undefined} canRead={canReadContent} disabled={busy} onChange={(ids,picked)=>{if(busy)return;setTargets(previous=>({...previous,[grant.id]:ids.length&&picked?picked:null}));}}/>
          {target&&<><ReadStatus loading={source.loading} error={source.error} retry={source.read}/>
            {readCurrent&&current&&<p><Link href={preparedContentHref(current.content)} prefetch={false}>{automationContentLabel(current.content)}</Link></p>}
            <div className="wb-preparation-fields"><label>本次动作<select aria-label="本次授权处理动作" value={action} onChange={event=>{const value=event.target.value as AuthorizedPreparationDraft['action'];setActions(previous=>({...previous,[grant.id]:value}));}}><option value="">明确选择动作</option>{grant.actions.includes('content.hide')&&<option value="hide">下架</option>}{grant.actions.includes('content.restore')&&<option value="restore">恢复可见</option>}</select></label>{action==='hide'&&<label>下架截止（北京时间）<input type="datetime-local" aria-label="本次下架截止（北京时间）" value={text.until} onChange={event=>update({until:event.target.value})}/></label>}</div>
            {action&&<label>本次处理说明<textarea aria-label="本次授权处理说明" rows={2} maxLength={1600} value={text.reason} onChange={event=>update({reason:event.target.value})}/></label>}
            {preparation.body&&current?<section className="wb-preparation-preview" aria-label="本次处理预览"><h4>{action==='hide'?'下架':'恢复可见'} · {automationContentLabel(current.content)}</h4><p>{action==='hide'?'将停止这项内容的公开访问。':'将解除这项授权原来的下架；原来源、作者撤回、其他限制或到期仍会影响公开访问。'}</p>{preparation.body.preparedCommand.input.until&&<p>本次下架截止：{new Date(preparation.body.preparedCommand.input.until*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。原内容到期时间保持不变。</p>}<p>{preparation.body.preparedCommand.input.reason}</p><p className="wb-preparation-muted">准备后尚不会执行，可接续人工复核或已发布策略。</p></section>:action&&!source.loading&&!source.error?<p className="wb-preparation-muted" role="status">{preparation.issue}</p>:null}
            <div className="wb-preparation-actions"><button type="button" disabled={busy||!verified||!preparation.body} onClick={()=>void prepare()}>准备这项处理</button>{canReadStrategies&&<Link href="/admin/operations/strategy" prefetch={false}>查看目标与策略</Link>}</div>
          </>}
        </>:<p className="wb-preparation-muted">{grant.actions.includes('content.read')&&!grant.actions.some(code=>code==='content.hide'||code==='content.restore')?'这项授权仅含读取，不含下架或恢复。':'这项授权当前尚不能准备公开内容处理。'}</p>}
      </fieldset>}
    </>}
  </section>;
}
