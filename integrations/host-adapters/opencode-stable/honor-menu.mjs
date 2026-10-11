import {sourceReadingText} from './source-reading.mjs';
export function createHonorMenu({controller,select,prompt,info,language,isCurrent,onBack}) {
  const zh=language!=='en-US',label=(a,b)=>zh?a:b;
  const plain=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,1200);
  const stateName=state=>({'insufficient-evidence':label('当前来源不足','Insufficient current sources'),'inactive-rule':label('本规则当前未启用','Rule currently inactive'),'incomplete-source-scan':label('当前来源尚未全部读取','Current source read incomplete'),accepted:label('已验收','Accepted'),canceled:label('已取消','Canceled'),active:label('进行中','Active'),delivered:label('已交付，待验收','Delivered; awaiting acceptance')}[state]??plain(state));
  const cardState=state=>state==='active'?label('当前符合本规则','Currently meets this rule'):stateName(state);
  const date=value=>Number.isFinite(value)?new Date(value*1000).toLocaleString(zh?'zh-CN':'en-US'):'';
  const correctionState=state=>({ 'not-required':label('无需纠正后复核','No correction review required'),
    'new-delivery-required':label('需要按当前纠正记录重新交付','A new delivery must acknowledge current corrections'),
    'awaiting-requester-acceptance':label('等待请求者重新验收','Waiting for requester reacceptance'),
    'participant-reaccepted':label('已重新交付并验收','Delivered again and reaccepted') })[state]??plain(state);
  let generation=0,viewGeneration=0;
  const leave=()=>{generation++;controller.cancel();onBack();};
  const message=(text,back=home)=>{if(isCurrent())info('Galaxy',text,back);};
  const menu=(title,entries,back=home,offset=0)=>{
    if(!isCurrent())return;const routes={},version=++viewGeneration,activate=fn=>()=>{if(isCurrent()&&version===viewGeneration){viewGeneration++;fn();}};const options=entries.slice(offset,offset+8).map(([title,action,description=''],i)=>{
      routes[i+1]=activate(action);return {number:String(i+1),title,description};});
    if(offset+8<entries.length){options.push({number:'9',title:label('下一页','Next page'),description:''});routes[9]=activate(()=>menu(title,entries,back,offset+8));}
    select({title,options,routes,onBack:activate(offset?()=>menu(title,entries,back,offset-8):back)});
  };
  async function run(work,done,back=home){const version=++generation;
    message(label('正在读取来源事实','Reading source facts'),()=>{generation++;controller.cancel();back();});
    try{const result=await work();if(isCurrent()&&generation===version)done(result);}catch(error){if(isCurrent()&&generation===version)message(plain(error.message),back);}
  }
  function card(rule,subjectId,publicView=false,paging={},section){
    const input={ruleId:rule.id,ruleVersion:rule.version,...(subjectId?{subjectId}:{}),...paging};
    void run(()=>controller[publicView?'getPublicHonor':'getHonor'](input),view=>{
      const current=view.card,refresh=()=>card(rule,current.subjectId,publicView);
      const next=(page,target)=>card(rule,current.subjectId,publicView,{...page,expectedFingerprint:current.sourceFingerprint},target);
      function references(kind,index,after=0,back=refresh){
        const query={ruleId:rule.id,ruleVersion:rule.version,subjectId:current.subjectId,expectedFingerprint:current.sourceFingerprint,limit:8,
          ...(kind==='source'?{sourceId:index,sourceAfter:after}:{riskIndex:index,riskReferenceAfter:after})};
        void run(()=>controller[publicView?'getPublicHonor':'getHonor'](query),result=>{
          const detail=result[kind==='source'?'sourceDetail':'riskDetail'];
          const entries=detail.items.map(item=>[plain(item.kind),()=>message(plain(JSON.stringify(item.value)),()=>references(kind,index,after,back)),plain(typeof item.value==='string'?item.value:JSON.stringify(item.value))]);
          if(detail.nextAfter!==null)entries.push([label('下一批引用','Next references'),()=>references(kind,index,detail.nextAfter,back)]);
          menu(`${label('来源引用','Source references')} · ${after}/${detail.total}`,entries,after?()=>references(kind,index,Math.max(0,after-8),back):back);
        },refresh);
      }
      function sources(){
        const entries=view.contributions.map((item,index)=>{
          const title=plain(item.title)||label('工作来源 ','Work source ')+((view.pagination?.contributions?.offset??0)+index+1);
          const detail=()=>menu(title+'\n'+[
            stateName(item.state),item.independence==='issuer-declared-related-party'?label('已声明关联方','Declared related party'):item.independence==='independence-not-established'?label('未确认独立关系','Independence not established'):'',
            ...(item.paused?[label('当前已暂停','Currently paused')]:[]),...(item.corrected?[label('原工作已纠正','Original work corrected')]:[]),...(item.disputed?[label('当前有异议','Current dispute')]:[]),
            ...(item.correctionReview?[`${label('纠正后复核','Correction review')}: ${correctionState(item.correctionReview.state)} · ${label('复核版本','Review version')} ${plain(item.correctionReview.deliveredCaseReviewVersion)}`,
              label('双方重新验收不等于独立能力认证。','Participant reacceptance is not independent capability certification.')]:[]),
            ...(item.referencesComplete===false?[label('以下为部分引用；完整引用可逐页查看','Partial references; open all references to continue')]:[])
          ].filter(Boolean).join('\n'),[[label('查看准确来源记录','Inspect exact source records'),()=>message(JSON.stringify(item,null,2),sources)]],sources);
          return [title,()=>item.referencesComplete===false?menu(label('贡献来源详情','Contribution source details'),[
            [label('查看摘要','View summary'),detail],[label('查看全部引用','All references'),()=>references('source',item.assistanceId,0,sources)]
          ],sources):detail(),stateName(item.state)];
        });
        const page=view.pagination?.contributions;
        if(page?.nextAfter)entries.push([label('下一批贡献','Next contributions'),()=>next({after:page.nextAfter},'sources')]);
        menu(`${label('可见来源','Visible sources')}${page?` · ${page.total}`:''}`,entries,refresh);
      }
      function proofs(){
        const entries=(current.proofs??[]).map((item,index)=>{const source=item.provenance?.source??item.source??{},title=[source.owner&&source.repository?source.owner+'/'+source.repository:'',source.runId?label('运行 ','Run ')+source.runId:'',item.provenance?.conclusion??item.conclusion].filter(Boolean).map(plain).join(' · ')||label('CI 来源 ','CI source ')+(index+1);
          return[title,()=>menu(title+'\n\n'+sourceReadingText({type:'proof',record:{assertion:item.provenance??item},summary:item.conclusion??item.scope},label,plain),[[label('查看准确来源记录','Inspect exact source records'),()=>message(JSON.stringify(item,null,2),proofs)]],proofs),plain(item.scope??'')];});
        if(view.pagination?.proofs.nextAfter)entries.push([label('下一批CI依据','Next CI evidence'),()=>next({proofAfter:view.pagination.proofs.nextAfter},'proofs')]);
        menu(`${label('CI依据','CI evidence')} · ${current.proofCount??current.proofs?.length??0}`,entries,refresh);
      }
      const entries=[
        [label('贡献与可靠性分项','Contribution and reliability facets'),()=>message([
          `${label('不同Case验收数','Distinct accepted Cases')}: ${view.facets.contribution.acceptedCases}`,
          `${label('关联方Case数','Related-party Cases')}: ${view.facets.contribution.relatedPartyCases}`,
          `${label('有限CI证据数','Limited CI evidence count')}: ${view.facets.capabilityEvidence.proofCount}`,
          ...Object.entries({accepted:label('已验收协作','Accepted collaborations'),canceled:label('已取消协作','Canceled collaborations'),disputed:label('有异议协作','Disputed collaborations'),paused:label('已暂停协作','Paused collaborations')}).filter(([key])=>Number.isFinite(view.facets.collaborationReliability[key])).map(([key,name])=>name+': '+view.facets.collaborationReliability[key]),
          label('请求者履历单列；没有全局总分或自动接单资格','Requester history is separate; no global score or automatic qualification')
        ].join('\n'),refresh)],
        [label('查看来源贡献','Source contributions'),sources],
        [label('规则与时间窗','Rule and time window'),()=>message([
          plain(current.rule.title),label('版本 ','Version ')+plain(current.rule.version),
          ...(Number.isFinite(current.rule.windowFrom)&&Number.isFinite(current.rule.windowUntil)?[label('来源时间范围','Source time window')+': '+date(current.rule.windowFrom)+' — '+date(current.rule.windowUntil)]:[]),
          ...(Number.isFinite(current.rule.notBefore)&&Number.isFinite(current.rule.notAfter)?[label('规则有效时间','Rule validity')+': '+date(current.rule.notBefore)+' — '+date(current.rule.notAfter)]:[]),
          ...(Number.isFinite(current.rule.minAcceptedCases)?[label('所需验收工作数','Required accepted work count')+': '+current.rule.minAcceptedCases]:[]),
          ...(Number.isFinite(current.rule.minProofs)?[label('所需 CI 来源数','Required CI source count')+': '+current.rule.minProofs]:[])
        ].join('\n\n'),refresh)],
        [label('当前状态链接','Current status link'),()=>message(`${plain(current.statusUrl)}\n${label('接收方仍须有来源权限；截图不是当前证明','Recipients still need source access; screenshots are not current proof')}`,refresh)],
        [label('查看卡片与规则来源','Inspect card and rule sources'),()=>message(JSON.stringify(current,null,2),refresh)]
      ];
      function risks(){
        const risk=view.riskAssessment,codes={
          'declared-related-parties':label('运营者声明的关联方关系','Issuer-declared related parties'),
          'accepted-work-under-review':label('曾验收的工作出现纠正、争议或暂停','Previously accepted work is corrected, disputed or paused'),
          'corrected-work-reaccepted':label('纠正后已重新交付并由请求者验收','Corrected work was delivered again and accepted by the requester'),
          'repeated-source-case':label('同一Case对应多条协作记录','Multiple collaborations reference one Case'),
          'evidence-reused-across-cases':label('多个Case复用同一Evidence','Multiple Cases reuse one Evidence'),
        'concentrated-participation':label('短时间内集中确认参与','Concentrated participation confirmations'),
        'reciprocal-acceptance-cycle':label('可见协作存在循环验收','Visible reciprocal acceptance cycle'),
        'ci-source-reused':label('多份记录引用同一CI来源','Multiple records reference one CI source'),
        'ci-source-conflict':label('同一CI来源的当前记录有冲突','Current records conflict within one CI source'),
        'accepted-work-ci-not-successful':label('已验收协作引用非成功CI结果','Accepted work references a non-successful CI outcome'),
        };
        const riskEntries=risk.flags.map((flag,index)=>{const detail=()=>message([
            `Policy: ${plain(risk.policy.id)}@${plain(risk.policy.version)}`,
            ...flag.caseIds.map(id=>`Case: ${plain(id)}`),...flag.assistanceIds.map(id=>`Assistance: ${plain(id)}`),
            ...flag.eventIds.map(id=>`Event: ${plain(id)}`),...flag.evidenceIds.map(id=>`Evidence: ${plain(id)}`),
            ...(flag.sourceKeys??[]).map(key=>`CI source: ${plain(key)}`),
            ...(flag.edges??[]).map(edge=>`${plain(edge.requesterId)} → ${plain(edge.providerId)} · ${plain(edge.assistanceId)}`),
            ...(flag.edges?.length?[label('循环验收不等于串通或独立验证；需结合来源复核。','An acceptance cycle does not establish collusion or independent verification.')]:[]),
            label('仅基于当前可见来源；没有提示不代表不存在问题。','Only current visible sources; no signal does not establish absence of problems.'),
          ].join('\n'),refresh);
          return [Object.hasOwn(codes,flag.code)?codes[flag.code]:plain(flag.code),()=>flag.referencesComplete===false?menu(label('风险引用详情','Risk reference details'),[
            [label('查看摘要','View summary'),detail],[label('查看全部引用','All references'),()=>references('risk',(view.pagination?.risks.after??0)+index,0,risks)]
          ],risks):detail()];
        });
        if(view.pagination?.risks.nextAfter!==null&&view.pagination?.risks.nextAfter!==undefined)riskEntries.push([label('下一批风险提示','Next risk signals'),()=>next({riskAfter:view.pagination.risks.nextAfter},'risks')]);
        menu(`${label('风险提示，仅供复核','Risk signals for review only')}\n${plain(risk.status)}\n${label('不判定欺诈，不自动扣分或处罚','No fraud determination, automatic scoring or penalty')}`,riskEntries,refresh);
      }
      if(view.riskAssessment)entries.push([label('查看风险提示','Review risk signals'),risks]);
      if(!publicView&&controller.getPublicHonor)entries.push([label('检查公开可见结果','Check public projection'),()=>card(rule,current.subjectId,true)]);
      if(current.proofs)entries.push([label('查看CI依据','View CI evidence'),proofs]);
      if(section==='sources')return sources();if(section==='proofs')return proofs();if(section==='risks')return risks();
      menu(`${plain(rule.title)}\n${cardState(current.status)}\n${label('读取时间','Read at')}: ${date(current.checkedAt)}`,entries);
    });
  }
  function ranking(rule){void run(()=>controller.honorRanking({ruleId:rule.id,ruleVersion:rule.version}),result=>{
    if(result.status!=='published')return message(`${label('本范围暂不发布排名','Ranking is not published for this scope')}\n${plain(result.reason)}`);
    menu(`${plain(rule.communityId)} · ${plain(rule.capabilityId)}\n${label('仅公开合格样本；不能据此宣称行业结论','Public eligible cohort only; no industry conclusion')}`,
      result.items.map(item=>[`${item.rank}. ${plain(item.subjectId)}`,()=>card(rule,item.subjectId,true),`${item.acceptedCases} Cases · ${item.relatedPartyCases} related`]));
  });}
  function ruleHistory(ruleId,after=0){void run(()=>controller.honorRuleHistory({...(ruleId?{ruleId}:{}),after,limit:8}),result=>{
    const entries=result.items.map(item=>[`${plain(item.rule.title)} · ${plain(item.rule.version)}`,()=>menu(label('历史规则版本','Historical rule version'),[
      [label('查看规则定义与当前启用状态','Rule definition and current activation'),()=>message(JSON.stringify(item,null,2),()=>ruleHistory(ruleId,after))],
      [label('按此版本查看我的卡片','My card under this version'),()=>card(item.rule)]
    ],()=>ruleHistory(ruleId,after)),item.registry.configured?(item.registry.revoked?label('已撤销','Revoked'):label('在当前配置中','In current configuration')):label('当前未启用','Not currently configured')]);
    if(result.nextAfter!==null)entries.push([label('下一批历史版本','Next historical versions'),()=>ruleHistory(ruleId,result.nextAfter)]);
    menu(label('规则历史；不代表曾经取得荣誉','Rule history; does not establish a past award'),entries,home);
  });}
  function home(){void run(()=>controller.honorRules(),result=>{const entries=result.rules.map(rule=>[
    plain(rule.title),()=>menu(plain(rule.title),[
      [label('查看我的贡献卡片','My contribution card'),()=>card(rule)],
      [label('按Galaxy ID查看','View by Galaxy ID'),()=>prompt({title:'Galaxy ID',placeholder:'GUID...',onCancel:home,onConfirm:value=>{if(isCurrent())card(rule,String(value).trim());}})],
      [label('查看范围内排名','Scoped ranking'),()=>ranking(rule)],
      ...(result.ruleHistorySupported&&controller.honorRuleHistory?[[label('查看此规则的历史版本','History of this rule'),()=>ruleHistory(rule.id)]]:[])
    ]),`${plain(rule.communityId)} · ${plain(rule.capabilityId)} · ${plain(rule.version)}`
  ]);if(result.ruleHistorySupported&&controller.honorRuleHistory)entries.push([label('查看全部历史规则','All historical rules'),()=>ruleHistory()]);
    menu(label('贡献与Honor规则','Contribution and Honor rules'),entries,leave);},leave);}
  return Object.freeze({open:home});
}
