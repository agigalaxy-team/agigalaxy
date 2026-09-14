export function createCapsuleMenu({controller,select,prompt,info,language,isCurrent,onBack,availableScopes=null}) {
  const zh=language!=='en-US',label=(a,b)=>zh?a:b,has=s=>!availableScopes||availableScopes.includes(s);
  const plain=(v,max=1200)=>String(v??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,max);
  const split=s=>String(s??'').split(/[,，;；]/).map(v=>v.trim()).filter(Boolean);
  let generation=0,query='';
  const leave=()=>{generation++;controller.cancel();onBack();};
  const message=(text,back=home)=>{if(isCurrent())info('Capsule',text,back);};
  function menu(title,entries,back=home,offset=0){if(!isCurrent())return;const routes={};
    const options=entries.slice(offset,offset+8).map(([title,action,description=''],i)=>{routes[i+1]=()=>{if(isCurrent())action();};return {number:String(i+1),title,description};});
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=()=>menu(title,entries,back,offset+8);}
    select({title,options,routes,onBack:offset?()=>menu(title,entries,back,offset-8):back});}
  async function run(work,done,back=home){const version=++generation;message(label('正在读取或准备','Reading or preparing'),()=>{generation++;controller.cancel();back();});
    try{const result=await work();if(isCurrent()&&generation===version)done(result);}catch(error){if(isCurrent()&&generation===version)message(plain(error.message),back);}}
  function form(title,fields,done,back=home,draft={},index=0){if(!isCurrent())return;if(index===fields.length)return done(draft);
    const [key,name,initial='',maximum=1200]=fields[index];prompt({title:`${title} · ${index+1}/${fields.length}\n${name}`,placeholder:String(draft[key]??initial),
      onCancel:index?()=>form(title,fields,done,back,draft,index-1):back,onConfirm:value=>{if(!isCurrent())return;if(String(value).length>maximum)return message(label('内容超长','Content is too long'),()=>form(title,fields,done,back,draft,index));draft[key]=String(value).trim();form(title,fields,done,back,draft,index+1);}});}
  function confirm(input,back){void run(()=>controller.prepareCapsule(input),preview=>{
    const cancel=()=>{generation++;controller.cancel();back();};let submitted=false;
    const show=()=>prompt({title:`${label('确认Capsule内容与可见性','Confirm Capsule content and visibility')}\n${preview.endpoint}\n${preview.intentJson}\n${preview.payloadJson}\n${preview.confirmation}`,placeholder:preview.confirmation,onCancel:cancel,
      onConfirm:async value=>{if(!isCurrent()||submitted)return;if(value!==preview.confirmation)return message(label('确认文本不匹配，未提交','Confirmation mismatch; nothing submitted'),show);
        submitted=true;const version=++generation;message(label('正在提交','Submitting'),cancel);
        try{const receipt=await controller.executeCapsule(preview,value);if(isCurrent()&&generation===version)message(`${label('已记录','Recorded')}: ${plain(receipt.eventId)}`,back);}
        catch{if(isCurrent()&&generation===version)message(label('结果未确认，请先读取记录后再决定是否重试','Outcome unconfirmed; read existing records before retrying'),back);}}});show();
    },back);}
  function disclosure(input,back){menu(label('这份内容的可见性','Visibility of this content'),[
    [label('私有','Private'),()=>form('Private',[['viewers',label('允许查看的Galaxy ID，逗号分隔；留空仅自己','Viewer Galaxy IDs; empty means yourself')]],v=>confirm({...input,visibility:'Private',viewers:split(v.viewers)},back),back)],
    [label('公开已选内容','Public selected content'),()=>confirm({...input,visibility:'Public',viewers:[]},back)]
  ],back);}
  function publish(current){const old=current?.version??{},back=current?()=>detail(current.capsuleId,current.versionId):home;
    form(label('Capsule版本','Capsule version'),[
      ['caseId','Source Case ID',old.sourceResolution?.caseId],['resultId','Source successful Result ID',old.sourceResolution?.resultId],
      ['title',label('标题','Title'),old.title],['problemPattern',label('问题模式','Problem pattern'),old.problemPattern],
      ['environment',label('适用环境','Environment'),old.environment?.name],['environmentVersion',label('环境版本','Environment version'),old.environment?.version],
      ['solutionStrategy',label('解决策略','Solution strategy'),old.solutionStrategy,4000],
      ['tools','Tools (comma separated)',old.tools?.join(',')],['skills','Skills (comma separated)',old.skills?.join(',')],['mcpRefs','MCP references (comma separated)',old.mcpRefs?.join(',')],
      ['verificationMethod',label('验证方法及证据强度说明','Verification method and strength'),old.verificationMethod],['limitations',label('局限，分号分隔','Limitations, semicolon separated'),old.limitations?.join(';')],
      ['capabilityId','Capability ID',old.capabilityId],['applicableScope',label('适用范围','Applicable scope'),old.applicableScope],['license',label('许可证标识','License identifier'),old.license],
      ['contributors',label('贡献者Galaxy ID，逗号分隔（作者归因声明）','Contributor Galaxy IDs (author attribution)'),old.contributors?.join(',')],
      ['proofIds','Source Proof IDs (optional)',old.sourceResolution?.proofIds?.join(',')],
      ['redacted',label('已检查脱敏及可公开内容：输入yes','Reviewed redaction and disclosure: enter yes')]
    ],value=>{if(value.redacted!=='yes')return message(label('确认已选内容后才能发布','Review selected content before publishing'),back);
      disclosure({kind:'version',...(current?{capsuleId:current.capsuleId}:{}),title:value.title,problemPattern:value.problemPattern,
        environment:{name:value.environment,version:value.environmentVersion},solutionStrategy:value.solutionStrategy,tools:split(value.tools),skills:split(value.skills),mcpRefs:split(value.mcpRefs),
        verificationMethod:value.verificationMethod,limitations:split(value.limitations),capabilityId:value.capabilityId,applicableScope:value.applicableScope,license:value.license,contributors:split(value.contributors),
        sourceResolution:{caseId:value.caseId,resultId:value.resultId,proofIds:split(value.proofIds)},redactionConfirmed:true},back);
    },back);}
  function use(current,kind){const back=()=>detail(current.capsuleId,current.versionId);form(kind,[['caseId','New Case ID'],['note',label('用途或应用说明','Purpose or application note')],
    ...(kind==='reference'?[]:[['attemptId','New Attempt ID'],['resultId','New Result ID'],['environmentDifference',label('相较原版本的环境差异','Environment differences from the original version')]]),
    ...(kind==='reverify'?[['priorUseId','Prior application record ID'],['proofIds','New Case Proof IDs']]:[])],value=>{
      const fields={...value,...(kind==='reverify'?{proofIds:split(value.proofIds)}:{})};
      disclosure({kind,capsuleId:current.capsuleId,versionId:current.versionId,...fields},back);
    },back);}
  function uses(capsuleId,versionId,after,caseId){const back=capsuleId?()=>detail(capsuleId,versionId):home;
    void run(()=>controller.capsuleUses({...(capsuleId?{capsuleId}:{}),...(versionId?{versionId}:{}),...(caseId?{caseId}:{}),...(after?{after}:{}),limit:8}),page=>{
      const entries=page.items.map(item=>[`${plain(item.kind)} · ${plain(item.outcome)}`,()=>message([
        `${plain(item.id)} · ${plain(item.verification)}`,`Case: ${plain(item.caseId)} · Version: ${plain(item.versionId)}`,
        plain(item.note),plain(item.environmentDifference),`${label('归因','Attribution')}: ${plain(item.attribution)}`,
        `${label('源结果需复核','Source needs review')}: ${item.sourceNeedsReview}`,...item.proofs.map(p=>`${plain(p.proofId)} · ${plain(p.state)}`)
      ].join('\n'),()=>uses(capsuleId,versionId,after,caseId)),plain(item.subjectId)]);
      if(page.nextAfter)entries.push([label('下一批','Next results'),()=>uses(capsuleId,versionId,page.nextAfter,caseId)]);
      menu(label('引用/应用/再次验证；阅读不算复用','References/applications/reverification; reading is not reuse'),entries,back);
    },back);}
  function detail(capsuleId,versionId){void run(()=>controller.getCapsule({capsuleId,...(versionId?{versionId}:{})}),current=>{
    const v=current.version,back=()=>detail(capsuleId,current.versionId),entries=[
      [label('阅读解决策略','Read solution strategy'),()=>message(`${plain(v.problemPattern)}\n${plain(v.solutionStrategy,4000)}\n${plain(v.applicableScope)}\n${v.limitations.map(s=>plain(s)).join('\n')}`,back)],
      [label('环境、工具与验证依据','Environment, tools and verification'),()=>message(`${plain(JSON.stringify(v.environment))}\n${plain(v.tools.join(', '))}\n${plain(v.skills.join(', '))}\n${plain(v.mcpRefs.join(', '))}\n${plain(v.verificationMethod)}\n${plain(JSON.stringify(v.sourceResolution))}\n${plain(JSON.stringify(current.sourceProofs))}`,back)],
      [label('查看版本与通知','Versions and notices'),()=>menu('Versions',[
        ...current.versions.map(item=>[`v${item.version} · ${plain(item.title)}`,()=>detail(capsuleId,item.versionId)]),
        ...current.notices.map(item=>[plain(item.kind),()=>message(plain(item.summary),back)])],back)],
      [label('查看实际复用记录','View reuse records'),()=>uses(capsuleId,current.versionId)]
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
    menu(`${plain(v.title)} · v${v.version}\n${plain(current.authorId)} · ${plain(v.license)}\n${label('弃用 / 安全问题 / 来源需复核','Deprecated / security issue / source review')}: ${current.deprecated} / ${current.securityIssue} / ${current.sourceNeedsReview}\n${label('作者声明，不是自动能力认证','Author-reported, not automatic capability certification')}`,entries);
  });}
  function listing(after){void run(()=>controller.queryCapsules({query,limit:8,...(after?{after}:{})}),page=>{
    const entries=page.items.map(item=>[plain(item.title),()=>detail(item.capsuleId,item.versionId),`v${item.version} · ${plain(item.capabilityId)}`]);
    if(page.nextAfter)entries.push([label('下一批','Next results'),()=>listing(page.nextAfter)]);menu('Capsules',entries);
  });}
  function home(){menu('Galaxy / Capsules',[
    [label('浏览与搜索','Browse and search'),()=>listing()],
    [label('搜索词','Search text'),()=>form('Capsules',[['query',label('标题或问题中的文字','Text in title or problem'),query]],value=>{query=value.query;listing();})],
    [label('按ID打开','Open by ID'),()=>form('Capsules',[['capsuleId','Capsule ID'],['versionId','Version ID (optional)']],value=>detail(value.capsuleId,value.versionId||undefined))],
    [label('查看Case复用关联','Case reuse links'),()=>form('Capsules',[['caseId','Case ID']],value=>uses(undefined,undefined,undefined,value.caseId))],
    ...(controller.prepareCapsule&&has('consent')?[[label('发布Capsule','Publish Capsule'),()=>publish()]]:[])
  ],leave);}
  return Object.freeze({open:home,openCapsule:detail});
}
