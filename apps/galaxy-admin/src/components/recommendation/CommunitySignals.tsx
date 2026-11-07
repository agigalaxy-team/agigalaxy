'use client';

import {type FormEvent,useEffect,useId,useRef,useState} from 'react';
import {useAdminQueryScope} from '../AdminQueryProvider';
import {useOperationsRead} from '../../lib/use-operations-read';
import {operationsRequest,OperationsRequestError} from '../../lib/operations-client';
import {communitySignalFields,communitySignalKeys,contentScoreFields,recommendationSignalFields,type CommunitySignalKey} from '../../lib/recommendation/community-signal-fields';
import {ReadStatus} from '../OperationControls';

type Signals = Record<CommunitySignalKey,number>&{version:number;enabled:boolean;updatedAt:string|null};
type Draft = {baseVersion:number;enabled:boolean;parameters:Record<CommunitySignalKey,number>;reason:string};
type Receipt = {operationId:string;expectedVersion:number};

const path='/v1/operations/recommendation/community-signals';
const signalGroups=[
  {label:'帖子评分',fields:Object.keys(contentScoreFields) as CommunitySignalKey[]},
  {label:'推荐排序',fields:Object.keys(recommendationSignalFields) as CommunitySignalKey[]},
];

function draftFrom(current:Signals):Draft{
  const parameters=Object.fromEntries(communitySignalKeys.map(key=>[key,current[key]])) as Draft['parameters'];
  return {baseVersion:current.version,enabled:current.enabled,parameters,reason:''};
}

export function CommunitySignals({csrfToken,canConfigure,onState}:{csrfToken:string;canConfigure:boolean;onState:(dirty:boolean,pending:boolean)=>void}){
  const fieldId=useId(),{identity}=useAdminQueryScope();
  const read=useOperationsRead<Signals>({path,failureMessage:'社区参考设置暂时无法读取。'});
  const [draft,setDraft]=useState<Draft|null>(null),[pending,setPending]=useState<Receipt|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const running=useRef(false),storage='recommendation-community-signals:'+identity;
  const current=read.value,value=draft??(current?draftFrom(current):null);

  useEffect(()=>{
    if(!identity)return;
    try{
      const original=JSON.parse(sessionStorage.getItem(storage)||'null');
      if(typeof original?.operationId==='string'&&Number.isSafeInteger(original.expectedVersion))setPending(original);
    }catch{}
  },[identity,storage]);
  useEffect(()=>{onState(!!draft,!!pending||busy);},[draft,pending,busy,onState]);

  async function saved(version:number){
    sessionStorage.removeItem(storage);
    setPending(null);
    setDraft(null);
    setError('');
    setMessage('社区参考设置已保存 · 版本 '+version);
    await read.read();
  }
  async function receipt(){
    if(!pending||running.current||!navigator.onLine)return;
    running.current=true;
    setBusy(true);
    try{
      const found=await operationsRequest<{state:string;operationId:string;kind:string|null;result?:{version?:number}}>('/v1/operations/recommendation/operations/'+pending.operationId);
      if(found.operationId!==pending.operationId)throw Error();
      if(found.state==='recorded'&&found.kind==='community-signals'&&found.result?.version===pending.expectedVersion+1)await saved(found.result.version);
      else setError('结果暂未取得。');
    }catch{setError('结果暂未取得。');}
    finally{running.current=false;setBusy(false);}
  }
  useEffect(()=>{
    if(!pending||busy)return;
    const timer=setTimeout(()=>void receipt(),5000);
    return()=>clearTimeout(timer);
  },[pending,busy]);

  const conflict=!!draft&&!!current&&draft.baseVersion!==current.version;
  const valid=!!value&&value.parameters.matchWeight>value.parameters.recognitionWeight+value.parameters.heatWeight
    &&communitySignalKeys.every(key=>{
      const number=value.parameters[key],{min,max}=communitySignalFields[key];
      return Number.isFinite(number)&&number>=min&&number<=max&&(key!=='maxPositionChange'||Number.isInteger(number));
    });
  async function save(event:FormEvent){
    event.preventDefault();
    if(!value||!current||!identity||pending||running.current||!canConfigure||!read.verified||conflict||!valid||!value.reason.trim())return;
    const record={operationId:crypto.randomUUID(),expectedVersion:value.baseVersion};
    sessionStorage.setItem(storage,JSON.stringify(record));
    setPending(record);
    setBusy(true);
    setError('');
    setMessage('');
    running.current=true;
    try{
      const result=await operationsRequest<{operationId:string;communitySignals:Signals}>(path,{csrfToken,body:{...record,enabled:value.enabled,...value.parameters,reason:value.reason.trim()}});
      if(result.operationId!==record.operationId||result.communitySignals?.version!==record.expectedVersion+1)throw Error();
      await saved(result.communitySignals.version);
    }catch(problem){
      if(problem instanceof OperationsRequestError&&problem.status>=400&&problem.status<500){
        sessionStorage.removeItem(storage);
        setPending(null);
        setError(problem.status===409?'设置已更新。':'设置未保存，请检查输入。');
        if(problem.status===409)void read.read();
      }else setError('结果暂未取得。');
    }finally{running.current=false;setBusy(false);}
  }

  return <section className="recommendation-panel">
    <header><h2>帖子评分与推荐参考</h2>{current&&<span className="recommendation-status">全站 · 版本 {current.version}</span>}</header>
    <ReadStatus loading={read.loading} error={read.error} retry={read.read}/>
    {value&&<form className="recommendation-editor" onSubmit={save}>
      <fieldset disabled={!canConfigure||busy||!!pending||!read.verified}>
        {signalGroups.map(group=><fieldset key={group.label}>
          <legend>{group.label}</legend>
          {group.fields.includes('matchWeight')&&<label className="recommendation-check"><span>启用社区参考</span><input type="checkbox" checked={value.enabled} onChange={event=>setDraft({...value,enabled:event.target.checked})}/></label>}
          {group.fields.map(key=>{
            const field=communitySignalFields[key],number=value.parameters[key];
            return <label className="recommendation-field" key={key}>{field.label}<input type="number" required min={field.min} max={field.max} step={field.step} value={Number.isFinite(number)?number:''} onChange={event=>setDraft({...value,parameters:{...value.parameters,[key]:event.target.valueAsNumber}})}/></label>;
          })}
        </fieldset>)}
        {value.parameters.matchWeight<=value.parameters.recognitionWeight+value.parameters.heatWeight&&<p role="status">需求匹配权重需大于内容认可与近期热度的权重之和。</p>}
        <label className="recommendation-field" htmlFor={fieldId+'-reason'}>操作说明<textarea id={fieldId+'-reason'} required maxLength={500} value={value.reason} onChange={event=>setDraft({...value,reason:event.target.value})}/></label>
        <button className="recommendation-primary" type="submit" disabled={!valid||conflict||!value.reason.trim()}>保存参数</button>
      </fieldset>
      {conflict&&<p role="status">当前设置已更新，输入仍保留。<button type="button" onClick={()=>setDraft(null)}>使用当前设置</button></p>}
      {error&&<p className="galaxy-error" role="alert">{error}{pending&&<button type="button" disabled={busy} onClick={()=>void receipt()}>读取原处理结果</button>}</p>}
      {message&&<output>{message}</output>}
    </form>}
  </section>;
}
