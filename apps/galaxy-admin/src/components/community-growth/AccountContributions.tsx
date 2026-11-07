'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {operationsRequest,OperationsRequestError} from '../../lib/operations-client';
import {scheduleOperationsDeadline} from '../../lib/schedule-operations-deadline';
import {ReadStatus} from '../OperationControls';
import {timeLabel} from '../business-types';
import {publicContentTopics} from '../content-governance/public-content-types';

type Contribution={
  sourceId:string;
  title:string;
  objectKind:'post'|'reply';
  domains:string[];
  experience:number;
  occurredAt:string;
  ruleVersion:number|null;
  basis:'current'|'legacy'|'baseline'|'version';
};
type Page={accountId:string;items:Contribution[];nextAfter:string|null;readExpiresAt:number|null};

const basisLabels={current:'当前规则',legacy:'既有经验',baseline:'历史基线',version:'入账规则'};
const domainName=(id:string)=>publicContentTopics[id as keyof typeof publicContentTopics]??id;

export function AccountContributions({csrfToken,accountId}:{csrfToken:string;accountId:string}){
  const [page,setPage]=useState<Page|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null);
  const read=useCallback(async(after?:string)=>{
    if(request.current)return;
    const active=new AbortController();
    request.current=active;
    setLoading(true);
    setError('');
    try{
      const next=await operationsRequest<Page>('/v1/operations/community-growth/query',{
        csrfToken,body:{kind:'contributions',accountId,...(after?{after}:{})},signal:active.signal,
      });
      if(active.signal.aborted)return;
      if(next.accountId!==accountId||!Array.isArray(next.items))throw Error();
      setPage(previous=>{
        if(!after||!previous)return next;
        const deadlines=[previous.readExpiresAt,next.readExpiresAt].filter((value):value is number=>typeof value==='number');
        return {...next,items:[...previous.items,...next.items],readExpiresAt:deadlines.length?Math.min(...deadlines):null};
      });
    }catch(problem){
      if(active.signal.aborted)return;
      if(problem instanceof OperationsRequestError&&[401,403,404,410].includes(problem.status))setPage(null);
      setError('暂时无法读取成长记录。');
    }finally{
      if(request.current===active){
        request.current=null;
        setLoading(false);
      }
    }
  },[accountId,csrfToken]);
  useEffect(()=>{
    setPage(null);
    void read();
    return ()=>{request.current?.abort();request.current=null;};
  },[read]);
  useEffect(()=>{
    if(!page?.readExpiresAt)return;
    return scheduleOperationsDeadline(page.readExpiresAt*1000,()=>{
      request.current?.abort();
      request.current=null;
      setPage(null);
      void read();
    });
  },[page?.readExpiresAt,read]);

  return <section>
    <h3>贡献记录</h3>
    <ReadStatus loading={loading} error={error} retry={()=>read()}/>
    {!!page?.items.length&&<ul className="galaxy-records">{page.items.map(item=><li key={item.sourceId}>
      <strong>{item.title||(item.objectKind==='reply'?'回复':'帖子')}</strong>
      <span>经验 +{item.experience}{item.domains?.length?' · '+item.domains.map(domainName).join('、'):''}</span>
      <span>{basisLabels[item.basis]}{typeof item.ruleVersion==='number'?' · 版本 '+item.ruleVersion:''} · {timeLabel(item.occurredAt)}</span>
    </li>)}</ul>}
    {page&&!page.items.length&&<p>暂无可查看的贡献记录。</p>}
    {page?.nextAfter&&<button type="button" className="galaxy-secondary" disabled={loading} onClick={()=>void read(page.nextAfter!)}>更多记录</button>}
  </section>;
}
