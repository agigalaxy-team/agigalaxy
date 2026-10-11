// Existing v1 node evidence has a current consumer. Select its actual readable
// facts; never turn v2 work, an old receipt or a typed locator into v1 evidence.
export function selectBuilderWork({controller,menu,form,message,run,label,plain,onSelected,onBack}){
 const outcomes={succeeded:label('完成','Completed'),partial:label('部分完成','Partial'),failed:label('未完成','Failed'),inconclusive:label('暂不能得出结论','Inconclusive'),conflicting:label('观察有冲突','Conflicting')};
 const conclusion=v=>({success:label('运行成功','Run succeeded'),failure:label('运行失败','Run failed'),neutral:label('中性结果','Neutral result'),cancelled:label('已取消','Canceled'),skipped:label('已跳过','Skipped'),timed_out:label('已超时','Timed out'),action_required:label('需要处理','Action required'),stale:label('记录已过时','Stale result'),startup_failure:label('启动失败','Startup failed')}[v]??plain(v));
 const proofTitle=p=>{const s=p.provenance?.source??{};return [s.repository,s.runId?label('运行 ','Run ')+s.runId:'',s.attempt?label('尝试 ','Attempt ')+s.attempt:'',p.provenance?.conclusion?conclusion(p.provenance.conclusion):''].filter(Boolean).map(v=>plain(v,180)).join(' · ')||label('当前可读的 CI 来源','Current readable CI source');};
 const eligible=row=>(row.results??[]).filter(r=>(row.attempts??[]).some(a=>a.id===r.attemptId));
 function listing(query='',after){void run(()=>controller.queryHistory({query,limit:7,...(after?{after}:{})}),page=>{
  const rows=(page.items??[]).filter(row=>row.caseId&&eligible(row).length&&(row.proofs??[]).some(p=>p.status==='active'));
  const entries=rows.map(row=>[plain(row.title??label('已有工作','Existing work'),160),()=>result(row,{query,after}),plain(row.summary,240)]);
  if(page.nextCursor)entries.push([label('继续查看','More work'),()=>listing(query,page.nextCursor)]);
  entries.push([label('按目标查找','Find by goal'),()=>form(label('找已有工作','Find existing work'),[['query',label('工作名称或目标中的文字','Words in its title or goal'),query,200]],v=>listing(v.query),onBack)]);
  if(!rows.length&&!page.nextCursor)return message(label('当前可读的工作中没有可关联的结果和 CI 来源。可按目标查找其他已有工作。','No result with a current CI source is readable on this page. Search for other existing work.'),()=>menu(label('选择已有工作','Choose existing work'),entries,onBack));
  menu(label('关联哪次工作','Choose the work to associate'),entries,onBack);
 },onBack);}
 function result(row,query){const results=eligible(row),back=()=>listing(query.query,query.after);
  const choose=r=>sources(row,r,query,[],back);
  if(results.length===1)return choose(results[0]);
  menu(plain(row.title,160),results.map(r=>[outcomes[r.outcome]??plain(r.outcome),()=>choose(r),plain(r.summary,280)]),back);
 }
 function sources(row,result,query,chosen,back){const proofs=(row.proofs??[]).filter(p=>p.status==='active');
  const entries=proofs.filter(p=>!chosen.some(c=>c.proofId===p.proofId)).map(p=>[proofTitle(p),()=>sources(row,result,query,[...chosen,p],back)]);
  if(chosen.length)entries.unshift([label('使用所选来源','Use selected sources'),()=>statement(row,result,query,chosen,back),chosen.map(proofTitle).join('\n')]);
  if(chosen.length>=8)entries.splice(1);
  entries.push([label('查看来源详情','Inspect source details'),()=>message(JSON.stringify(proofs.map(p=>p.provenance??p),null,2),()=>sources(row,result,query,chosen,back))]);
  menu(`${label('选择与这次结果有关的 CI 来源','Choose CI sources for this result')}\n${plain(result.summary,320)}\n${label('关联关系由服务按原始材料核对。','The service checks the relationship against original material.')}`,entries,back);
 }
 function statement(row,result,query,proofs,back){form(label('节点的参与说明','Node participation'),[['summary',label('这次节点实际参与了什么','What did this node contribute?'),'',1500]],value=>{
  const finish=task=>void run(async()=>{const page=await controller.queryHistory({query:query.query,limit:7,...(query.after?{after:query.after}:{})}),current=page.items?.find(v=>v.caseId===row.caseId),r=current?.results?.find(v=>v.id===result.id&&v.attemptId===result.attemptId);
   if(!current||!r||!(current.attempts??[]).some(a=>a.id===result.attemptId)||proofs.some(p=>!current.proofs?.some(v=>v.proofId===p.proofId&&v.status==='active')))throw Error(label('所选工作或来源已不可读。请重新选择当前允许的内容。','The selected work or sources are no longer readable. Choose currently permitted content.'));
   return{caseId:current.caseId,attemptId:r.attemptId,resultId:r.id,proofIds:proofs.map(p=>p.proofId),summary:value.summary,...(task?{task}:{}),
    context:[plain(current.title,160),outcomes[r.outcome]??plain(r.outcome),plain(r.summary,1500),...proofs.map(proofTitle)].join('\n')};
  },onSelected,back);
  if(!controller.readA2a)return finish();
  menu(label('是否关联已有外部任务','Associate an existing external task?'),[
   [label('只关联这次工作与来源','Associate this work and sources'),()=>finish()],
   [label('选择已接续的外部任务','Choose a connected external task'),()=>void run(()=>controller.readA2a('peers'),peers=>{
    menu(label('选择原服务','Choose the original service'),peers.map(peer=>[plain(peer.name??peer.id,180),()=>void run(()=>controller.readA2a('list',{peerId:peer.id}),links=>{
     const matches=links.filter(l=>l.caseId===row.caseId&&l.attemptId===result.attemptId&&l.peer?.taskId);
     if(!matches.length)return message(label('这个服务没有与所选工作相符的已有任务。','This service has no existing task for the selected work.'),()=>finish());
     menu(label('所选工作的已有任务','Existing tasks for the selected work'),matches.map(l=>[plain(l.peer.state??l.status),()=>finish({protocol:'a2a/1.0',endpoint:peer.endpoint,taskId:l.peer.taskId}),plain(l.peer.text??'',240)]),back);
    },back)]),back);
   },back)]
  ],back);
 },back);}
 listing();
}
