import { githubBridgeMapping } from '../../../packages/galaxy-official/src/shared/ci-provenance.mjs';
export function createBuilderMenu({controller,select,prompt,info,language,isCurrent,onBack,availableScopes=null}) {
  const zh=language!=='en-US',label=(a,b)=>zh?a:b,has=s=>!availableScopes||availableScopes.includes(s);
  const plain=(v,max=1200)=>String(v??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,max);
  const split=s=>String(s??'').split(/[,，;；]/).map(v=>v.trim()).filter(Boolean);
  let generation=0,viewGeneration=0,query='';
  const leave=()=>{generation++;controller.cancel();onBack();};
  const message=(text,back=home)=>{if(isCurrent()){const view=++viewGeneration;info('Builder',text,()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;back();}});}};
  function menu(title,entries,back=home,offset=0){if(!isCurrent())return;const routes={},view=++viewGeneration;
    const options=entries.slice(offset,offset+8).map(([title,action,description=''],i)=>{routes[i+1]=()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;action();}};return {number:String(i+1),title,description};});
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=()=>{if(isCurrent()&&view===viewGeneration)menu(title,entries,back,offset+8);};}
    select({title,options,routes,onBack:()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;if(offset)menu(title,entries,back,offset-8);else back();}}});}
  async function run(work,done,back=home){const version=++generation;message(label('正在读取或准备','Reading or preparing'),()=>{generation++;controller.cancel();back();});
    try{const result=await work();if(isCurrent()&&generation===version)done(result);}catch(error){if(isCurrent()&&generation===version)message(plain(error.message),back);}}
  function form(title,fields,done,back=home,draft={},index=0){if(!isCurrent())return;if(index===fields.length)return done(draft);
    const [key,name,initial='',maximum=1200]=fields[index],view=++viewGeneration;prompt({title:`${title} · ${index+1}/${fields.length}\n${name}`,placeholder:String(draft[key]??initial),
      onCancel:()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;if(index)form(title,fields,done,back,draft,index-1);else back();}},onConfirm:value=>{if(!isCurrent()||view!==viewGeneration)return;viewGeneration++;if(String(value).length>maximum)return message(label('内容超长','Content is too long'),()=>form(title,fields,done,back,draft,index));draft[key]=String(value).trim();form(title,fields,done,back,draft,index+1);}});}
  function confirm(input,back){confirmPrepared(()=>controller.prepareBuilder(input),back);}
  function confirmPrepared(work,back,{execute=controller.executeBuilder,proof=false}={}){void run(work,preview=>{
    const cancel=()=>{generation++;controller.cancel();back();};let submitted=false;
    const show=()=>{const view=++viewGeneration;prompt({title:`${proof?label('确认用Node密钥签署并保存本机证明','Confirm Node countersignature and local proof file'):label('确认Builder内容与可见性','Confirm Builder content and visibility')}\n${preview.endpoint}\n${preview.intentJson??''}\n${preview.payloadJson}\n${preview.confirmation}`,placeholder:preview.confirmation,onCancel:()=>{if(isCurrent()&&view===viewGeneration){viewGeneration++;cancel();}},
      onConfirm:async value=>{if(!isCurrent()||submitted||view!==viewGeneration)return;viewGeneration++;if(value!==preview.confirmation)return message(label('确认文本不匹配，未提交','Confirmation mismatch; nothing submitted'),show);
        submitted=true;const version=++generation;message(label('正在提交','Submitting'),cancel);
        try{const receipt=await execute(preview,value);if(isCurrent()&&generation===version)message(proof?`${label('已生成本机授权证明','Local authorization proof saved')}: ${plain(receipt.path)}\n${label('离线签名不能说明之后的撤销；不代表能力或端点控制权。','Offline signatures cannot establish later revocation; no capability or endpoint control conclusion.')}`:`${label('已记录','Recorded')}: ${plain(receipt.eventId)}`,back);}
        catch{if(isCurrent()&&generation===version)message(label('结果未确认，请先读取记录后再决定是否重试','Outcome unconfirmed; read existing records before retrying'),back);}}});};show();
    },back);}
  function disclosure(input,back){menu(label('这份内容的可见性','Visibility of this content'),[
    [label('私有','Private'),()=>form('Private',[['viewers',label('允许查看的Galaxy ID，逗号分隔；留空仅自己','Viewer Galaxy IDs; empty means yourself')]],v=>confirm({...input,visibility:'Private',viewers:split(v.viewers)},back),back)],
    [label('公开已选内容','Public selected content'),()=>confirm({...input,visibility:'Public',viewers:[]},back)]
  ],back);}
  const parseRows=(value,keys)=>String(value??'').split('\n').filter(v=>v.trim()).map(line=>{
    const values=line.split('|').map(v=>v.trim());if(values.length!==keys.length||values.some(v=>!v))throw new Error(label('请按提示用 | 分隔各列','Separate each required column with |'));
    return Object.fromEntries(keys.map((key,index)=>[key,values[index]]));
  });
  const rowsText=(rows,keys)=>(rows??[]).map(row=>keys.map(key=>row[key]).join(' | ')).join('\n');
  const checks=['ids','evidence','signatures','schema','import','privacy','revocation'];
  function publish(type,current){
    const old=current?.declaration??{},release=old.release??{},config=old.configuration??{},mapping=old.mapping??(type==='bridge'?githubBridgeMapping:{}),back=current?()=>current.mode==='owner-management'?management(current.builderId):detail(current.builderId):home;
    const common=[['name',label('名称','Name'),old.name,160],['scope',label('适用范围','Applicable scope'),old.scope,1500],
      ['version',label('发行版本','Release version'),release.version,80],['buildHash','Build SHA-256',release.buildHash,64],['sourceCommit',label('源码提交摘要','Source commit'),release.sourceCommit,64],
      ['artifact',label('发行文件HTTPS地址','Release artifact HTTPS URL'),release.artifact,500],['policy','Policy HTTPS URL',old.policy,500],['contact',label('联络页面HTTPS地址','Contact page HTTPS URL'),old.contact,500],
      ['dependencies',label('依赖：每行 名称 | 固定版本 | SHA-256；无依赖留空','Dependencies: one name | pinned version | SHA-256 per line; empty if none'),rowsText(release.dependencies,['name','version','sha256']),7000],
      ['upgrade',label('升级步骤（保留身份）','Upgrade steps (preserve identity)'),release.upgrade,1500],['rollback',label('回退步骤','Rollback steps'),release.rollback,1500],
      ['proofIds',label('所有者CI Proof ID，逗号分隔，可留空','Owner CI Proof IDs, comma separated, optional'),old.proofIds?.join(','),650]];
    const specific=type==='worker'?[
      ['nodeId',label('已有Worker Node Galaxy ID','Existing Worker Node Galaxy ID'),old.nodeId,32],['configurationId',label('配置标识','Configuration ID'),config.id,100],
      ['configurationSummary',label('配置摘要，不含私有Prompt或密钥','Configuration summary without private prompts or keys'),config.summary,1500],['modelFamily',label('模型系列','Model family'),config.modelFamily,100],
      ['tools',label('工具名称，逗号分隔','Tool names, comma separated'),config.tools?.join(',')],['taskTypes',label('任务类型，逗号分隔','Task types, comma separated'),config.taskTypes?.join(',')],
      ['maxConcurrentTasks',label('最大并发任务数','Maximum concurrent tasks'),config.maxConcurrentTasks??1,4],
      ['capabilities',label('能力声明：每行 标识 | 声明 | 局限','Capability claims: one ID | claim | limitations per line'),rowsText(old.capabilities,['id','claim','limitations']),16000]
    ]:type==='bridge'?[
      ['sourceSystem',label('来源系统','Source system'),mapping.sourceSystem,160],['sourceObjects',label('来源对象，逗号分隔','Source objects, comma separated'),mapping.sourceObjects?.join(',')],
      ['targetObjects',label('目标对象，逗号分隔','Target objects, comma separated'),mapping.targetObjects?.join(',')],['rules',label('映射规则','Mapping rules'),mapping.rules,3000],
      ['strengthCeiling',label('强度上限：source-assertion 或 execution-observation','Strength ceiling: source-assertion or execution-observation'),mapping.strengthCeiling??'source-assertion',30],
      ['authorization',label('来源授权方式','Source authorization'),mapping.authorization,1000],['mappingVersion',label('映射版本','Mapping version'),mapping.version,80],
      ['deduplication',label('去重方法','Deduplication'),mapping.deduplication,1500],['revocation',label('撤销传播','Revocation propagation'),mapping.revocation,1500],['provenance',label('来源控制权及强度说明','Source authority and strength'),mapping.provenance,1500]
    ]:[['operator',label('运营者','Operator'),old.operator,160],['charter','Charter HTTPS URL',old.charter,500],['region',label('地区','Region'),old.region,160],
      ['endpoint','Hub endpoint HTTPS URL',old.endpoint,500],['manifestUrl','Manifest HTTPS URL',old.manifest?.url,500],['manifestHash','Manifest data JCS SHA-256',old.manifest?.sha256,64],
      ['manifestVersion',label('Manifest规范版本','Manifest spec version'),old.manifest?.specVersion??'galaxy-hub/1',80],['exit',label('退出说明','Exit instructions'),old.exit,1500],['export',label('导出说明','Export instructions'),old.export,1500]];
    form(`${type} ${label('登记声明','declaration')}`,[...common,...specific,['redacted',label('已检查所选内容并移除秘密：输入yes','Reviewed selected content and removed secrets: enter yes'),'',3]],value=>{
      try{
        if(value.redacted!=='yes')return message(label('请先检查所选内容','Review selected content first'),back);
        const declaration={type,name:value.name,scope:value.scope,policy:value.policy,contact:value.contact,redactionConfirmed:true,proofIds:split(value.proofIds),
          release:{version:value.version,buildHash:value.buildHash,sourceCommit:value.sourceCommit,artifact:value.artifact,dependencies:parseRows(value.dependencies,['name','version','sha256']),upgrade:value.upgrade,rollback:value.rollback}};
        if(type==='worker')Object.assign(declaration,{nodeId:value.nodeId,configuration:{id:value.configurationId,summary:value.configurationSummary,modelFamily:value.modelFamily,tools:split(value.tools),taskTypes:split(value.taskTypes),maxConcurrentTasks:Number(value.maxConcurrentTasks)},capabilities:parseRows(value.capabilities,['id','claim','limitations'])});
        else if(type==='bridge')declaration.mapping={sourceSystem:value.sourceSystem,sourceObjects:split(value.sourceObjects),targetObjects:split(value.targetObjects),rules:value.rules,strengthCeiling:value.strengthCeiling,authorization:value.authorization,version:value.mappingVersion,deduplication:value.deduplication,revocation:value.revocation,provenance:value.provenance};
        else Object.assign(declaration,{operator:value.operator,charter:value.charter,region:value.region,endpoint:value.endpoint,manifest:{url:value.manifestUrl,sha256:value.manifestHash,specVersion:value.manifestVersion},exit:value.exit,export:value.export});
        disclosure({kind:'declare',declaration,...(current?{builderId:current.builderId,baseDeclarationId:current.declarationId,
          ...(current.mode==='owner-management'?{management:true,baseRevision:current.revision}:{})}:{})},back);
      }catch(error){message(plain(error.message),back);}
    },back);
  }
  function report(current){const back=()=>detail(current.builderId);
    form(label('提交已有兼容测试结果','Submit existing conformance results'),[
      ['suiteName',label('测试套件名称','Suite name'),'',100],['suiteVersion',label('套件版本','Suite version'),'',80],['suiteHash','Suite SHA-256','',64],['suiteSource','Suite HTTPS URL','',500],
      ['observedAt',label('测试时间（含时区，如2026-09-10T08:00:00+08:00）','Test time (ISO date with timezone)'),'',40],['expiresAt',label('失效时间（含时区）','Expiry time (ISO date with timezone)'),'',40],
      ...checks.map(id=>[id,`${id}: pass / fail / not-tested | ${label('结果说明','result detail')}`,'',1050]),
      ['limitations',label('测试范围与限制','Test scope and limitations'),'',1500]
    ],value=>{try{
      const timestamp=key=>{if(!/(Z|[+-]\d{2}:\d{2})$/.test(value[key]))throw new Error(label('时间必须含时区','Time must include timezone'));const result=Date.parse(value[key])/1000;if(!Number.isInteger(result))throw new Error(label('时间格式无效','Invalid time'));return result;};
      confirm({kind:'compatibility',profile:'galaxy-conformance/2',builderId:current.builderId,baseDeclarationId:current.declarationId,
        suite:{name:value.suiteName,version:value.suiteVersion,sha256:value.suiteHash,source:value.suiteSource},observedAt:timestamp('observedAt'),expiresAt:timestamp('expiresAt'),
        checks:checks.map(id=>{const rows=parseRows(value[id],['status','detail']);if(rows.length!==1)throw new Error(label('每个检查项仅填写一行','Use one row per check'));return {id,...rows[0]};}),limitations:value.limitations},back);
    }catch(error){message(plain(error.message),back);}},back);
  }
  function detail(builderId){void run(()=>controller.getBuilder({builderId}),current=>{
    const back=()=>detail(builderId),entries=[
      [label('查看完整登记声明','Read full declaration'),()=>message(JSON.stringify(current.declaration,null,2),back)],
      [label('登记、兼容、心跳与证据','Registration, compatibility, heartbeat and evidence'),()=>message([
        JSON.stringify(current.registration),JSON.stringify(current.nodeControl),JSON.stringify(current.compatibility),JSON.stringify(current.reachability),JSON.stringify(current.evidence),
        label('心跳是所有者报到；CI仅与所有者关联，不证明Worker执行能力或Hub可达。','A heartbeat is owner-reported; owner-associated CI does not prove Worker ability or Hub reachability.')].join('\n'),back)],
      [label('版本与维护公告','Versions and maintenance notices'),()=>menu(label('版本与维护公告','Versions and notices'),[
        ...current.versions.map(v=>[`${plain(v.version)} · ${plain(v.name)}`,()=>message(`${plain(v.declarationId)}\n${label('保留版本记录；当前接口读取最新声明','Version record retained; current API reads the latest declaration')}`,back)]),
        ...current.notices.map(n=>[plain(n.action),()=>message(plain(n.summary,2000),back)])],back)],
      [label('兼容报告与失败项','Conformance reports and failures'),()=>menu(label('评估者报告','Assessor reports'),current.reports.map(r=>[
        `${plain(r.suite.name)} ${plain(r.suite.version)} · ${plain(r.validity)}`,()=>menu(label('兼容报告','Conformance report'),[
          [label('查看范围与失败项','Read scope and failures'),()=>message(`${plain(r.assessorId)}\n${plain(r.declarationHash)}\n${JSON.stringify(r.suite)}\n${JSON.stringify(r.suiteStatus)}\n${JSON.stringify(r.coverage)}\n${r.observedAt} — ${r.expiresAt}\n${r.checks.map(c=>`${plain(c.id)}: ${plain(c.status)} · ${plain(c.detail)}`).join('\n')}\n${plain(r.limitations,1500)}`,back)],
          ...(controller.exportBuilderReport&&r.validity==='current'&&r.suiteStatus?.portable?[[label('生成可携带签名报告','Generate portable signed report'),()=>void run(()=>controller.exportBuilderReport({builderId,reportId:r.id}),result=>message(JSON.stringify(result,null,2),back),back)]]:[])
        ],back)]),back)]
    ];
    if(controller.prepareBuilder&&has('consent')&&current.disclosure){
      entries.push([label('更新登记声明','Update declaration'),()=>publish(current.type,current)],
        [label('主动报到（不证明可达）','Send owner heartbeat'),()=>confirm({kind:'heartbeat',builderId,baseDeclarationId:current.declarationId},back)]);
      const actions=[[current.delisted?'relist':'delist',current.delisted?label('恢复目录展示','Relist'):label('从目录下架','Delist')],['correction',label('发布纠正说明','Publish correction')],
        [current.securityIssue?'resolve-security':'security-issue',current.securityIssue?label('解决安全问题','Resolve security issue'):label('发布安全公告','Publish security notice')]];
      entries.push([label('维护登记','Maintain registration'),()=>menu(label('维护登记','Maintain registration'),actions.map(([action,title])=>[title,()=>form(title,[['summary',label('说明','Explanation'),'',2000]],value=>confirm({kind:'maintenance',builderId,baseDeclarationId:current.declarationId,action,summary:value.summary},back),back)]),back)]);
    }
    if(current.type==='hub'&&controller.verifyHubDirectory){
      entries.push([label('核对Hub签名与目录声明','Check Hub signature against directory'),()=>void run(()=>controller.verifyHubDirectory({builderId,declarationId:current.declarationId,manifestSha256:current.declaration.manifest.sha256}),result=>message([
        result.directoryState==='matched'?label('当前签名有效，目录元数据匹配','Current signature valid; directory metadata matches'):label('目录与签名信息不一致','Directory and signed metadata differ'),
        `${plain(result.data.endpoint)}\n${plain(result.profile)}\n${plain(result.manifestSha256)}`,
        result.differences.join(', '),label('尚未连接或授权；此核对不认证运营者身份或执行能力。','Not connected or authorized; this check does not certify operator identity or execution capability.')
      ].join('\n'),back),back),label('主动匿名读取此Hub的Manifest；接入需另行配置并确认','Explicit anonymous Manifest read; connection requires separate configuration and confirmation')]);
    }
    if(current.nodeControl?.state==='node-authorized-owner'&&(controller.exportNodeControl||controller.prepareNodeControlProof)){
      const input={builderId,controlId:current.nodeControl.controlId};
      entries.push([label('节点授权证明','Node authorization proof'),()=>menu(label('节点授权证明','Node authorization proof'),[
        ...(controller.exportNodeControl?[[label('读取服务签名授权快照','Read registry-signed authorization snapshot'),()=>void run(()=>controller.exportNodeControl(input),result=>message(JSON.stringify(result,null,2),back),back)]]:[]),
        ...(controller.prepareNodeControlProof&&current.nodeControlDisclosure?[[label('用Node密钥签署并保存证明','Countersign and save with Node key'),()=>confirmPrepared(()=>controller.prepareNodeControlProof(input),back,{execute:controller.executeNodeControlProof,proof:true})]]:[])
      ],back)]);
    }
    if(current.type==='worker'&&current.evidence?.nodeWorkEvidence){
      const work=current.evidence.nodeWorkEvidence,canRevoke=controller.prepareBuilder&&has('consent')&&(current.disclosure||current.nodeControlDisclosure);
      entries.push([label('节点关联的任务证据','Node-associated task evidence'),()=>menu(label('节点签署关联；不是独立执行归属认证','Node-signed links; not independent execution attribution'),work.items.map(item=>[
        `${plain(item.state)} · ${plain(item.eventId)}`,()=>menu(label('节点证据关联','Node evidence association'),[
          [label('查看准确来源与局限','Read exact sources and limitations'),()=>message(JSON.stringify(item,null,2),back)],
          ...(canRevoke&&item.state!=='revoked'?[[label('撤销这份关联','Revoke this association'),()=>form('Node',[['reason',label('撤销说明','Reason'),'',1000]],value=>confirm({kind:'work-evidence-revoke',builderId,baseDeclarationId:current.declarationId,workEventId:item.eventId,reason:value.reason},back),back)]]:[])
        ],back)
      ]),back)]);
    }
    if(controller.prepareBuilder&&has('consent')&&current.nodeControlDisclosure&&current.nodeControl?.state==='node-authorized-owner'){
      if(current.declaration.a2a)entries.push([label('请求端点可达性观测','Request endpoint reachability observation'),()=>confirm({kind:'probe-request',builderId,baseDeclarationId:current.declarationId},back),
        label('读取已登记Agent Card并只读查询随机任务ID，不创建任务','Read the registered Agent Card and a random task ID; no task creation')]);
      entries.push([label('以Node身份关联任务证据','Associate task evidence as Node'),()=>form(label('准确任务与证明来源','Exact task and proof sources'),[
        ['caseId','Case ID','',36],['attemptId','Attempt ID','',36],['resultId','Result ID','',36],['proofIds',label('当前CI Proof ID，逗号分隔','Current CI Proof IDs, comma separated'),'',300],
        ['summary',label('节点对本次参与的说明','Node statement about this participation'),'',1500],
        ['taskEndpoint',label('A2A任务端点；无关联留空，不会访问该地址','A2A task endpoint; optional, never fetched here'),'',500],['taskId',label('A2A任务ID；无关联留空','A2A task ID; optional'),'',128]
      ],value=>{
        if(!!value.taskEndpoint!==!!value.taskId)return message(label('A2A端点与任务ID须同时填写或同时留空','Provide both A2A endpoint and task ID, or neither'),back);
        confirm({kind:'work-evidence',builderId,baseDeclarationId:current.declarationId,caseId:value.caseId,attemptId:value.attemptId,resultId:value.resultId,
          proofIds:split(value.proofIds),summary:value.summary,...(value.taskEndpoint?{task:{protocol:'a2a/1.0',endpoint:value.taskEndpoint,taskId:value.taskId}}:{})},back);
      },back)]);
    }
    if(controller.prepareBuilder&&has('consent')&&current.nodeControlDisclosure)
      entries.push([label('以Node身份授权此登记','Authorize this registration as Node'),()=>confirm({kind:'node-control',builderId,baseDeclarationId:current.declarationId},back)]);
    if(controller.prepareBuilder&&has('consent')&&(current.disclosure||current.nodeControlDisclosure)&&current.nodeControl?.controlId)
      entries.push([label('撤销Node登记授权','Revoke Node registration approval'),()=>form(label('撤销授权','Revoke approval'),[['reason',label('撤销说明','Reason'),'',1000]],value=>confirm({kind:'node-control-revoke',builderId,baseDeclarationId:current.declarationId,reason:value.reason},back),back)]);
    if(controller.prepareBuilder&&has('consent')&&current.reportDisclosure)entries.push([label('提交兼容报告','Submit conformance report'),()=>report(current)]);
    if(current.type==='worker'&&current.disclosure&&controller.prepareBuilder&&has('consent'))entries.push([label('配置A2A观测端点','Configure A2A observation endpoint'),()=>form('A2A 1.0 / JSONRPC',[
      ['endpoint',label('准确RPC端点；留空移除此配置','Exact RPC endpoint; empty removes configuration'),current.declaration.a2a?.endpoint??'',500],
      ['cardUrl',label('公开Agent Card地址','Public Agent Card URL'),current.declaration.a2a?.cardUrl??'',500],
      ['tenant',label('接口tenant；没有则留空','Interface tenant; empty if absent'),current.declaration.a2a?.tenant??'',256]
    ],value=>{
      const declaration={...current.declaration};delete declaration.a2a;
      if(value.endpoint)declaration.a2a={protocol:'a2a/1.0',transport:'JSONRPC',...value};
      confirm({kind:'declare',builderId,baseDeclarationId:current.declarationId,declaration,visibility:current.disclosure.visibility,viewers:current.disclosure.viewers},back);
    },back)]);
    menu(`${plain(current.declaration.name)} · ${plain(current.type)}\n${plain(current.registration.state)} · ${plain(current.compatibility.state)}\n${label('登记和报告不等于能力认证','Registration and reports are not capability certification')}`,entries);
  });}
  function listing(type,after){void run(()=>controller.queryBuilders({query,limit:8,...(type?{type}:{}),...(after?{after}:{})}),page=>{
    const entries=page.items.map(item=>[plain(item.name),()=>detail(item.builderId),`${plain(item.type)} · ${plain(item.compatibility.state)} · ${plain(item.reachability.state)}`]);
    if(page.nextAfter)entries.push([label('下一批','Next results'),()=>listing(type,page.nextAfter)]);menu(label('建设者目录','Builder directory'),entries);
  });}
  function notices(builderId,after=0,back=home){void run(()=>controller.queryBuilderNotices({builderId,after,limit:8}),page=>{
    const entries=page.items.map(row=>[`${row.revision} · ${plain(row.action)}`,()=>message(`${plain(row.summary,2000)}\n${plain(row.eventId)}\n${plain(row.declarationId)}\n${label('这是维护沿革，不证明当前声明有效或端点可达。','Maintenance history; not evidence of current declaration validity or reachability.')}`,()=>notices(builderId,after,back))]);
    if(page.nextAfter)entries.push([label('下一批','Next results'),()=>notices(builderId,page.nextAfter,back)]);
    menu(label('可见维护公告','Visible maintenance notices'),entries,back);
  },back);}
  function management(builderId){void run(()=>controller.getBuilderManagement({builderId}),current=>{
    const back=()=>management(builderId),entries=[
      [label('查看管理状态','Read management state'),()=>message(JSON.stringify(current,null,2),back)],
      [label('查看维护公告','Read maintenance notices'),()=>notices(builderId,0,back)]
    ];
    if(controller.prepareBuilder&&has('consent')){
      entries.push([label('重新发布准确声明','Publish a reviewed declaration'),()=>publish(current.type,current)]);
      const actions=[['delist',label('从目录下架','Delist')],['relist',label('恢复目录展示','Relist')],['correction',label('发布纠正说明','Publish correction')],['security-issue',label('发布安全公告','Publish security notice')],['resolve-security',label('解决安全问题','Resolve security issue')]];
      for(const [action,title] of actions){if(!current.allowedActions.includes(action)||action==='delist'&&current.delisted||action==='relist'&&!current.delisted||action==='security-issue'&&current.securityIssue||action==='resolve-security'&&!current.securityIssue)continue;
        entries.push([title,()=>form(title,[['summary',label('本次公开或私有说明','Explanation for this notice'),'',2000]],value=>{
          const input={management:true,kind:'maintenance',builderId,baseDeclarationId:current.declarationId,baseRevision:current.revision,action,summary:value.summary};
          if(current.disclosure)confirm(input,back);else disclosure(input,back);
        },back)]);
      }
    }
    menu(`${label('管理我的登记','Manage my registration')} · ${plain(current.type)}\n${plain(current.declaration?.name??builderId)}\n${current.declarationState==='readable'?label('声明授权有效','Declaration authorization current'):label('旧声明不可读；可重新授权声明、下架或发布新说明','Prior declaration unavailable; review a new declaration or publish a control notice')}`,entries);
  });}
  function owned(after){void run(()=>controller.queryOwnedBuilders({limit:8,...(after?{after}:{})}),page=>{
    const entries=page.items.map(item=>[plain(item.name??item.builderId),()=>management(item.builderId),`${plain(item.type)} · ${plain(item.declarationState)}`]);
    if(page.nextAfter)entries.push([label('下一批','Next results'),()=>owned(page.nextAfter)]);menu(label('我的登记（含不可读声明）','My registrations (including unavailable declarations)'),entries);
  });}
  function operations(){void run(()=>controller.listBuilderOperations(),page=>{
    menu(label('本机建设者待办','Local Builder operations'),page.items.map(row=>[`${plain(row.kind)} · ${plain(row.action??row.eventId)}`,()=>{
      const back=operations,entries=[
        [label('核对远端事件结果','Reconcile remote event'),()=>void run(()=>controller.reconcileBuilder(row.eventId),result=>message(`${JSON.stringify(result,null,2)}\n${label('回执只说明事件是否被接收，不代表当前公开或有效。','Receipt describes event acceptance, not current publication or validity.')}`,back),back)],
        ...(row.status!=='acknowledged'?[[label('预览原事件重试','Preview exact event retry'),()=>confirmPrepared(()=>controller.prepareBuilderRetry(row.eventId),back)]]:[]),
        ...(['prepared','acknowledged'].includes(row.status)?[[label('移除此本机记录','Remove this local record'),()=>void run(()=>controller.forgetBuilderOperation(row.eventId),()=>message(label('本机记录已移除；远端数据未删除。','Local record removed; remote data was not deleted.'),back),back)]]:[])
      ];menu(`${plain(row.eventId)}\n${plain(row.builderId)}\n${plain(row.status)}`,entries,back);
    },plain(row.status)]));
  });}
  function home(){menu(label('Galaxy / 建设者','Galaxy / Builders'),[
    [label('浏览目录','Browse directory'),()=>menu(label('登记类型','Builder type'),['worker','bridge','hub'].map(type=>[type,()=>listing(type)]))],
    [label('搜索目录','Search directory'),()=>form('Builders',[['query',label('名称或适用范围中的文字','Text in name or scope'),query,200]],v=>{query=v.query;listing();})],
    [label('按ID打开','Open by ID'),()=>form('Builders',[['builderId','Builder ID','',36]],v=>detail(v.builderId))],
    ...(controller.prepareBuilder&&has('consent')?[[label('新建登记','Register builder'),()=>menu(label('登记类型','Builder type'),['worker','bridge','hub'].map(type=>[type,()=>publish(type)]))]]:[]),
    ...(controller.queryOwnedBuilders?[[label('管理我的登记','Manage my registrations'),()=>owned()]]:[]),
    ...(controller.queryBuilderNotices?[[label('按ID查看维护公告','Read notices by ID'),()=>form('Builder',[['builderId','Builder ID','',36]],value=>notices(value.builderId))]]:[]),
    ...(controller.listBuilderOperations?[[label('本机建设者待办','Local Builder operations'),operations]]:[])
  ],leave);}
  return Object.freeze({open:home,openBuilder:detail});
}
