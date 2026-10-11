import { eventDraftFields, eventFromDraft, checkEventDraftTarget } from '../../../packages/galaxy-official/src/shared/assistance-event-draft.mjs';
import { publicContributionEventKinds } from '../../../packages/galaxy-official/src/shared/assistance-schema.mjs';
import {createLegacyWorkSelection} from './legacy-work-selection.mjs';
import {createExistingRecordSelection} from './existing-record-selection.mjs';
import {showExactChoice} from './exact-choice.mjs';
import {assistanceDraftApproaches} from '../../../packages/galaxy-official/src/local-assistance-store.mjs';
// Native persisted collaboration wizard. Saving fields is local.
export function createAssistanceDraftMenu({controller,select,prompt,info,language,isCurrent,onBack,onConfirm,onOpenRequest,canSubmit=true,readWorkContext}) {
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
  function form(title,items,done,back,draft={},index=0){if(index===items.length)return done(draft);const [key,name,initial='']=items[index],version=++generation;
    prompt({title:title===name?title:title+'\n'+name,placeholder:name,value:String(draft[key]??initial),onCancel:()=>{if(active(version)){generation++;back();}},onConfirm:value=>{if(!active(version))return;generation++;draft[key]=String(value).trim();form(title,items,done,back,draft,index+1);}});}
  const workSelection=createLegacyWorkSelection({controller,menu,form,message,run,label,plain,readWorkContext});
  const records=createExistingRecordSelection({controller,menu,message,run,label,plain});
  const split=value=>String(value??'').split(/[,，]/).map(s=>s.trim()).filter(Boolean);
  const eventName=kind=>({invite:label('邀请参与','Invite participation'),offer:label('申请协助','Offer help'),'withdraw-offer':label('撤回申请','Withdraw offer'),shortlist:label('选择候选人','Choose candidates'),select:label('选择参与者','Choose participant'),confirm:label('确认参与','Confirm participation'),'change-scope':label('调整协作范围','Change scope'),'confirm-scope':label('确认新范围','Confirm scope'),deliver:label('交付结果','Deliver result'),accept:label('验收交付','Accept delivery'),cancel:label('取消协作','Cancel collaboration'),expire:label('结束招募','End enrollment'),dispute:label('提出异议','Raise dispute'),'propose-resolution':label('提出处理方案','Propose resolution'),'confirm-resolution':label('确认处理方案','Confirm resolution'),'requester-feedback':label('评价请求说明','Assess request description')}[kind]??plain(kind));
  const operationState=value=>({prepared:label('尚未确认完成','Completion not confirmed'),acknowledged:label('已完成','Completed'),unknown:label('暂未确认结果','Outcome unconfirmed'),absent:label('原内容尚未收到','Original content not received')}[value]??plain(value));
  function valuesText(content){const values=content.values??{},rows=[];
    for(const [key,name]of [['title',label('标题','Title')],['problem',label('工作情况','Work context')],['proposal',label('申请方案','Proposal')],['scope',content.eventKind?label('范围','Scope'):label('希望得到的协助','Requested help')],['summary',label('结果与说明','Result and explanation')],['reason',label('原因','Reason')],['note',label('补充说明','Note')]])if(values[key])rows.push(name+'\n'+plain(values[key]));
    const approaches=assistanceDraftApproaches(content);if(approaches.length)rows.push(label('已有尝试','Previous approaches')+'\n'+approaches.map(plain).join('\n'));
    if(values.participantId)rows.push(label('接收身份','Recipient identity')+'\n'+plain(values.participantId));
    if(values.evidenceIds)rows.push(label('附加材料','Additional materials')+'：'+split(values.evidenceIds).length);
    if(values.proofIds)rows.push(label('已选 CI 来源','Selected CI sources')+'：'+split(values.proofIds).length);
    if(values.assistanceIds)rows.push(label('已选验收工作','Selected accepted work')+'：'+split(values.assistanceIds).length);
    if(values.descriptionClarity)rows.push(label('描述清晰度','Description clarity')+'：'+({clear:label('清楚','Clear'),'partly-clear':label('部分清楚','Partly clear'),unclear:label('不清楚','Unclear')}[values.descriptionClarity]??plain(values.descriptionClarity)));
    if(values.scopeMatched)rows.push(label('符合原范围','Matched scope')+'：'+(values.scopeMatched==='yes'?label('是','Yes'):values.scopeMatched==='no'?label('否','No'):plain(values.scopeMatched)));
    if(content.mode==='fixed')rows.push(label('金额','Amount')+'：'+plain(values.amount)+' '+plain(values.unit));
    if(content.mode==='range')rows.push(label('区间','Range')+'：'+plain(values.minimum)+'–'+plain(values.maximum)+' '+plain(values.unit));
    if(content.mode==='quote')rows.push(label('请求报价','Request quote')+' · '+plain(values.unit));
    return rows.join('\n\n');
  }
  const details = [
    ['caseId',label('已保存的原工作引用','Saved original work reference')],
    ['title',label('标题','Title')],['problem',label('问题说明','Problem')],
    ['attempts',label('已有尝试（可留空）','Previous approaches (optional)')],
    ['scope',label('希望得到怎样的协助','What help would you like')],
    ['hours',label('招募有效小时数（大于0，最多720）','Enrollment hours (over 0, at most 720)')],
  ];
  function fields(row,items,next,previous) {
    const index=Math.min(row.content.index,items.length-1),[key,title]=items[index],version=++generation;
    const storeValue=text=>save(row,{values:{...row.content.values,[key]:text},index:index+1<items.length?index+1:0,...(index+1===items.length?{step:next}:{})});
    if(key==='caseId'&&!canSubmit)return storeValue(row.content.values.caseId??'');
    if(items===details&&key==='hours'&&(row.content.mode??'open')==='open')return storeValue(row.content.values.hours||'24');
    if(key==='caseId'&&controller.queryHistory)return workSelection.select(work=>void run(()=>workSelection.reread(work),fresh=>{const approaches=(fresh.attempts??[]).map(a=>a.approach).filter(Boolean);save(row,{values:{...row.content.values,caseId:fresh.caseId,
      title:row.content.values.title||fresh.title,problem:row.content.values.problem||fresh.summary,
      attempts:row.content.values.attempts??''},...(!Array.isArray(row.content.attemptedApproaches)&&!row.content.values.attempts?{attemptedApproaches:approaches}:{}),index:4,mode:row.content.mode??'open'});},previous),previous,{preferredCaseId:row.content.values.caseId});
    if(key==='attempts')return editApproaches(row,approaches=>save(row,{attemptedApproaches:approaches,values:{...row.content.values,attempts:''},index:index+1<items.length?index+1:0,...(index+1===items.length?{step:next}:{})}),previous);
    if(key==='attemptId'&&canSubmit&&controller.queryHistory)return void run(()=>controller.getAssistance(row.content.source.assistanceId),record=>{
      const caseId=record.deliverySource?.caseId??record.request?.caseId;
      if(!caseId)return message(label('当前请求未提供可读取的原工作。可返回原工作取回已有引用；不会创建替代记录。','This request has no readable work reference. Return to the original work for its existing reference; no substitute record is created.'),previous);
      workSelection.select(work=>void run(()=>workSelection.reread(work),fresh=>storeValue(fresh.attempt.id),previous),previous,{mode:'attempt',requiredCaseId:caseId,subjectId:record.requesterId});
    },previous);
    if(key==='evidenceIds'&&canSubmit&&controller.queryHistory)return menu(label('这次交付的附加材料','Additional materials for this delivery'),[
      [label('不引用其他材料','Do not cite additional materials'),()=>storeValue('')],
      ...(row.content.values.evidenceIds?[[label('沿用已保存的材料引用','Keep saved material references'),()=>storeValue(row.content.values.evidenceIds),label('仍按原工作和当前权限核对','Still checked against the original work and current permissions')]]:[]),
      [label('使用已有原材料引用','Use existing original material references'),()=>form(label('原工作中的材料引用','Material references in the original work'),[[key,label('你已掌握的原材料引用，逗号分隔','Original references you already hold, comma separated')]],v=>storeValue(v[key]),()=>fields(row,items,next,previous))]
    ],previous);
    if((key==='proofIds'&&canSubmit&&controller.querySearch)||(key==='assistanceIds'&&canSubmit&&controller.queryAssistance))return selectQualification(row,key,storeValue,previous);
    const currentWorkScope=key==='scope'&&items===details&&controller.queryHistory;
    prompt({title:currentWorkScope?label('希望得到怎样的协助','What help would you like')+'\n'+plain(row.content.values.title):`${label('求助内容','Help request')}\n${title}\n${label('留空保留原值；/clear清空。','Empty keeps the saved value; /clear removes it.')}`,
      placeholder:title,value:row.content.values[key]??'',
      onCancel:()=>{if(active(version)){generation++;if(currentWorkScope)previous();else if(index)save(row,{index:index-1});else previous();}},
      onConfirm:value=>{
        if(!active(version))return;generation++;
        const entered=String(value).trim(),text=entered==='/clear'?'':entered||(row.content.values[key]??'');
        if(text.length>1200 || key==='hours' && (!Number.isFinite(Number(text))||Number(text)<=0||Number(text)>720))
          return message(label('字段过长或有效小时数不正确。','Field too long or invalid enrollment hours.'),()=>render(row));
        if(currentWorkScope)return save(row,{values:{...row.content.values,scope:text},index:0,step:row.content.visibility?'review':'visibility'});
        storeValue(text);
      }});
  }
  function editApproaches(row,done,back){
    const approaches=assistanceDraftApproaches(row.content);
    const valid=items=>items.length<=8&&items.every(item=>item.length<=1200);
    const invalid=again=>message(label('这份求助可附最多8条已有尝试，每条最多1200字。原内容仍保留，可以修改后继续。','A request can include at most 8 previous approaches, each up to 1200 characters. The original content is retained; edit it to continue.'),again);
    if(!approaches.some(value=>/[\r\n]/.test(value))){
      const version=++generation;
      return prompt({title:label('已有尝试（每行一条，可留空）','Previous approaches (one per line, optional)'),value:approaches.join('\n'),
        placeholder:label('写下已经试过的方法','Describe approaches you have already tried'),onCancel:()=>{if(active(version)){generation++;back();}},
        onConfirm:value=>{if(!active(version))return;generation++;const items=String(value).split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
          if(!valid(items))return invalid(()=>editApproaches({...row,content:{...row.content,attemptedApproaches:items}},done,back));done(items);}});
    }
    const show=()=>menu(label('已有尝试','Previous approaches'),[
      [label('保存已有尝试','Save previous approaches'),()=>valid(approaches)?done(approaches):invalid(show)],
      ...approaches.map((value,index)=>[label('尝试 ','Approach ')+(index+1),()=>{
        const version=++generation;prompt({title:label('修改这条尝试（留空移除）','Edit this approach (empty removes it)'),value,placeholder:label('这条尝试的完整内容','Full content of this approach'),
          onCancel:()=>{if(active(version)){generation++;show();}},onConfirm:input=>{if(!active(version))return;generation++;const text=String(input).trim();if(text)approaches[index]=text;else approaches.splice(index,1);show();}});
      },plain(value)]),
      ...(approaches.length<8?[[label('补充尝试','Add an approach'),()=>{const version=++generation;prompt({title:label('补充一条已有尝试','Add a previous approach'),value:'',placeholder:label('已经试过的方法','An approach already tried'),onCancel:()=>{if(active(version)){generation++;show();}},onConfirm:value=>{if(!active(version))return;generation++;const text=String(value).trim();if(text)approaches.push(text);show();}});}]]:[]),
    ],back);show();
  }
  function selectQualification(row,key,done,back){const kind=key==='proofIds'?'proof':'assistance',chosen=split(row.content.values[key]);
    const show=()=>menu(key==='proofIds'?label('选择资格所需的 CI 来源','Choose CI sources for qualification'):label('选择已验收的本人协作','Choose your accepted collaborations'),[
      ...(chosen.length?[[label('使用已选来源','Use selected sources'),()=>done(chosen.join(',')),label('已选 ','Selected ')+chosen.length]]:[]),
      ...(chosen.length<16?[[label('从当前可读记录选择','Choose currently readable records'),()=>void run(()=>controller.status?.(),status=>records.select(kind,item=>{if(!chosen.includes(item.id))chosen.push(item.id);show();},show,{subjectId:status?.subjectId,assistanceView:'participating',filter:record=>kind!=='assistance'||record.state==='accepted'}),show)]]:[]),
      [label('不引用此类来源','Do not cite this kind of source'),()=>done('')],
      [label('查看已选引用','Inspect selected references'),()=>message(chosen.join('\n')||label('尚未选择。','Nothing selected.'),show)]
    ],back);show();}
  function render(row) {
    if(!isCurrent())return;
    if(row.status!=='editing')return operation(row.id);
    if(row.content.eventKind)return renderEvent(row);
    const content=row.content,back=()=>openDraft(row.id);
    switch(content.step){
      case 'details':return fields(row,details,'visibility',back);
      case 'visibility':return menu(label('请求可见性','Request visibility'),[
        [label('仅自己','Only me'),()=>save(row,{visibility:'Private',values:{...content.values,viewers:''},mode:content.mode??'open',step:'review',index:0})],
        [label('私有：指定参与者','Private: named participants'),()=>save(row,{visibility:'Private',step:'viewers',index:0})],
        [label('公开请求说明','Public request description'),()=>save(row,{visibility:'Public',values:{...content.values,viewers:''},step:'review',mode:content.mode??'open',index:0})]
      ],()=>save(row,{step:'details',index:4}));
      case 'viewers':return fields(row,[['viewers',label('已有参与者的稳定身份，逗号分隔；留空仅自己','Existing participant identities, comma separated; empty means yourself')]],'review',()=>save(row,{step:'visibility',index:0}));
      case 'budget':return menu(label('协作与预算说明','Collaboration and budget'),[
        ['open',label('开放协助','Open assistance')],['fixed',label('固定金额','Fixed amount')],
        ['range',label('预算区间','Budget range')],['quote',label('请求报价','Request quote')]
      ].map(([mode,title])=>[title,()=>save(row,{mode,qualification:null,step:mode==='open'?'qualification':'budget-fields',index:0})]),
      ()=>save(row,{step:controller.queryHistory?'review':content.visibility==='Private'?'viewers':'visibility',index:0}));
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
            .map(p=>[plain(p.title),()=>save(row,{qualification:{policyId:p.id,policyVersion:p.version},step:'review',index:0}),label('版本 ','Version ')+plain(p.version)])
        ],()=>save(row,{step:'budget',index:0})),back);
      }
      case 'review':if(canSubmit&&controller.prepareCollaborationDraft)return requestPreview(row);
        return menu(`${plain(content.values.title)||label('准备求助','Prepare help request')}\n${valuesText({...content,values:{...content.values,title:''}})}\n${content.visibility==='Public'?label('公开所选说明','Public selected description'):content.values.viewers?label('自己与指定参与者','You and named participants'):label('仅自己','Only me')}`,[
        ...(canSubmit?[[label('发布求助','Publish request'),()=>submit(row)]]:[]),
        ...(controller.queryHistory?[
          [label('修改内容','Edit content'),()=>editRequest(row)],
          [label('调整可见范围','Change visibility'),()=>save(row,{step:'visibility',index:0})],
          [label('更多设置','More settings'),()=>requestSettings(row)]
        ]:[[label('修改草稿','Edit draft'),()=>save(row,{step:'details',index:0})]]),
        [label('稍后继续','Continue later'),open],
      ],back);
    }
  }
  function requestSettings(row){const c=row.content,back=()=>render(row);
    menu(label('求助设置','Request settings'),[
      [label('求助有效时间','Request duration'),()=>form(label('求助有效时间','Request duration'),[details[5]],values=>{
        const hours=Number(values.hours);if(!Number.isFinite(hours)||hours<=0||hours>720)return message(label('有效时间必须大于0且不超过720小时。','Duration must be over 0 and at most 720 hours.'),()=>requestSettings(row));
        save(row,{values,step:'review',index:0});
      },back,{...c.values})],
      [label('选择其他已有工作','Choose another existing work'),()=>save(row,{step:'details',index:0})],
      [label('来源与完整草稿','Source and full draft'),()=>message(JSON.stringify(c,null,2),()=>requestSettings(row))],
    ],back);
  }
  function editRequest(row){
    menu(label('修改求助内容','Edit request'),[4,1,2,3].map(index=>{
      const [key,title]=details[index];return[title,()=>key==='attempts'?editApproaches(row,approaches=>save(row,{attemptedApproaches:approaches,values:{...row.content.values,attempts:''},step:'review',index:0}),()=>editRequest(row)):form(title,[[key,title]],values=>save(row,{values,step:'review',index:0}),()=>editRequest(row),{...row.content.values}),key==='attempts'?assistanceDraftApproaches(row.content).map(plain).join('\n'):plain(row.content.values[key])];
    }),()=>render(row));
  }
  function requestPreview(row){
    const back=()=>openDraft(row.id);
    const approaches=assistanceDraftApproaches(row.content);if(approaches.length>8||approaches.some(value=>value.length>1200))return message(label('当前已有尝试超过这份求助允许的内容长度。原文仍保留，可以选择要附上的尝试。','The current approaches exceed this request’s content limits. Original text is retained; choose the approaches to include.'),()=>editApproaches(row,items=>save(row,{attemptedApproaches:items,values:{...row.content.values,attempts:''},step:'review',index:0}),back));
    void run(()=>controller.prepareCollaborationDraft({draftId:row.id,draftRevision:row.revision}),preview=>{
      const version=generation;
      const edit=action=>{if(!active(version))return;generation++;controller.cancel();action();};
      const request=JSON.parse(preview.payloadJson);
      showExactChoice({preview,title:plain(request.title)||label('发布求助','Publish help request'),select,info,language,reviewInBody:true,showAuthorizationExpiry:false,
        allowLabel:label('发布求助','Publish request'),isCurrent:()=>active(version),
        readableContent:{problem:request.problem,requestedScope:request.scope,attemptedApproaches:request.attemptedApproaches.join('\n'),
          ...(request.budget?{notes:valuesText(row.content)}:{})},
        note:label('求助有效至：','Request available until: ')+new Date(request.enrollmentExpiresAt*1000).toLocaleString(zh?'zh-CN':'en-US'),
        actions:[
          [label('修改内容','Edit content'),()=>edit(()=>editRequest(row))],
          [label('调整可见范围','Change visibility'),()=>edit(()=>save(row,{step:'visibility',index:0}))],
          [label('更多设置','More settings'),()=>edit(()=>requestSettings(row))],
        ],onCancel:()=>edit(back),onConfirm:async confirmation=>{
          if(!active(version))return;
          const submitted=++generation;
          info('Galaxy',label('正在发布；Esc返回后会接续同一次操作。','Publishing; after Esc, continue this same operation.'),()=>{if(active(submitted)){generation++;controller.cancel();operation(row.id);}});
          try{
            const receipt=await controller.executeCollaboration(preview,confirmation);
            if(active(submitted))message(label('这份求助已发布。','This request was published.'),()=>onOpenRequest(receipt.assistanceId));
          }catch{
            if(!active(submitted))return;
            let saved;try{saved=await controller.getAssistanceDraft(row.id);}catch{/* Keep unavailable owner data closed. */}
            if(!active(submitted))return;
            if(saved?.status==='editing')return message(label('暂时未能发布；已填内容保存在本机，可以返回当前草稿继续。','Publication did not complete. Your content is saved locally; continue the current draft.'),()=>openDraft(row.id));
            message(label('暂未确认结果；继续时读取原操作，已填内容保留。','The outcome is unconfirmed. Continuing reads the original operation; your content is retained.'),()=>operation(row.id));
          }
        }});
    },back);
  }
  function submit(row) {
    const {values,visibility,mode,qualification}=row.content,hours=Number(values.hours);
    if(!values.caseId)return message(label('草稿已保存。连接后选择原工作，再提交这份求助。','The draft is saved. Connect and choose the original work before submitting.'),()=>save(row,{step:'details',index:0}));
    if(!Number.isFinite(hours)||hours<=0||hours>720)return message(label('请修改招募有效小时数。','Edit enrollment hours.'),()=>render(row));
    const request={id:row.id,caseId:values.caseId,title:values.title,problem:values.problem,
      attemptedApproaches:assistanceDraftApproaches(row.content),scope:values.scope,
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
      menu(`${label('本地草稿','Local draft')}: ${row.content.eventKind?eventName(row.content.eventKind)+' · '+plain(row.content.source.title):plain(row.content.values.title)||label('未命名草稿','Untitled draft')}`,[
        [label('继续填写','Continue editing'),()=>row.content.eventKind&&canSubmit?checkEventVersion(row,render):render(row)],
        ...(row.content.eventKind?[[label('查看已保存内容','View saved content'),()=>message(valuesText(row.content),()=>openDraft(id))],[label('查看原草稿字段与来源','Inspect original draft fields and source'),()=>message(JSON.stringify(row.content,null,2),()=>openDraft(id))]]:[]),
        [label('删除本地草稿','Remove local draft'),()=>void run(()=>controller.forgetAssistanceDraft(id),open)],
      ],open);
    },open);
  }
  function operation(eventId) {
    void run(async()=>{const page=await controller.listCollaborationOperations(),row=page.items.find(item=>item.eventId===eventId);
      let result,readError;if(row&&canSubmit&&controller.reconcileCollaboration){try{result=await controller.reconcileCollaboration(eventId);}catch(error){readError=plain(error.message);}}
      return{row,result,readError};},({row,result,readError})=>{
      if(!row)return message(label('本地提交记录不存在。','Local operation unavailable.'),open);
      const again=()=>operation(eventId),entries=[
        ...(canSubmit?[
          ...(readError?[[label('重试读取','Retry reading'),again]]:[]),
          ...(result?.state==='absent'?[[label('预览原内容并重试','Preview original content and retry'),()=>{generation++;onConfirm(eventId,again,true);}]]:[]),
          [label('打开当前协作请求','Open current request'),()=>{generation++;onOpenRequest(row.assistanceId);}]
        ]:[]),
        [label('查看原提交来源','Inspect original submission source'),()=>message(JSON.stringify({record:row,currentRead:result??null},null,2),again)],
        ...(['prepared','acknowledged'].includes(row.status)?[[label('删除本地提交记录','Remove local operation record'),()=>void run(()=>controller.forgetCollaborationOperation(eventId),open,again)]]:[]),
      ];
      menu(`${plain(row.title)||eventName(row.kind)}\n${operationState(result?.state??row.status)}${readError?'\n'+label('暂未取得当前结果；原内容已保留。','Current outcome unavailable; the original content is retained.'):''}${canSubmit?'':'\n'+label('连接后才能读取当前结果或重试。','Connect before reading the current result or retrying.')}`,entries,open);
    },open);
  }
  function open() {
    void run(async()=>({drafts:await controller.listAssistanceDrafts(),operations:await controller.listCollaborationOperations()}),({drafts,operations})=>{
      menu(label('继续未完成内容','Continue saved work'),[
        ...drafts.items.filter(row=>row.status==='editing').map(row=>[plain(row.title)||label('未命名草稿','Untitled draft'),()=>openDraft(row.id),plain(row.updatedAt)]),
        ...operations.items.map(row=>[`${plain(row.title)||eventName(row.kind)} · ${operationState(row.status)}`,()=>operation(row.eventId),plain(row.updatedAt)]),
        [label('发起求助','Ask for help'),create],
      ]);
    });
  }
  function create(){void run(()=>controller.createAssistanceDraft(),render);}
  const eventLabels={
    participantId:['参与者 Galaxy ID','Participant Galaxy ID'],note:['说明','Note'],proposal:['申请方案','Proposal'],scope:['协作范围','Scope'],
    reason:['原因','Reason'],attemptId:['已保存的原尝试引用','Saved original attempt reference'],summary:['说明与结果','Summary'],
    evidenceIds:['已有原材料引用（可不引用）','Existing original material references (optional)'],proofIds:['已有 CI 来源引用','Existing CI source references'],
    assistanceIds:['已有验收工作引用','Existing accepted work references'],
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
    menu(`${eventName(c.eventKind)}\n${plain(c.source.title)}\n${plain(c.source.agreedScope)}\n${c.eventKind==='deliver'?`${label('工作纠正/复核版本','Work correction/review version')}: ${plain(c.source.caseReviewVersion??label('未绑定；不能用于纠正后恢复','Unbound; cannot restore corrected work'))}\n`:''}${(c.target.outcome??c.source.resolutionOutcome)==='resume-work'?label('双方确认后继续工作，需重新交付与验收。','Both parties confirm resuming work; a new delivery and acceptance are required.')+'\n':''}${valuesText(c)}`,[
      ...(canSubmit?[[label('预览事件与授权','Preview event and Consent'),()=>checkEventVersion(row,submitEvent)]]:[]),
      ...(canSubmit&&c.source.visibility==='Public'&&publicContributionEventKinds.includes(c.eventKind)?[[c.eventKind==='requester-feedback'?label('预览公开反馈','Preview public feedback'):label('预览公开贡献事件','Preview public contribution event'),()=>checkEventVersion(row,current=>submitEvent(current,'Public')),
        c.eventKind==='requester-feedback'?label('提供者本人评价；不计入贡献或能力分。','The provider’s own assessment; no contribution or capability points.'):
          label('此次事件用于公开履历；确认前展示全部内容。','This event may support public history; review all content before confirming.')]]:[]),
      ...(prompts.length?[[label('修改草稿','Edit draft'),()=>save(row,{step:'fields',index:0})]]:[]),
      [label('查看原草稿字段与来源','Inspect original draft fields and source'),()=>message(JSON.stringify(c,null,2),()=>renderEvent(row))],
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
