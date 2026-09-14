import { eventDraftFields, eventFromDraft, checkEventDraftTarget } from '../../../packages/galaxy-official/src/shared/assistance-event-draft.mjs';
import { publicContributionEventKinds } from '../../../packages/galaxy-official/src/shared/assistance-schema.mjs';
// Native persisted collaboration wizard. Saving fields is local.
export function createAssistanceDraftMenu({controller,select,prompt,info,language,isCurrent,onBack,onConfirm,onOpenRequest,canSubmit=true}) {
  const zh = language !== 'en-US', label = (a,b) => zh ? a : b;
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1200);
  let generation = 0;
  const active = version => isCurrent() && version === generation;
  function menu(title,entries,back=onBack,offset=0) {
    if (!isCurrent()) return;
    const version=++generation,routes={};
    const once=fn=>()=>{if(active(version)){generation++;fn();}};
    const options=entries.slice(offset,offset+8).map(([title,action,description=''],i)=>{
      routes[i+1]=once(action);return {number:String(i+1),title,description};
    });
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page')});routes[9]=once(()=>menu(title,entries,back,offset+8));}
    select({title,options,routes,onBack:once(offset?()=>menu(title,entries,back,Math.max(0,offset-8)):back)});
  }
  function message(text,back) {
    if(!isCurrent())return;const version=++generation;
    info('Galaxy',text,()=>{if(active(version)){generation++;back();}});
  }
  async function run(work,done,back=onBack) {
    if(!isCurrent())return;
    const version=++generation;
    info('Galaxy',label('正在保存或读取；Esc返回。','Saving or reading; Esc returns.'),()=>{if(active(version)){generation++;controller.cancel();back();}});
    try {const result=await work();if(active(version))done(result);}
    catch(error){if(active(version))message(plain(error.message),back);}
  }
  function save(row,changes) {
    const content={...row.content,...changes};
    void run(()=>controller.saveAssistanceDraft({id:row.id,expectedRevision:row.revision,content}),render,()=>openDraft(row.id));
  }
  const details = [
    ['caseId',label('已发布Case的ID','ID of your published Case')],
    ['title',label('标题','Title')],['problem',label('问题说明','Problem')],
    ['attempts',label('已有尝试（分号分隔，可留空）','Previous approaches (semicolon separated, optional)')],
    ['scope',label('需要协助的范围','Requested scope')],['capabilityId',label('具体能力ID（可留空）','Capability ID (optional)')],
    ['hours',label('招募有效小时数（大于0，最多720）','Enrollment hours (over 0, at most 720)')],
  ];
  function fields(row,items,next,previous) {
    const index=Math.min(row.content.index,items.length-1),[key,title]=items[index],version=++generation;
    prompt({title:`${label('本地协作草稿','Local collaboration draft')} · ${index+1}/${items.length}\n${title}\n${label('确认后保存在本机。留空保留原值；/clear清空。','Saved locally on confirmation. Empty keeps the saved value; /clear removes it.')}`,
      placeholder:row.content.values[key]??'',
      onCancel:()=>{if(active(version)){generation++;if(index)save(row,{index:index-1});else previous();}},
      onConfirm:value=>{
        if(!active(version))return;generation++;
        const entered=String(value).trim(),text=entered==='/clear'?'':entered||(row.content.values[key]??'');
        if(text.length>1200 || key==='hours' && (!Number.isFinite(Number(text))||Number(text)<=0||Number(text)>720))
          return message(label('字段过长或有效小时数不正确。','Field too long or invalid enrollment hours.'),()=>render(row));
        save(row,{values:{...row.content.values,[key]:text},index:index+1<items.length?index+1:0,...(index+1===items.length?{step:next}:{})});
      }});
  }
  function render(row) {
    if(!isCurrent())return;
    if(row.status!=='editing')return operation(row.id);
    if(row.content.eventKind)return renderEvent(row);
    const content=row.content,back=()=>openDraft(row.id);
    switch(content.step){
      case 'details':return fields(row,details,'visibility',back);
      case 'visibility':return menu(label('请求可见性','Request visibility'),[
        [label('私有：指定参与者','Private: named participants'),()=>save(row,{visibility:'Private',step:'viewers',index:0})],
        [label('公开请求说明','Public request description'),()=>save(row,{visibility:'Public',values:{...content.values,viewers:''},step:'budget',index:0})]
      ],()=>save(row,{step:'details',index:6}));
      case 'viewers':return fields(row,[['viewers',label('参与者Galaxy ID，逗号分隔；留空仅自己','Participant Galaxy IDs, comma separated; empty means yourself')]],'budget',()=>save(row,{step:'visibility',index:0}));
      case 'budget':return menu(label('协作与预算说明','Collaboration and budget'),[
        ['open',label('开放协助','Open assistance')],['fixed',label('固定金额','Fixed amount')],
        ['range',label('预算区间','Budget range')],['quote',label('请求报价','Request quote')]
      ].map(([mode,title])=>[title,()=>save(row,{mode,qualification:null,step:mode==='open'?'qualification':'budget-fields',index:0})]),
      ()=>save(row,{step:content.visibility==='Private'?'viewers':'visibility',index:0}));
      case 'budget-fields':return fields(row,[
        ...(content.mode==='fixed'?[['amount',label('金额','Amount')]]:content.mode==='range'?[['minimum',label('最低金额','Minimum')],['maximum',label('最高金额','Maximum')]]:[]),
        ['unit',label('结算单位（仅说明）','Unit (description only)')]
      ],'qualification',()=>save(row,{step:'budget',index:0}));
      case 'qualification': {
        if(!content.values.capabilityId)return save(row,{qualification:null,step:'review',index:0});
        if(!controller.qualificationPolicies)return menu(label('连接后可读取参与资格政策；草稿已保存。','Connect to read participation policies; the draft is saved.'),[
          [label('暂不设置资格政策','Continue without a qualification policy'),()=>save(row,{qualification:null,step:'review',index:0})],
        ],back);
        return void run(()=>controller.qualificationPolicies(),result=>menu(label('参与资格政策','Participation policy'),[
          [label('不设资格政策','No qualification policy'),()=>save(row,{qualification:null,step:'review',index:0})],
          ...result.policies.filter(p=>p.capabilityId===content.values.capabilityId&&p.collaboration===(content.mode==='open'?'open-assistance':'basic-bounty'))
            .map(p=>[plain(p.title),()=>save(row,{qualification:{policyId:p.id,policyVersion:p.version},step:'review',index:0}),`${plain(p.id)} @ ${plain(p.version)}`])
        ],()=>save(row,{step:'budget',index:0})),back);
      }
      case 'review':return menu(`${label('继续确认协作草稿','Review collaboration draft')}\n${plain(content.values.title)}\n${plain(content.values.problem)}\n${plain(content.values.scope)}\n${plain(content.visibility)} · ${plain(content.mode)}\n${label('尚未提交。到期时间将在下一步固定。','Not submitted. The deadline is fixed in the next preview.')}`,[
        ...(canSubmit?[[label('预览完整请求与授权','Preview full request and Consent'),()=>submit(row)]]:[]),
        [label('修改草稿','Edit draft'),()=>save(row,{step:'details',index:0})],
        [label('留待以后继续','Continue later'),open],
      ],back);
    }
  }
  function submit(row) {
    const {values,visibility,mode,qualification}=row.content,hours=Number(values.hours);
    if(!Number.isFinite(hours)||hours<=0||hours>720)return message(label('请修改招募有效小时数。','Edit enrollment hours.'),()=>render(row));
    const request={id:row.id,caseId:values.caseId,title:values.title,problem:values.problem,
      attemptedApproaches:(values.attempts??'').split(/[;；]/).map(s=>s.trim()).filter(Boolean),scope:values.scope,
      ...(values.capabilityId?{capabilityId:values.capabilityId}:{}),visibility,collaboration:mode==='open'?'open-assistance':'basic-bounty',
      ...(mode==='open'?{}:{budget:{mode,unit:values.unit,...(mode==='fixed'?{amount:values.amount}:mode==='range'?{minimum:values.minimum,maximum:values.maximum}:{})}}),
      ...(qualification?{qualification}:{}),enrollmentExpiresAt:Math.floor(Date.now()/1000+hours*3600)};
    const viewers=visibility==='Private'?(values.viewers??'').split(/[,，]/).map(s=>s.trim()).filter(Boolean):[];
    generation++;
    onConfirm({draftId:row.id,draftRevision:row.revision,request,viewers},()=>openDraft(row.id));
  }
  function openDraft(id) {
    void run(()=>controller.getAssistanceDraft(id),row=>{
      if(row.status!=='editing')return operation(row.id);
      menu(`${label('本地草稿','Local draft')}: ${row.content.eventKind?plain(row.content.eventKind)+' · '+plain(row.content.source.title):plain(row.content.values.title)||plain(row.id)}`,[
        [label('继续填写','Continue editing'),()=>row.content.eventKind&&canSubmit?checkEventVersion(row,render):render(row)],
        ...(row.content.eventKind?[[label('查看已保存内容','View saved content'),()=>message(JSON.stringify(row.content,null,2),()=>openDraft(id))]]:[]),
        [label('删除本地草稿','Remove local draft'),()=>void run(()=>controller.forgetAssistanceDraft(id),open)],
      ],open);
    },open);
  }
  function operation(eventId) {
    void run(()=>controller.listCollaborationOperations(),page=>{
      const row=page.items.find(item=>item.eventId===eventId);
      if(!row)return message(label('本地提交记录不存在。','Local operation unavailable.'),open);
      const refresh=()=>operation(eventId),entries=[
        ...(canSubmit?[[label('核对服务端接收结果','Check server acknowledgement'),()=>void run(()=>controller.reconcileCollaboration(eventId),result=>{
          menu(`${label('接收结果','Acknowledgement')}: ${plain(result.state)}\n${label('仅确认历史接收，不表示仍有访问权限。','Historical acceptance only; current access is separate.')}`,[
            ...(result.state==='absent'?[[label('预览原内容并重试','Preview original content and retry'),()=>{generation++;onConfirm(eventId,refresh,true);}]]:[]),
            [label('打开当前协作请求','Open current request'),()=>{generation++;onOpenRequest(row.assistanceId);}]
          ],refresh);
        },refresh)],
        [label('打开当前协作请求','Open current request'),()=>{generation++;onOpenRequest(row.assistanceId);}]]:[]),
        ...(['prepared','acknowledged'].includes(row.status)?[[label('删除本地提交记录','Remove local operation record'),()=>void run(()=>controller.forgetCollaborationOperation(eventId),open,refresh)]]:[]),
      ];
      menu(`${plain(row.title)||plain(row.kind)}\n${plain(row.assistanceId)}\n${plain(row.eventId)}\n${plain(row.status)}${canSubmit?'':'\n'+label('连接后才能核对服务端结果或重试。','Connect before checking server results or retrying.')}`,entries,open);
    },open);
  }
  function open() {
    void run(async()=>({drafts:await controller.listAssistanceDrafts(),operations:await controller.listCollaborationOperations()}),({drafts,operations})=>{
      menu(label('本地协作草稿与提交记录','Local collaboration drafts and submissions'),[
        ...drafts.items.filter(row=>row.status==='editing').map(row=>[plain(row.title)||label('未命名草稿','Untitled draft'),()=>openDraft(row.id),plain(row.updatedAt)]),
        ...operations.items.map(row=>[`${plain(row.title)||plain(row.kind)} · ${plain(row.status)}`,()=>operation(row.eventId),plain(row.eventId)]),
        [label('新建协作草稿','New collaboration draft'),create],
      ]);
    });
  }
  function create(){void run(()=>controller.createAssistanceDraft(),render);}
  const eventLabels={
    participantId:['参与者 Galaxy ID','Participant Galaxy ID'],note:['说明','Note'],proposal:['申请方案','Proposal'],scope:['协作范围','Scope'],
    reason:['原因','Reason'],attemptId:['关联 Attempt ID','Related Attempt ID'],summary:['说明与结果','Summary'],
    evidenceIds:['Evidence ID，逗号分隔','Evidence IDs, comma separated'],proofIds:['资格 Proof ID，逗号分隔','Qualification Proof IDs, comma separated'],
    assistanceIds:['已验收协作 ID，逗号分隔','Accepted assistance IDs, comma separated'],
    descriptionClarity:['描述清晰度：clear / partly-clear / unclear','Description clarity: clear / partly-clear / unclear'],
    scopeMatched:['实际工作符合范围：yes / no','Work matched scope: yes / no'],
  };
  function renderEvent(row){
    const c=row.content,back=()=>openDraft(row.id),prompts=eventDraftFields[c.eventKind].map(key=>[key,label(...eventLabels[key])]);
    const afterFields=c.eventKind==='offer'?(c.source.qualification?'qualification':c.source.collaboration==='basic-bounty'?'budget':'review'):'review';
    if(c.step==='fields')return prompts.length?fields(row,prompts,afterFields,back):save(row,{step:'review',index:0});
    if(c.step==='qualification')return fields(row,['proofIds','assistanceIds'].map(key=>[key,label(...eventLabels[key])]),
      c.source.collaboration==='basic-bounty'?'budget':'review',()=>save(row,{step:'fields',index:Math.max(0,prompts.length-1)}));
    if(c.step==='budget')return menu(label('申请报价','Offer quote'),[
      ['open',label('不报价','No quote')],['fixed',label('固定金额','Fixed amount')],['range',label('预算区间','Budget range')],['quote',label('请求报价','Request quote')],
    ].map(([mode,title])=>[title,()=>save(row,{mode,step:mode==='open'?'review':'budget-fields',index:0})]),
      ()=>save(row,{step:c.source.qualification?'qualification':'fields',index:0}));
    if(c.step==='budget-fields')return fields(row,[
      ...(c.mode==='fixed'?[['amount',label('金额','Amount')]]:c.mode==='range'?[['minimum',label('最低金额','Minimum')],['maximum',label('最高金额','Maximum')]]:[]),
      ['unit',label('结算单位（仅说明）','Unit (description only)')],
    ],'review',()=>save(row,{step:'budget',index:0}));
    menu(`${label('协作事件草稿','Collaboration event draft')} · ${plain(c.eventKind)}\n${plain(c.source.title)}\nv${c.source.version} · ${plain(c.source.state)}\n${plain(c.source.agreedScope)}\n${c.eventKind==='deliver'?`${label('Case纠正/复核版本','Case correction/review version')}: ${plain(c.source.caseReviewVersion??label('未绑定；不能用于纠正后恢复','Unbound; cannot restore corrected work'))}\n`:''}${(c.target.outcome??c.source.resolutionOutcome)==='resume-work'?label('双方确认后继续工作，需重新交付与验收。','Both parties confirm resuming work; a new delivery and acceptance are required.')+'\n':''}${plain(JSON.stringify(c.values))}\n${plain(JSON.stringify(c.target))}`,[
      ...(canSubmit?[[label('预览事件与授权','Preview event and Consent'),()=>checkEventVersion(row,submitEvent)]]:[]),
      ...(canSubmit&&c.source.visibility==='Public'&&publicContributionEventKinds.includes(c.eventKind)?[[c.eventKind==='requester-feedback'?label('预览公开反馈','Preview public feedback'):label('预览公开贡献事件','Preview public contribution event'),()=>checkEventVersion(row,current=>submitEvent(current,'Public')),
        c.eventKind==='requester-feedback'?label('提供者本人评价；不计入贡献或能力分。','The provider’s own assessment; no contribution or capability points.'):
          label('此次事件用于公开履历；确认前展示全部内容。','This event may support public history; review all content before confirming.')]]:[]),
      ...(prompts.length?[[label('修改草稿','Edit draft'),()=>save(row,{step:'fields',index:0})]]:[]),
      [label('留待以后继续','Continue later'),open],
    ],back);
  }
  function checkEventVersion(row,done){
    const back=()=>openDraft(row.id);
    void run(()=>controller.getAssistance(row.content.source.assistanceId),current=>{
      try{checkEventDraftTarget(row.content,current);}catch(error){return message(plain(error.message),back);}
      if(current.version===row.content.source.version&&(row.content.eventKind!=='deliver'||current.deliverySource?.reviewVersion===row.content.source.caseReviewVersion))return done(row);
      const old=row.content.source;
      menu(`${label('协作版本已变化；已填内容保留','Collaboration changed; saved text is retained')}\n${label('原记录','Saved')}: v${old.version} · ${plain(old.state)} · Case ${plain(old.caseReviewVersion)}\n${plain(old.selected?.providerId)} · ${plain(old.agreedScope)}\n${label('当前记录','Current')}: v${current.version} · ${plain(current.state)} · Case ${plain(current.deliverySource?.reviewVersion)}\n${plain(current.selected?.providerId)} · ${plain(current.agreedScope)}\n${label('待确认范围','Pending scope')}: ${plain(current.pendingScope)}`,[
        [label('按当前版本继续编辑','Continue editing against current version'),()=>void run(()=>controller.rebaseAssistanceDraft({id:row.id,expectedRevision:row.revision,record:current}),render,back)],
        [label('查看已保存内容','View saved content'),()=>message(JSON.stringify(row.content,null,2),back)],
        [label('打开当前协作请求','Open current request'),()=>{generation++;onOpenRequest(old.assistanceId);}],
      ],back);
    },back);
  }
  function submitEvent(row,eventVisibility='Private'){
    let event;try{event=eventFromDraft(row);}catch(error){return message(plain(error.message),()=>openDraft(row.id));}
    generation++;onConfirm({draftId:row.id,draftRevision:row.revision,assistanceId:row.content.source.assistanceId,event,...(eventVisibility==='Public'?{eventVisibility}: {})},()=>openDraft(row.id));
  }
  function createEvent(input){void run(()=>controller.createAssistanceEventDraft(input),render);}
  return Object.freeze({open,create,openDraft,createEvent});
}
