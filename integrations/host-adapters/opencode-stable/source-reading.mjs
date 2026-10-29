import {authoredRows} from '../../native-v2/presentation/native-result.mjs';

export const searchSourceName=(type,label)=>({case:label('工作','Work'),history:label('事实履历','Work history'),proof:label('CI 来源','CI source'),capsule:label('方法','Method'),worker:label('处理服务','Worker service'),hub:label('开放空间','Open hub')}[type]??type);
export const workOutcomeName=(value,label)=>({succeeded:label('完成','Completed'),partial:label('部分完成','Partial'),failed:label('未完成','Failed'),inconclusive:label('暂不能得出结论','Inconclusive'),conflicting:label('观察有冲突','Conflicting')}[value]??value);

// Present the authored fields of the actual source projection. IDs, signatures
// and protocol records remain in the explicitly requested source detail.
export function sourceReadingText(item,label,plain){
 const record=item.record??{},rows=[];
 const add=(name,value)=>{if(value!==undefined&&value!==null&&value!=='')rows.push(name+'\n'+plain(value));};
 if(item.type==='proof'){
  const a=record.assertion??{},s=a.source??item.source?.reference??{};
  add(label('CI 结论','CI conclusion'),a.conclusion??item.summary);
  if(s.owner&&s.repository)add(label('仓库','Repository'),s.owner+'/'+s.repository);
  if(s.runId)add(label('运行','Run'),s.runId+(s.attempt?' · '+label('尝试 ','Attempt ')+s.attempt:''));
  add(label('适用范围','Scope'),a.scope==='referenced-ci-run-only'?label('仅适用于所引用的这次 CI 运行','Only the referenced CI run'):a.scope);
  if((a.limitations??item.limitations)?.length)add(label('来源说明与限制','Source notes and limitations'),(a.limitations??item.limitations).join('\n'));
 }else if(['case','history'].includes(item.type)){
  add(label('目标与情况','Goal and situation'),record.summary??item.summary);
  for(const a of record.attempts??[])if(a.approach)add(label('已有尝试','Existing approach'),a.approach);
  for(const result of record.results??[])add(workOutcomeName(result.outcome,label),[result.summary,result.failureReason,...(result.limitations??[])].filter(Boolean).join('\n'));
  if(record.state==='withdrawn')add(label('当前来源','Current source'),label('此工作已撤回。','This work was withdrawn.'));
 }else if(['worker','hub'].includes(item.type)){
  add(label('适用范围','Scope'),record.scope??item.summary);
  const capabilities=record.capabilities??record.declaration?.capabilities;
  if(Array.isArray(capabilities))add(label('自报用途','Declared uses'),capabilities.map(value=>typeof value==='string'?value:value.name??value.summary).filter(Boolean).join('\n'));
 }else{
  const values=authoredRows(record).filter(row=>!row.download);
  for(const row of values)add(row.label,row.text);
  if(!rows.length)add(label('说明','Description'),item.summary);
 }
 return rows.join('\n\n')||label('这份当前来源没有正文。可查看来源详情。','This current source has no text. Inspect its source details.');
}
