import {showExactChoice} from './exact-choice.mjs';
import {createLegacyWorkSelection} from './legacy-work-selection.mjs';
export function createCapsuleMenu({controller,select,prompt,info,language,isCurrent,onBack,onReturnWork=onBack,availableScopes=null,readWorkContext}) {
  const zh=language!=='en-US',label=(a,b)=>zh?a:b,has=s=>!availableScopes||availableScopes.includes(s);
  const plain=(v,max=1200)=>String(v??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,max);
  const split=s=>String(s??'').split(/[,，;；]/).map(v=>v.trim()).filter(Boolean);
  let generation=0,viewGeneration=0,query='';
  const leave=()=>{generation++;controller.cancel();onBack();};
  const returnWork=()=>{generation++;viewGeneration++;controller.cancel();onReturnWork();};
  const message=(text,back=home,title=label('方法','Method'))=>{if(isCurrent())info(title,text,back);};
  function menu(title,entries,back=home,offset=0){if(!isCurrent())return;const routes={},view=++viewGeneration;
    const options=entries.slice(offset,offset+8).map(([title,action,description=''],i)=>{routes[i+1]=()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;action();}};return {number:String(i+1),title,description};});
    const activate=fn=>()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;fn();}};
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=activate(()=>menu(title,entries,back,offset+8));}
    select({title,options,routes,onBack:activate(offset?()=>menu(title,entries,back,offset-8):back)});}
  async function run(work,done,back=home){const version=++generation;message(label('正在读取或准备','Reading or preparing'),()=>{generation++;controller.cancel();back();});
    try{const result=await work();if(isCurrent()&&generation===version)done(result);}catch(error){if(isCurrent()&&generation===version)message(plain(error.message),back);}}
  function form(title,fields,done,back=home,draft={},index=0){if(!isCurrent())return;if(index===fields.length)return done(draft);
    const [key,name,initial='',maximum=1200]=fields[index],view=++viewGeneration;prompt({title:`${title} · ${index+1}/${fields.length}\n${name}`,value:String(draft[key]??initial),placeholder:'',
      onCancel:()=>{if(view!==viewGeneration||!isCurrent())return;viewGeneration++;if(index)form(title,fields,done,back,draft,index-1);else back();},onConfirm:value=>{if(!isCurrent()||view!==viewGeneration)return;viewGeneration++;if(String(value).length>maximum)return message(label('内容超长','Content is too long'),()=>form(title,fields,done,back,draft,index));draft[key]=String(value).trim();form(title,fields,done,back,draft,index+1);}});}
  const workSelection=createLegacyWorkSelection({controller,menu,form,message,run,label,plain,readWorkContext});
  function confirm(input,back){void run(()=>controller.prepareCapsule(input),preview=>{
    const cancel=()=>{generation++;controller.cancel();back();};let submitted=false;
    const version=generation;
    const choiceTitle=({version:label('发布这份方法','Publish this method'),reference:label('在原工作引用方法','Reference method in original work'),apply:label('保存这次应用结果','Save this application result'),reverify:label('保存这次再次验证','Save this reverification')})[input.kind]??label('保存这次选择','Save this choice');
    const allowLabel=({version:label('发布方法','Publish method'),reference:label('保存这次引用','Save this reference'),apply:label('保存应用结果','Save application result'),reverify:label('保存复查说明','Save reverification note')})[input.kind]??label('保存这次选择','Save this choice');
    const show=()=>showExactChoice({preview,title:choiceTitle,allowLabel,select,info,language,readBeforeChoice:true,isCurrent:()=>isCurrent()&&generation===version&&!submitted,onCancel:cancel,
      note:input.kind==='version'?label('允许发布表示已检查本次方法正文、来源与脱敏内容。','Allowing publication confirms your review of this method, sources and redaction.'):'',
      onConfirm:async value=>{if(!isCurrent()||submitted)return;
        submitted=true;const version=++generation;message(label('正在提交','Submitting'),cancel);
        try{await controller.executeCapsule(preview,value);if(isCurrent()&&generation===version)message(label('这份内容已保存。','This content was saved.'),back);}
        catch{if(isCurrent()&&generation===version)message(label('结果未确认，请先读取记录后再决定是否重试','Outcome unconfirmed; read existing records before retrying'),back);}}});show();
    },back);}
  function disclosure(input,back){menu(label('这份内容的可见性','Visibility of this content'),[
    [label('仅自己','Only me'),()=>confirm({...input,visibility:'Private',viewers:[]},back)],
    [label('已有接收成员','Existing recipients'),()=>form(label('接收成员','Recipients'),[['viewers',label('接收成员的稳定身份，逗号分隔','Recipient stable identities, comma separated')]],v=>confirm({...input,visibility:'Private',viewers:split(v.viewers)},back),back)],
    [label('公开已选内容','Public selected content'),()=>confirm({...input,visibility:'Public',viewers:[]},back)]
  ],back);}
  function publish(current){const old=current?.version??{},back=current?()=>detail(current.capsuleId,current.versionId):home;
    if(!has('history'))return message(label('当前连接尚不能读取已有来源。按需要接续履历读取后可从工作整理方法。','This connection cannot read existing sources. Select history access to prepare a method from actual work.'),back);
    workSelection.select(work=>workSelection.proofs(work,proofIds=>{
      const configuration=work.attempts?.find(a=>a.id===work.result.attemptId)?.configuration??{};
      const draft={title:old.title??work.title,problemPattern:old.problemPattern??'',solutionStrategy:old.solutionStrategy??'',
        environment:old.environment?.name??configuration.environment??'',environmentVersion:old.environment?.version??configuration.version??'',
        tools:(old.tools??configuration.tools??[]).join(','),skills:(old.skills??[]).join(','),mcpRefs:(old.mcpRefs??[]).join(','),
        verificationMethod:old.verificationMethod??'',limitations:(old.limitations??work.result.limitations??[]).join(';'),
        capabilityId:old.capabilityId??'',applicableScope:old.applicableScope??'',license:old.license??'',contributors:(old.contributors??[]).join(',')};
      const groups=[
        [label('编辑方法正文','Edit method content'),[['title',label('标题','Title')],['problemPattern',label('适用问题','Applicable problem')],['solutionStrategy',label('解决方法','Solution method'),'',4000]]],
        [label('适用条件与许可证','Conditions and license'),[['environment',label('适用环境','Environment')],['environmentVersion',label('环境版本','Environment version')],['applicableScope',label('适用范围','Applicable scope')],['license',label('许可证标识','License identifier')],['capabilityId',label('能力分类标识','Capability classification')]]],
        [label('验证方法与限制','Verification method and limitations'),[['verificationMethod',label('实际验证方法及证据说明','Actual verification method and evidence')],['limitations',label('实际局限，分号分隔','Actual limitations, semicolon separated')]]],
        [label('工具、技能与贡献者','Tools, skills and contributors'),[['tools',label('工具，逗号分隔','Tools, comma separated')],['skills',label('技能，逗号分隔','Skills, comma separated')],['mcpRefs',label('MCP 服务引用，逗号分隔','MCP references, comma separated')],['contributors',label('贡献者稳定身份，逗号分隔','Contributor stable identities, comma separated')]]]
      ];
      const edit=group=>form(group[0],group[1],()=>review(),review,draft);
      const next=()=>{const missing=groups.slice(0,3).find(group=>group[1].some(([key])=>!draft[key]?.trim()));if(missing)return edit(missing);save(draft);};
      function review(){menu(label('整理这份方法','Prepare this method')+'\n\n'+[
        plain(draft.title),plain(draft.problemPattern),plain(draft.solutionStrategy,4000),
        [draft.environment,draft.environmentVersion,draft.applicableScope,draft.license].filter(Boolean).map(s=>plain(s)).join(' · '),
        plain(draft.verificationMethod),plain(draft.limitations)
      ].filter(Boolean).join('\n\n'),[[label('继续选择可见范围','Choose visibility'),next],...groups.map(group=>[group[0],()=>edit(group)])],back);}
      function save(value){void run(()=>workSelection.reread(work),fresh=>{
      if(fresh.result.outcome!=='succeeded'||fresh.result.corrected)return message(label('原结果已发生变化。请选择当前完成的来源。','The source result changed. Choose a currently successful result.'),back);
      if(proofIds.some(id=>!fresh.proofs?.some(p=>p.proofId===id&&p.status==='active')))return message(label('所选来源已不可读，请重新选择。','Selected sources are unavailable. Choose them again.'),back);
      disclosure({kind:'version',...(current?{capsuleId:current.capsuleId}:{}),title:value.title,problemPattern:value.problemPattern,
        environment:{name:value.environment,version:value.environmentVersion},solutionStrategy:value.solutionStrategy,tools:split(value.tools),skills:split(value.skills),mcpRefs:split(value.mcpRefs),
        verificationMethod:value.verificationMethod,limitations:split(value.limitations),capabilityId:value.capabilityId,applicableScope:value.applicableScope,license:value.license,contributors:split(value.contributors),
        sourceResolution:{caseId:fresh.caseId,resultId:fresh.result.id,proofIds},redactionConfirmed:true},back);
      },back);}review();
    },back,{initial:old.sourceResolution?.caseId===work.caseId&&old.sourceResolution.resultId===work.result.id?old.sourceResolution.proofIds:[]}),back,{mode:'result',resultFilter:r=>r.outcome==='succeeded'&&!r.corrected,preferredCaseId:old.sourceResolution?.caseId});}
  function use(current,kind){const back=()=>detail(current.capsuleId,current.versionId);
    if(!has('history'))return message(label('当前连接没有已有工作读取权限。按需要接续履历读取后再记录。','This connection cannot read existing work. Select history access to record actual use.'),back);
    const chosen=(work,prior)=>{
      const record=proofIds=>form(kind==='reference'?label('引用到原工作','Reference in current work'):kind==='apply'?label('记录实际应用','Record actual application'):label('再次验证这次应用','Reverify this application'),[
        ['note',label('实际用途或应用说明','Actual purpose or application note'),prior?.note],
        ...(kind==='reference'?[]:[['environmentDifference',label('与原方法的实际环境差异','Actual environment differences'),prior?.environmentDifference]])
      ],value=>void run(()=>workSelection.reread(work),fresh=>disclosure({kind,capsuleId:current.capsuleId,versionId:current.versionId,caseId:fresh.caseId,...value,
        ...(kind==='reference'?{}:{attemptId:fresh.result.attemptId,resultId:fresh.result.id}),...(kind==='reverify'?{priorUseId:prior.id,proofIds}:{})},back),back),back);
      if(kind==='reverify')workSelection.proofs(work,record,back,{required:true});else record();
    };
    if(kind!=='reverify')return workSelection.select(work=>chosen(work),back,{mode:kind==='reference'?'case':'result',excludeCaseId:kind==='reference'?undefined:current.version.sourceResolution.caseId});
    const applications=after=>void run(async()=>({status:await controller.status?.(),page:await controller.capsuleUses({capsuleId:current.capsuleId,versionId:current.versionId,limit:8,...(after?{after}:{})})}),({status,page})=>{
      const rows=page.items.filter(u=>u.kind==='apply'&&(!status?.subjectId||u.subjectId===status.subjectId)),entries=rows.map(prior=>[plain(prior.note),()=>workSelection.select(work=>chosen(work,prior),back,{mode:'result',requiredCaseId:prior.caseId,excludeCaseId:current.version.sourceResolution.caseId}),workSelection.outcome(prior.outcome)]);
      if(page.nextAfter)entries.push([label('其他实际应用','Other actual applications'),()=>applications(page.nextAfter)]);
      if(!entries.length)return message(label('当前没有可读的本人应用。先记录真实应用，再继续验证。','There is no readable application by the current subject. Record actual application before reverification.'),back);
      menu(label('选择原来那次实际应用','Choose the original actual application'),entries,back);
    },back);applications();}
  function uses(capsuleId,versionId,after,caseId){const back=capsuleId?()=>detail(capsuleId,versionId):home;
    void run(()=>controller.capsuleUses({...(capsuleId?{capsuleId}:{}),...(versionId?{versionId}:{}),...(caseId?{caseId}:{}),...(after?{after}:{}),limit:8}),page=>{
      const kindName=kind=>({reference:label('引用','Reference'),apply:label('实际应用','Actual application'),reverify:label('再次验证','Reverification')}[kind]??plain(kind));
      const entries=page.items.map(item=>[plain(item.note)||kindName(item.kind),()=>menu(kindName(item.kind)+'\n'+[
        item.outcome?workSelection.outcome(item.outcome):'',plain(item.note),plain(item.environmentDifference),
        item.sourceNeedsReview?label('原来源已有变化，使用前需要重新查看。','The source changed. Read its current content before use.'):'',
      ].filter(Boolean).join('\n'),[[label('查看来源详情','Inspect source details'),()=>message(JSON.stringify(item,null,2),()=>uses(capsuleId,versionId,after,caseId))]],()=>uses(capsuleId,versionId,after,caseId)),item.outcome?workSelection.outcome(item.outcome):kindName(item.kind)]);
      if(page.nextAfter)entries.push([label('下一批','Next results'),()=>uses(capsuleId,versionId,page.nextAfter,caseId)]);
      menu(label('实际使用记录','Actual use records')+(!entries.length?'\n'+label('当前没有可读的使用记录。','No use records are currently readable.') : ''),entries,back);
    },back);}
  function detail(capsuleId,versionId){void run(()=>controller.getCapsule({capsuleId,...(versionId?{versionId}:{})}),current=>{
    const v=current.version,back=()=>detail(capsuleId,current.versionId),entries=[
      [label('阅读方法','Read method'),()=>message([
        `${label('适用问题','Applicable problem')}\n${plain(v.problemPattern)}`,
        `${label('方法正文','Method')}\n${plain(v.solutionStrategy,4000)}`,
        `${label('适用范围','Applicable scope')}\n${plain(v.applicableScope)}`,
        ...(v.limitations.length?[`${label('限制','Limitations')}\n${v.limitations.map(s=>plain(s)).join('\n')}`]:[]),
        `${label('许可证','License')}\n${plain(v.license)}`
      ].join('\n\n'),back,`${plain(v.title)} · v${v.version}`)],
      [label('适用条件与验证方法','Conditions and verification method'),()=>message([
        `${label('环境','Environment')}：${plain(v.environment.name)} ${plain(v.environment.version)}`,
        ...(v.tools.length?[`${label('工具','Tools')}：${v.tools.map(s=>plain(s)).join(', ')}`]:[]),
        ...(v.skills.length?[`${label('所需技能','Skills')}：${v.skills.map(s=>plain(s)).join(', ')}`]:[]),
        ...(v.mcpRefs.length?[`${label('所需 MCP 服务','Required MCP services')}：${v.mcpRefs.map(s=>plain(s)).join(', ')}`]:[]),
        `${label('验证方法','Verification method')}：${plain(v.verificationMethod)}`,`${label('许可证','License')}：${plain(v.license)}`
      ].join('\n\n'),back,`${plain(v.title)} · v${v.version}`)],
      [label('查看实际复用记录','View reuse records'),()=>uses(capsuleId,current.versionId)],
      [label('版本与来源','Versions and sources'),()=>menu(label('版本与来源','Versions and sources'),[
        [label('查看来源详情','Inspect source details'),()=>message(JSON.stringify(current,null,2),back)],
        ...current.versions.map(item=>[`v${item.version} · ${plain(item.title)}`,()=>detail(capsuleId,item.versionId)]),
        ...current.notices.map(item=>[plain(item.kind),()=>message(plain(item.summary),back)])],back)],
      [label('回到原工作','Return to original work'),returnWork]
    ];
    if(controller.prepareCapsule&&has('consent')&&has('case-teaser')){
      entries.push([label('记录引用','Record reference'),()=>use(current,'reference')]);
      if(!current.deprecated&&!current.securityIssue&&!current.sourceNeedsReview)entries.push([label('记录实际应用结果','Record application result'),()=>use(current,'apply')],[label('记录再次验证','Record reverification'),()=>use(current,'reverify')]);
    }
    if(controller.prepareCapsule&&has('consent')&&current.disclosure){
      entries.push([label('发布修订版本','Publish revised version'),()=>publish(current)]);
      const kinds=[...(current.deprecated?[]:[['deprecate',label('弃用此版本','Deprecate version')]]),[current.securityIssue?'resolve-security':'security-issue',current.securityIssue?label('解除安全问题标记','Resolve security issue'):label('标记安全问题','Flag security issue')]];
      for(const [kind,title] of kinds)entries.push([title,()=>form(title,[['summary',label('说明','Explanation')]],value=>confirm({kind,capsuleId,versionId:current.versionId,...value},back),back)]);
    }
    menu([`${plain(v.title)} · v${v.version}`,plain(v.license),
      current.deprecated?label('此版本已弃用。','This version is deprecated.'):'',
      current.securityIssue?label('此版本存在已标记的安全问题。','This version has a flagged security issue.'):'',
      current.sourceNeedsReview?label('来源已有变化，使用前需要重新查看。','The source changed. Read it again before use.'):'',
    ].filter(Boolean).join('\n'),entries);
  });}
  function listing(after){void run(()=>controller.queryCapsules({query,limit:8,...(after?{after}:{})}),page=>{
    const entries=page.items.map(item=>[plain(item.title),()=>detail(item.capsuleId,item.versionId),`v${item.version}`]);
    if(page.nextAfter)entries.push([label('下一批','Next results'),()=>listing(page.nextAfter)]);menu(label('方法','Methods'),entries);
  });}
  function home(){menu(label('方法','Methods'),[
    [label('浏览与搜索','Browse and search'),()=>listing()],
    [label('搜索词','Search text'),()=>form(label('搜索方法','Search methods'),[['query',label('标题或问题中的文字','Text in title or problem'),query]],value=>{query=value.query;listing();})],
    [label('打开已有方法引用','Open an existing method reference'),()=>form(label('已有方法引用','Existing method reference'),[['capsuleId','Capsule ID'],['versionId',label('版本引用（可选）','Version reference (optional)')]],value=>detail(value.capsuleId,value.versionId||undefined))],
    [label('查看工作使用的方法','Methods used in existing work'),()=>workSelection.select(work=>uses(undefined,undefined,undefined,work.caseId),home)],
    ...(controller.prepareCapsule&&has('consent')?[[label('从已有工作整理方法','Prepare a method from existing work'),()=>publish()]]:[]),
    [label('回到原工作','Return to original work'),returnWork]
  ],leave);}
  return Object.freeze({open:home,openCapsule:detail});
}
