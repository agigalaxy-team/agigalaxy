import { createBuilderMenu } from './builder-menu.mjs';
import { createCapsuleMenu } from './capsule-menu.mjs';
import { createHonorMenu } from './honor-menu.mjs';
import { createAssistanceDraftMenu } from './assistance-draft-menu.mjs';
import { createContextDraftMenu } from './context-draft-menu.mjs';
import { publicContributionEventKinds } from '../../../packages/galaxy-official/src/shared/assistance-schema.mjs';
import {showExactChoice} from './exact-choice.mjs';
import {createExistingRecordSelection} from './existing-record-selection.mjs';
// Native host dialog composition; no web view, network access or signing here.
export function createAssistanceMenu({ controller, select, prompt, info, language, onBack, isCurrent, availableScopes = null, readWorkContext }) {
  const zh = language !== 'en-US', label = (a, b) => zh ? a : b;
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 1200);
  let generation = 0, query = '';
  const alive = () => isCurrent();
  const has = scope => !availableScopes || availableScopes.includes(scope);
  const stateName=value=>({open:label('等待参与','Open for participation'),'awaiting-confirmation':label('等待确认参与','Awaiting participation confirmation'),active:label('协作中','Working together'),'awaiting-scope-confirmation':label('等待确认新范围','Awaiting scope confirmation'),delivered:label('等待验收','Awaiting acceptance'),accepted:label('已验收','Accepted'),canceled:label('已取消','Canceled'),expired:label('招募已结束','Enrollment ended'),disputed:label('有待处理的异议','Dispute raised'),'awaiting-resolution-confirmation':label('等待确认处理方案','Awaiting resolution confirmation'),resolved:label('已处理','Resolved'),pending:label('等待接收','Awaiting acceptance')}[value]??plain(value));
  const eventName=value=>({invite:label('邀请参与','Invitation'),offer:label('申请协助','Offer'),select:label('选择参与者','Participant selected'),confirm:label('确认参与','Participation confirmed'),'change-scope':label('调整协作范围','Scope changed'),'confirm-scope':label('确认新范围','Scope confirmed'),deliver:label('交付结果','Result delivered'),accept:label('验收交付','Delivery accepted'),cancel:label('取消协作','Collaboration canceled'),expire:label('结束招募','Enrollment ended'),dispute:label('提出异议','Dispute raised'),'propose-resolution':label('提出处理方案','Resolution proposed'),'confirm-resolution':label('确认处理方案','Resolution confirmed'),'requester-feedback':label('评价请求说明','Request description assessment')}[value]??plain(value));
  const clarityName=value=>({clear:label('清楚','Clear'),'partly-clear':label('部分清楚','Partly clear'),unclear:label('不清楚','Unclear')}[value]??plain(value));
  const budgetText=budget=>!budget?'':budget.mode==='fixed'?label('报酬','Compensation')+': '+plain(budget.amount)+' '+plain(budget.unit):budget.mode==='range'?label('报酬区间','Compensation range')+': '+plain(budget.minimum)+'–'+plain(budget.maximum)+' '+plain(budget.unit):label('请求报价','Request quote')+' · '+plain(budget.unit);
  const requestText=req=>[
    req.problem?label('工作情况','Work context')+'\n'+plain(req.problem):'',
    req.attemptedApproaches?.length?label('已有尝试','Previous approaches')+'\n'+req.attemptedApproaches.map(plain).join('\n'):'',
    label('希望得到的协助','Requested help')+'\n'+plain(req.scope),
    budgetText(req.budget),
  ].filter(Boolean).join('\n\n');
  const leave = () => { generation++; controller.cancel(); onBack(); };
  const menu = (title, entries, back = home, offset = 0) => {
    if (!alive()) return;
    const routes = {}, options = entries.slice(offset, offset + 8).map(([title, action, description = ''], i) => {
      routes[i + 1] = () => { if (alive()) action(); };
      return { number: String(i + 1), title, description };
    });
    if (offset + 8 < entries.length) {
      options.push({ number: '9', title: label('下一页', 'Next page'), description: '' });
      routes[9] = () => menu(title, entries, back, offset + 8);
    }
    select({ title, options, routes, onBack: offset ? () => menu(title, entries, back, Math.max(0, offset - 8)) : back });
  };
  const message = (text, back = home) => { if (alive()) info('Galaxy', text, back); };
  async function run(work, done, back = home) {
    const version = ++generation;
    message(label('正在读取或准备；Esc返回。', 'Reading or preparing; Esc returns.'), () => { generation++; controller.cancel(); back(); });
    try { const result = await work(); if (alive() && version === generation) done(result); }
    catch (error) { if (alive() && version === generation) { controller.cancel(); message(plain(error.message), back); } }
  }
  function form(title, fields, done, back = home, draft = {}, index = 0) {
    if (!alive()) return;
    if (index === fields.length) { done(draft); return; }
    const [key, name, initial = ''] = fields[index];
    prompt({ title: `${title} · ${index + 1}/${fields.length}\n${name}`, placeholder:name,value:String(draft[key] ?? initial),
      onCancel: index ? () => form(title, fields, done, back, draft, index - 1) : back,
      onConfirm: value => {
        if (!alive()) return;
        if (String(value).length > 1200) { message(label('最多1200字符。', 'Maximum 1200 characters.'), () => form(title, fields, done, back, draft, index)); return; }
        draft[key] = value.trim(); form(title, fields, done, back, draft, index + 1);
      } });
  }
  function confirm(input, back, context = false, retry = false) {
    void run(() => controller[retry ? context ? 'prepareContextRetry' : 'prepareCollaborationRetry' : context === 'moderation' ? 'prepareModeration' : context ? 'prepareContext' : 'prepareCollaboration'](input), preview => {
      let submitted = false;
      const cancel = () => { generation++; controller.cancel(); back(); };
      const previewVersion=generation;
      const show = () => showExactChoice({preview,title:label(context==='moderation'?'保存这次处理记录':context?'调整这份材料的授权':'继续这次协作',context==='moderation'?'Save this handling record':context?'Change this material authorization':'Continue this collaboration'),select,info,language,isCurrent:()=>alive()&&generation===previewVersion&&!submitted,
        onCancel: cancel, onConfirm: async value => {
          if (!alive() || submitted) return;
          submitted = true; const version = ++generation;
          message(label('正在提交；Esc取消等待。', 'Submitting; Esc cancels waiting.'), cancel);
          try {
            const receipt = await controller[context === 'moderation' ? 'executeModeration' : context ? 'executeContext' : 'executeCollaboration'](preview, value);
            if (alive() && version === generation) message(label(context === 'moderation' ? '这次处理记录已保存。' : context ? '所选材料的授权已保存。' : '这次协作已保存。', context === 'moderation' ? 'This handling record was saved.' : context ? 'The selected material authorization was saved.' : 'This collaboration was saved.'), context ? back : () => detail(receipt.assistanceId));
          } catch {
            if (alive() && version === generation) message(label('结果暂未确认；原内容已保留，继续时会读取同一次操作。', 'The outcome is unconfirmed. The original content is retained; continuing reads this same operation.'), context || controller.listCollaborationOperations ? back : () => detail(preview.assistanceId));
          }
        } }); show();
    }, back);
  }
  function budget(done, back, optional = false) {
    menu(label('协作与预算说明', 'Collaboration and budget'), [
      [label(optional ? '不报价' : '开放协助', optional ? 'No quote' : 'Open assistance'), () => done(undefined)],
      [label('固定金额', 'Fixed amount'), () => form('Budget', [['amount', label('金额', 'Amount')], ['unit', label('结算单位（仅说明）', 'Unit (description only)')]], doneValue => done({ mode: 'fixed', ...doneValue }), back)],
      [label('预算区间', 'Budget range'), () => form('Budget', [['minimum', label('最低金额', 'Minimum')], ['maximum', label('最高金额', 'Maximum')], ['unit', label('结算单位', 'Unit')]], doneValue => done({ mode: 'range', ...doneValue }), back)],
      [label('请求报价', 'Request quote'), () => form('Budget', [['unit', label('结算单位', 'Unit')]], doneValue => done({ mode: 'quote', ...doneValue }), back)]
    ], back);
  }
  function create() {
    if (controller.createAssistanceDraft) return drafts().create();
    form(label('发布求助', 'Create request'), [
      ['caseId', label('已发布Case的ID', 'ID of your published Case')], ['title', label('标题', 'Title')],
      ['problem', label('问题说明', 'Problem')], ['attempts', label('已有尝试（每行一条，可留空）', 'Previous approaches (one per line, optional)')],
      ['scope', label('希望得到怎样的协助', 'What help would you like')]
    ], draft => {
      const request = { caseId: draft.caseId, title: draft.title, problem: draft.problem,
        attemptedApproaches: draft.attempts.split(/\r?\n/).map(s => s.trim()).filter(Boolean), scope: draft.scope,
        collaboration:'open-assistance',enrollmentExpiresAt:Math.floor(Date.now()/1000+86400) };
      const visibility = (value, viewers = []) => confirm({request:{...request,visibility:value},viewers},create);
      menu(label('请求可见性', 'Request visibility'), [
        [label('仅自己','Only me'),()=>visibility('Private')],
        [label('私有：指定参与者', 'Private: named participants'), () => form('Private', [['viewers', label('参与者Galaxy ID，逗号分隔；留空仅自己可见', 'Participant Galaxy IDs, comma separated; empty means only you')]], value => visibility('Private', value.viewers.split(/[,，]/).map(s => s.trim()).filter(Boolean)), create)],
        [label('公开请求说明', 'Public request description'), () => visibility('Public')]
      ], create);
    });
  }
  function listing(view, after) {
    void run(() => controller.queryAssistance({ view, query, limit: 8, ...(after ? { after } : {}) }), page => {
      const entries = [[label('查找','Find'),()=>form(label('查找求助','Find requests'),[['query',label('标题或问题中的文字；留空查看全部','Text in title or problem; empty shows all'),query]],value=>{query=value.query;listing(view);},()=>listing(view,after)),query],
        ...page.items.map(item => [plain(item.request.title), () => detail(item.assistanceId, () => listing(view, after)), `${stateName(item.state)} · ${plain(item.request.scope)}`])];
      if (page.nextAfter) entries.push([label('下一批', 'Next results'), () => listing(view, page.nextAfter)]);
      menu(`${view==='requested'?label('我发起的求助','My requests'):view==='participating'?label('我参与的协作','My participation'):label('找需要帮助的工作','Find requests')}\n${page.items.length ? '' : label('暂无匹配请求', 'No matching requests')}`, entries);
    });
  }
  function grantMaterials(assistanceId, back, record) {
    if(controller.createContextDraft)return materials().create(record);
    form(label('选定文本材料', 'Selected text material'), [
      ['label', label('材料名称', 'Material label')],
      ['content', label('粘贴选定片段；不要包含凭据或完整会话', 'Paste selected excerpt; exclude credentials and full sessions')],
      ['hours', label('有效小时数；默认1小时', 'Validity in hours; default 1'), '1']
    ], value => {
      const hours = Number(value.hours || '1');
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return message(label('有效期必须大于0且不超过24小时。', 'Validity must be over 0 and at most 24 hours.'), back);
      confirm({ kind: 'grant', assistanceId, expiresAt: Math.floor(Date.now() / 1000 + hours * 3600),
        materials: [{ label: value.label, content: value.content }] }, back, true);
    }, back);
  }
  function materialList(assistanceId, owner, back) {
    void run(() => controller.queryContext(assistanceId), page => {
      const refresh = () => materialList(assistanceId, owner, back);
      menu(label('协作材料授权', 'Collaboration material grants'), page.items.map(item =>
        [item.materials.map(material => plain(material.label)).join(', '), () => materialDetail(item.grantId, owner, refresh), plain(item.state)]), back);
    }, back);
  }
  function materialDetail(grantId, owner, back) {
    void run(() => controller.getContext(grantId), grant => {
      const entries = [], refresh = () => materialDetail(grantId, owner, back);
      if (controller.prepareContext && !owner && grant.state === 'pending') entries.push([
        label('确认接收这份材料授权', 'Accept this material grant'), () => confirm({ kind: 'accept', grantId }, refresh, true)]);
      if (controller.prepareContext && owner) entries.push([
        label('撤销这份材料授权', 'Revoke this material grant'), () => confirm({ kind: 'revoke', grantId }, back, true)]);
      for (const material of grant.materials) entries.push([plain(material.label), () => message(
        grant.contextAccessGranted ? String(material.content).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 4000)
          : label('确认接收前正文不可读。', 'Content is unavailable until you accept.'), refresh)]);
      entries.push([label('来源与详细授权','Source and authorization details'),()=>message(JSON.stringify(grant,null,2),refresh)]);
      menu(`${label('协作材料', 'Collaboration materials')}\n${grant.state==='accepted'?label('已接收','Accepted'):stateName(grant.state)}\n${label('可用范围','Permitted scope')}: ${plain(grant.scope)}\n${label('接收身份','Recipient identity')}: ${plain(grant.participantId)}\n${label('到期', 'Expires')}: ${new Date(grant.expiresAt * 1000).toISOString()}`, entries, back);
    }, back);
  }
  function detail(id, back = home, readFirst = true) {
    void run(() => controller.getAssistance(id), record => {
      const requester = record.view === 'requester', provider = record.view === 'selected-provider';
      const reload = () => detail(id, back, false), entries = [];
      const command = event => {
        if(controller.createAssistanceEventDraft&&['select','shortlist','confirm','confirm-scope','expire','confirm-resolution'].includes(event.kind)){
          const {kind,...target}=event;return drafts().createEvent({record,eventKind:kind,target});
        }
        if(record.request.visibility==='Public'&&publicContributionEventKinds.includes(event.kind))return menu(label('此次贡献事件的可见性','Visibility of this contribution event'),[
          [label('私有：仅协作参与者','Private: collaboration participants'),()=>confirm({assistanceId:id,event},reload)],
          [label('公开：用于公开履历','Public: available for public history'),()=>confirm({assistanceId:id,event,eventVisibility:'Public'},reload),
            label('仅本次事件；下一步审阅全部内容并确认。','This event only; review all content and confirm next.')]
        ],reload);
        confirm({assistanceId:id,event},reload);
      };
      const fields = (kind, prompts, extra = {}, convert = values => values) => controller.createAssistanceEventDraft
        ? drafts().createEvent({record,eventKind:kind,target:extra}) : form(kind, prompts, values => command({ kind, ...extra, ...convert(values) }), reload);
      const choice = (kind, offers) => menu(label('选择申请', 'Choose offer'), offers.map(offer => [plain(offer.providerId), () => command({ kind, ...(kind === 'shortlist' ? { offerIds: [...new Set([...(record.shortlist ?? []), offer.id])] } : { offerId: offer.id }) }), `${plain(offer.proposal)} · ${plain(offer.scope)} · ${plain(JSON.stringify(offer.quote))}`]), reload);
      if (controller.prepareCollaboration && has('consent') && !record.paused) {
        if (record.state === 'open' && requester) {
          const offers = record.offers.filter(offer => !offer.withdrawn);
          entries.push([label('邀请参与者', 'Invite participant'), () => fields('invite', [['participantId', 'Galaxy ID'], ['note', label('邀请说明', 'Invitation note')]])]);
          if(offers.length)entries.push([label('查看申请并选择', 'Review and select offer'), () => choice('select', offers)]);
          if(offers.length>1)entries.push([label('比较候选人', 'Compare candidates'), () => choice('shortlist', offers)]);
        }
        if (record.state === 'open' && !requester && !record.offers.some(offer => !offer.withdrawn))
          entries.push([label('申请协助', 'Apply'), () => controller.createAssistanceEventDraft ? drafts().createEvent({record,eventKind:'offer'}) : form(label('申请', 'Offer'), [['proposal', label('方案说明', 'Proposal')], ['scope', label('可承担的范围', 'Offered scope')]], values => {
            const submit = evidence => {
              const fields = { ...values, ...(evidence ? { qualificationEvidence: evidence } : {}) };
              if (record.request.collaboration === 'basic-bounty') budget(quote => command({ kind: 'offer', ...fields, ...(quote ? { quote } : {}) }), reload, true);
              else command({ kind: 'offer', ...fields });
            };
            if (record.request.qualification) qualificationEvidence(submit, reload); else submit();
          }, reload)]);
        if (!requester && ['open', 'awaiting-confirmation'].includes(record.state)) {
          const own = record.offers.find(offer => !offer.withdrawn);
          if (own) entries.push([label('撤回申请', 'Withdraw offer'), () => fields('withdraw-offer', [['reason', label('原因', 'Reason')]], { offerId: own.id })]);
        }
        if (provider && record.state === 'awaiting-confirmation') entries.push([label('确认参与', 'Confirm participation'), () => command({ kind: 'confirm' })]);
        if (provider && record.state === 'awaiting-scope-confirmation') entries.push([label('确认范围变更', 'Confirm scope change'), () => command({ kind: 'confirm-scope' })]);
        if (requester && record.state === 'active') entries.push([label('提出范围变更', 'Change scope'), () => fields('change-scope', [['scope', label('新范围', 'New scope')], ['reason', label('原因', 'Reason')]])]);
        if (provider && (record.state==='active'||record.state==='delivered'&&record.eventFeatures?.deliveryCaseReview===1)) entries.push([label('提交交付', 'Deliver'), () => fields('deliver', [['attemptId', 'Attempt ID'], ['summary', label('交付说明', 'Delivery summary')], ['evidenceIds', label('Evidence ID，逗号分隔，可留空', 'Evidence IDs, comma separated, optional')]], {}, values => ({ ...values, evidenceIds: values.evidenceIds.split(/[,，]/).map(s => s.trim()).filter(Boolean) }))]);
        if (requester && record.state === 'delivered') entries.push([label('验收交付', 'Accept delivery'), () => fields('accept', [['summary', label('验收说明', 'Acceptance summary')]], { deliveryId: record.delivery.id })]);
        if ((requester || provider) && ['open', 'awaiting-confirmation', 'active', 'awaiting-scope-confirmation', 'delivered'].includes(record.state)) entries.push([label('取消协作', 'Cancel collaboration'), () => fields('cancel', [['reason', label('原因', 'Reason')]])]);
        if (requester && ['open', 'awaiting-confirmation'].includes(record.state) && record.request.enrollmentExpiresAt <= Date.now() / 1000) entries.push([label('记录招募到期', 'Record expiration'), () => command({ kind: 'expire' })]);
        if ((requester || provider) && ['active', 'awaiting-scope-confirmation', 'delivered', 'accepted', 'resolved'].includes(record.state)) entries.push([label('提出争议', 'Raise dispute'), () => fields('dispute', [['reason', label('原因', 'Reason')]])]);
        if ((requester || provider) && ['disputed', 'awaiting-resolution-confirmation'].includes(record.state)) entries.push([label('提出解决方案', 'Propose resolution'), () => fields('propose-resolution', [['summary', label('解决方案', 'Resolution')]])]);
        if ((requester || provider) && record.eventFeatures?.resumeWorkResolution===1 && ['disputed', 'awaiting-resolution-confirmation'].includes(record.state)) entries.push([label('提出继续工作方案', 'Propose resuming work'), () => fields('propose-resolution', [['summary', label('继续工作的方案；双方确认后重新交付与验收', 'Plan to resume; both parties confirm before a new delivery and acceptance')]],{outcome:'resume-work'})]);
        if (provider && ['accepted','canceled','resolved'].includes(record.state) && !record.events?.some(item => item.event.kind === 'requester-feedback'))
          entries.push([label('记录请求者协作反馈', 'Record requester feedback'), () => controller.createAssistanceEventDraft ? drafts().createEvent({record,eventKind:'requester-feedback'}) : form(label('协作反馈（提供者评价）', 'Feedback (provider-reported)'),
            [['descriptionClarity', label('描述清晰度：clear / partly-clear / unclear', 'Description clarity: clear / partly-clear / unclear')],
              ['scopeMatched', label('实际工作是否符合范围：yes / no', 'Did work match scope: yes / no')], ['note', label('来源说明', 'Feedback note')]],
            value => {
              if (!['yes','no'].includes(value.scopeMatched)) return message(label('请输入yes或no。', 'Enter yes or no.'), reload);
              command({ kind: 'requester-feedback', ...value, scopeMatched: value.scopeMatched === 'yes' });
            }, reload)]);
        if ((requester || provider) && record.state === 'awaiting-resolution-confirmation'
          && record.resolution.proposerId !== (requester ? record.requesterId : record.selected.providerId)) entries.push([label('确认对方解决方案', 'Confirm other party resolution'), () => command({ kind: 'confirm-resolution', proposalId: record.resolution.id })]);
      }
      if (!record.paused && controller.queryContext && has('context') && (requester || provider) && record.state === 'active') {
        if (requester && controller.prepareContext) entries.push([label('授权选定文本材料', 'Grant selected text'), () => grantMaterials(id, reload, record)]);
        entries.push([label('查看材料授权', 'View material grants'), () => materialList(id, requester, reload)]);
      }
      if (record.paused && controller.prepareCollaboration && has('consent') && (requester || provider)
        && !['accepted','canceled','expired','resolved'].includes(record.state)) entries.push([label('取消协作','Cancel collaboration'), () => fields('cancel', [['reason',label('原因','Reason')]])]);
      if (controller.queryModeration && has('moderation')) {
        entries.push([label('举报与处理记录','Reports and moderation'), () => moderationList(id, undefined, reload)]);
        if (controller.prepareModeration && has('consent')) entries.push([label('举报该协作','Report collaboration'), () => form('Galaxy',
          [['category',label('类别：abuse / privacy / scope / other\nmisrepresentation / malicious-artifact\ndata-extraction / work-fraud / false-verification','Category: abuse / privacy / scope / other\nmisrepresentation / malicious-artifact\ndata-extraction / work-fraud / false-verification')],['summary',label('说明','Summary')]],
          value => confirm({kind:'report',assistanceId:id,...value},reload,'moderation'),reload)]);
      }
      entries.push([label('查看协作记录', 'View collaboration record'), () => message((record.events ?? []).map(row => `${eventName(row.event.kind)}\n${plain(row.event.summary ?? row.event.reason ?? row.event.scope)}`).join('\n\n') || label('没有可见事件', 'No visible events'), reload)]);
      const req = record.request;
      entries.push([label('阅读全文','Read full request'),()=>detail(id,back)],
        [label('求助内容与条件','Request content and conditions'),()=>requestDetails(record,reload)],
        [label('来源与详细记录','Source and detailed record'),()=>message(JSON.stringify(record,null,2),reload)]);
      if(record.deliverySource)entries.push([label('查看当前交付依据','Current delivery source'),()=>message(`Case: ${plain(record.deliverySource.caseId)}\n${label('纠正/复核版本','Correction/review version')}: ${record.deliverySource.reviewVersion}\n${label('文字纠正次数','Text corrections')}: ${record.deliverySource.correctionCount}\n${label('已交付引用版本','Delivered version')}: ${plain(record.delivery?.caseReviewVersion)}\n${label('纠正/复核记录变化后须重新交付；恢复贡献仍需请求者验收。','Correction/review changes require a new delivery; contribution restoration still requires requester acceptance.')}`,reload)]);
      if(record.resolution?.outcome==='resume-work')entries.push([label('方案结果：继续工作','Resolution outcome: resume work'),()=>message(label('双方确认后返回工作中；原交付和验收保留在历史中，不自动恢复为已验收。','Both parties confirm returning to active work; previous delivery and acceptance remain in history and are not automatically restored.'),reload)]);
      const heading=plain(req.title),state=(record.paused?label('管理暂停 · ','Moderation paused · '):'')+stateName(record.state),showActions=()=>menu(heading+' · '+state,entries,back);
      const body=`${state}\n\n${requestText(req)}${record.agreedScope?'\n\n'+label('已约定范围','Agreed scope')+'\n'+plain(record.agreedScope):''}${record.pendingScope?'\n\n'+label('待确认的新范围','Pending scope')+'\n'+plain(record.pendingScope):''}${record.delivery?.summary?'\n\n'+label('交付结果','Delivered result')+'\n'+plain(record.delivery.summary):''}${record.resolution?.summary?'\n\n'+label('处理方案','Resolution')+'\n'+plain(record.resolution.summary):''}`;
      if(readFirst){const visible=generation;info(heading,body,()=>{if(alive()&&generation===visible)showActions();});}else showActions();
    }, back);
  }
  function requestDetails(record,back){const req=record.request;
    const show=policy=>message([
      plain(req.title),requestText(req),
      req.visibility==='Public'?label('公开所选说明','Public selected description'):label('私有授权范围','Private authorized audience'),
      Number.isFinite(req.enrollmentExpiresAt)?label('招募截止','Enrollment closes')+': '+new Date(req.enrollmentExpiresAt*1000).toISOString():'',
      req.qualification?label('参与条件','Participation requirements')+'\n'+(policy?plain(policy.title):label('须符合原选定政策；当前未取得政策正文。','The original selected policy applies; its text is currently unavailable.')):'',
    ].filter(Boolean).join('\n\n'),back);
    if(req.qualification&&controller.qualificationPolicies)return void run(()=>controller.qualificationPolicies(),result=>show(result.policies.find(p=>p.id===req.qualification.policyId&&p.version===req.qualification.policyVersion)),back);
    show();
  }
  function qualificationEvidence(done, back) {
    const evidence={proofIds:[],assistanceIds:[]},records=createExistingRecordSelection({controller,menu,message,run,label,plain});
    const choose=(kind,key)=>void run(()=>controller.status?.(),status=>{if(kind==='proof'&&!status?.subjectId)return message(label('当前未取得本人身份，请先恢复原连接。','Your identity is currently unavailable. Restore the original connection first.'),show);records.select(kind,item=>{if(!evidence[key].includes(item.id))evidence[key].push(item.id);show();},show,{subjectId:status?.subjectId,assistanceView:'participating',filter:record=>kind!=='assistance'||record.state==='accepted'});},show);
    const show=()=>menu(label('选择已有参与依据','Choose existing participation sources'),[
      [label('使用已选来源','Use selected sources'),()=>done(evidence),label('CI 来源','CI sources')+': '+evidence.proofIds.length+' · '+label('已验收协作','Accepted collaborations')+': '+evidence.assistanceIds.length],
      ...(controller.querySearch&&evidence.proofIds.length<16?[[label('选择本人 CI 来源','Choose my CI sources'),()=>choose('proof','proofIds')]]:[]),
      ...(controller.queryAssistance&&evidence.assistanceIds.length<16?[[label('选择本人已验收协作','Choose my accepted collaborations'),()=>choose('assistance','assistanceIds')]]:[]),
      [label('使用已掌握的原引用','Use original references you already hold'),()=>form(label('已有来源引用','Existing source references'),[['proofIds',label('已有 CI 来源引用，逗号分隔','Existing CI references, comma separated'),evidence.proofIds.join(',')],['assistanceIds',label('已有验收工作引用，逗号分隔','Existing accepted work references, comma separated'),evidence.assistanceIds.join(',')]],value=>{for(const key of Object.keys(evidence))evidence[key]=[...new Set(value[key].split(/[,，]/).map(s=>s.trim()).filter(Boolean))];show();},show)],
    ],back);show();
  }
  function qualifications() {
    void run(()=>controller.qualificationPolicies(), result=>menu(label('参与条件','Participation requirements'), result.policies.map(p=>[
      plain(p.title),()=>qualificationEvidence(evidence=>void run(()=>controller.evaluateQualification({policyId:p.id,policyVersion:p.version,capabilityId:p.capabilityId,evidence}),
        result=>menu(`${plain(p.title)}\n${result.eligible?label('符合此次参与条件','Eligible for this participation'):label('暂不符合此次参与条件','Not currently eligible for this participation')}\n${result.reasons.map(plain).join('\n')}\n${label('已验收工作','Accepted work')}: ${result.acceptedCollaborations?.length??0} · ${label('CI 来源','CI sources')}: ${result.proofs?.length??0}\n${label('该结论仅适用于这份参与政策，不是个人能力认证。','This conclusion applies to this participation policy; it does not certify individual capability.')}`,
          [[label('政策与来源详情','Policy and source details'),()=>message(JSON.stringify({policy:p,result},null,2),qualifications)],[label('继续','Continue'),qualifications]],qualifications),qualifications),qualifications),label('版本 ','Version ')+plain(p.version)
    ])));
  }
  function moderationList(target, after, back=home) {
    const filter=typeof target==='string'?{assistanceId:target}:target??{};
    void run(()=>controller.queryModeration({...filter,...(after?{after}:{}),limit:8}), page=>{
      const entries=page.items.map(item=>[plain(item.reportId),()=>moderationDetail(item.reportId,()=>moderationList(target,after,back)),`${item.caseId?'Case':'Assistance'} · ${plain(item.state)} · ${item.paused?label('已暂停','Paused'):label('未暂停','Not paused')}`]);
      if(page.nextAfter) entries.push([label('下一批','Next results'),()=>moderationList(target,page.nextAfter,back)]);
      menu(label('举报与处理记录','Reports and moderation'),entries,back);
    },back);
  }
  function moderationDetail(reportId,back) {
    void run(()=>controller.getModeration(reportId),record=>{
      const refresh=()=>moderationDetail(reportId,back),entries=[];
      const action=kind=>form('Galaxy',[['summary',label('处理或申诉说明','Decision or appeal explanation')],...(kind==='resolve'?[['verdict','upheld / dismissed']]:[])],
        value=>confirm({kind,reportId,...(kind==='revalidate'?{evidenceId:record.revalidation.evidenceId}:{}),...value},refresh,'moderation'),refresh);
      if(controller.prepareModeration && has('consent')) {
        if(record.canSupplement)entries.push([label('补充说明与引用','Supplement statement and references'),()=>form('Galaxy',
          [['summary',label('补充说明','Supplement statement')]],value=>{
            const references=[];
            const render=()=>{
              const choices=[[label('确认补充','Review supplement'),()=>confirm({kind:'supplement',reportId,summary:value.summary,references:[...references]},refresh,'moderation')]];
              if(references.length<8)for(const kind of ['case','evidence','proof','event','artifact'])choices.push([
                `${label('添加引用','Add reference')}: ${kind}`,()=>form('Galaxy',[['reference',kind==='artifact'?label('工件 SHA-256 摘要','Artifact SHA-256 digest'):`${kind} ID`]],input=>{
                  references.push(kind==='artifact'?{kind,sha256:input.reference.trim()}:{kind,id:input.reference.trim()});render();
                },render)]);
              if(references.length)choices.push([label('移除最后一项','Remove last reference'),()=>{references.pop();render();}]);
              menu(`${label('补充引用（最多8项，不上传工件）','References (up to 8; no artifact upload)')}\n${references.map(item=>`${item.kind}: ${plain(item.id??item.sha256)}`).join('\n')}`,choices,refresh);
            };render();
          },refresh)]);
        if(record.canCorrectEventIds?.length)entries.push([label('纠正自己的说明','Correct my statement'),()=>menu(label('选择自己的原记录','Choose your original statement'),
          record.canCorrectEventIds.map(id=>[plain(id),()=>form('Galaxy',[['summary',label('纠正后的说明','Corrected statement')],['reason',label('更改原因；不会改写处理结论','Reason; does not change the decision')]],
            value=>confirm({kind:'correct',reportId,correctsEventId:id,...value},refresh,'moderation'),refresh)]),refresh)]);
        if(record.canModerate) {
          entries.push([record.caseId?(record.paused?label('解除Case关联协作暂停','Resume Case-linked work'):label('暂停Case关联协作与衍生资格','Hold Case-linked work and eligibility')):(record.paused?label('恢复协作','Resume'):label('暂停协作','Pause')),()=>action(record.paused?'resume':'pause')]);
          if(record.state!=='resolved')entries.push([label('记录处理结论','Resolve report'),()=>action('resolve')]);
        }
        if(record.canAppeal && record.state==='resolved')entries.push([label('提出申诉','Appeal'),()=>action('appeal')]);
        if(record.canRevalidate&&!['pending','running'].includes(record.revalidation?.state))entries.push([label('重新验证此Evidence','Revalidate this Evidence'),()=>action('revalidate')]);
        if(record.canInviteVerifier)entries.push([label('邀请验证者参与','Invite a verifier'),()=>form('Galaxy',
          [['verifierId','Galaxy ID'],['scope',label('复核范围；不授予来源或Context权限','Review scope; no source or Context access is granted')],
            ['minutes',label('邀请有效分钟数（1–60，仍受授权有效期限制）','Invitation minutes (1–60, subject to Consent expiry)')],['summary',label('邀请说明','Invitation explanation')]],
          value=>{const minutes=Number(value.minutes);if(!Number.isInteger(minutes)||minutes<1||minutes>60)return message(label('请输入1至60的整数分钟数。','Enter an integer from 1 to 60.'),refresh);
            confirm({kind:'invite-verifier',reportId,verifierId:value.verifierId.trim(),scope:value.scope,summary:value.summary,expiresAt:Math.floor(Date.now()/1000)+minutes*60},refresh,'moderation');},refresh)]);
        for(const [enabled,kind,title] of [[record.canAcceptVerifier,'accept-verifier',label('接受验证者邀请','Accept verifier invitation')],
          [record.canDeclineVerifier,'decline-verifier',label('拒绝验证者邀请','Decline verifier invitation')],
          [record.canWithdrawVerifier,'withdraw-verifier',label('退出本次复核','Withdraw from this review')]])if(enabled)entries.push([title,()=>action(kind)]);
        if(record.canSubmitVerification)entries.push([label('提交复核意见','Submit verification response'),()=>menu(label('复核意见；不自动认定能力或改写Evidence','Review opinion; does not certify capability or rewrite Evidence'),
          ['supported','unsupported','inconclusive'].map(conclusion=>[conclusion,()=>form('Galaxy',[['summary',label('复核依据与限制','Review basis and limitations')]],
            value=>confirm({kind:'verification-response',reportId,conclusion,summary:value.summary,references:[]},refresh,'moderation'),refresh)]),refresh)]);
      }
      if(record.verifierParticipation?.own)entries.push([label('查看我的验证者参与范围','My verifier participation scope'),()=>message(JSON.stringify(record.verifierParticipation,null,2)+'\n'+label('本人签署的复核意见不等于独立能力认证；可拒绝、退出、补充说明和申诉。','A signed review is not independent capability certification; decline, withdrawal, statements and appeal remain available.'),refresh)]);
      entries.push([label('查看处理事件','View decisions'),()=>message(record.events.map(e=>`${plain(e.id)} · ${plain(e.kind)} · ${plain(e.summary)} · ${plain(e.verdict??e.conclusion)}\n${e.scope?`${label('复核范围','Review scope')}: ${plain(e.scope)} · ${plain(e.verifierId)}`:''}${e.correctsEventId?`${label('纠正对象','Corrects')}: ${plain(e.correctsEventId)} · ${plain(e.reason)}`:''}${e.references?`\n${label('引用（未自动核验）','References (not automatically verified)')}: ${plain(JSON.stringify(e.references))}`:''}`).join('\n'),refresh)]);
      if(record.caseId)entries.push([label('查看Case来源与报告版本','View Case source and reported version'),()=>message(record.source?JSON.stringify(record.source,null,2):label('当前无权查看完整来源；处理权限不授予来源访问。','Source unavailable; moderation authority does not grant source access.'),refresh)]);
      if(record.revalidation)entries.push([label('查看Evidence验证轮次','View Evidence verification round'),()=>message(JSON.stringify(record.revalidation,null,2),refresh)]);
      menu(`${plain(record.reportId)}\n${record.caseId?`Case: ${plain(record.caseId)}\n`:''}${plain(record.state)}\n${record.report?plain(record.report.summary):label('举报正文不可见','Report body unavailable')}\n${label('不保证响应、免费解决或交易保障','No guaranteed response, free resolution or transaction protection')}`,entries,back);
    },back);
  }
  function notifications(after) {
    void run(() => controller.queryNotifications({ limit: 8, ...(after ? { after } : {}) }), page => {
      const entries = page.items.map(item => [plain(item.title), () => {
        message(`${plain(item.eventKind)}\n${plain(item.actorId)}\n${plain(item.summary)}\n${plain(item.at)}`, () => {
          void run(() => controller.markNotificationRead(item.id), () => item.incidentId ? notifications() : item.capsuleId ? createCapsuleMenu({controller,select,prompt,info,language,isCurrent,onBack:()=>notifications(),availableScopes,readWorkContext}).openCapsule(item.capsuleId,item.versionId) : detail(item.assistanceId, () => notifications()), () => notifications());
        });
      }, `${item.read ? label('已读', 'Read') : label('未读', 'Unread')} · ${plain(item.category)}`]);
      if (page.nextAfter) entries.push([label('下一批通知', 'Next notifications'), () => notifications(page.nextAfter)]);
      menu(label('站内通知', 'Inbox') + (page.enabled ? '' : label('（已关闭）', ' (disabled)')), entries);
    });
  }
  function notificationPreferences() {
    void run(() => controller.notificationPreferences(), saved => {
      const settings = structuredClone(saved.settings);
      const render = () => menu(label('通知偏好', 'Notification preferences'), [
        ...[['enabled',label('站内通知总开关','Inbox enabled')], ['invitations',label('邀请','Invitations')],
          ['collaboration',label('协作事件','Collaboration events')], ['materials',label('材料授权','Material grants')], ['capsules',label('Capsule更新','Capsule updates')], ['incidents',label('事故通知','Incident updates')]].map(([key,title]) =>
          [title, () => { settings[key] = !settings[key]; render(); }, settings[key] ? label('开启','On') : label('关闭','Off')]),
        [label('静音指定协作','Mute collaborations'), () => form('Galaxy', [['ids',label('协作ID，逗号分隔；留空清空','Assistance IDs, comma separated; empty clears'), settings.mutedAssistanceIds.join(',')]],
          value => { settings.mutedAssistanceIds = value.ids.split(/[,，]/).map(s => s.trim()).filter(Boolean); render(); }, render)],
        [label('保存偏好','Save preferences'), () => void run(() => controller.saveNotificationPreferences({ expectedRevision: saved.revision, settings }), () => message(label('已保存通知偏好。','Preferences saved.')))],
        ...(saved.archiveSupported && controller.archiveNotifications ? [[label('归档较早通知','Archive older notifications'), () => form('Galaxy',
          [['days',label('归档多少天前的通知（1–3650）','Archive notifications older than this many days (1–3650)'), '30']], value => {
            const days=Number(value.days); if(!Number.isInteger(days)||days<1||days>3650){message(label('请输入1–3650天。','Enter 1–3650 days.'),render);return;}
            const before=Math.floor(Date.now()/1000)-days*86400;
            menu(`${label('归档时间界限','Archive cutoff')}: ${new Date(before*1000).toISOString()}\n${label('此前通知将从收件箱移除，较早的已读标记会被清理。原协作、材料与事件仍保留；此界限不能回退。','Older notifications leave the inbox and older read markers are cleared. Source collaboration, materials and events remain; the cutoff cannot move backwards.')}`,
              [[label('确认归档','Confirm archive'),()=>void run(()=>controller.archiveNotifications({expectedRevision:saved.revision,before}),
                result=>message(`${label('归档完成；清理已读标记','Archived; read markers cleared')}: ${result.removedReadMarkers}`,notificationPreferences),notificationPreferences)]],render);
          },render),saved.archivedBefore??label('尚未归档','No archive cutoff')]]:[])
      ]); render();
    });
  }
  function requesterFacts(assistanceId, after, back) {
    void run(()=>controller.queryRequesterHistoryFacts({assistanceId,limit:8,...(after?{after}:{})}),page=>{
      const refresh=()=>requesterFacts(assistanceId,after,back);
      const entries=[[label('查看请求描述与响应来源','Request description and response sources'),()=>message([
        label('工作情况','Work context')+'\n'+plain(page.description.problem),label('希望得到的协助','Requested help')+'\n'+plain(page.description.scope),...page.description.attemptedApproaches.map(plain),
        `${label('可见响应间隔（秒）','Visible response interval (seconds)')}: ${page.responseSeconds??label('无可见记录','No visible record')}`,
      ].join('\n'),refresh)],...page.facts.map(fact=>[`${eventName(fact.kind)} · ${new Date(fact.at*1000).toISOString()}`,()=>menu(`${eventName(fact.kind)}\n${plain(fact.summary)}\n${new Date(fact.at*1000).toISOString()}${fact.descriptionClarity?'\n'+clarityName(fact.descriptionClarity):''}${fact.scopeMatched===undefined?'':'\n'+label(fact.scopeMatched?'符合协作范围':'与协作范围不符',fact.scopeMatched?'Scope matched':'Scope differed')}`,
        [[label('来源详情','Source details'),()=>message(JSON.stringify(fact,null,2),refresh)],[label('继续查看','Keep reading'),refresh]],refresh)])];
      entries.push([label('来源与完整可见记录','Source and full visible record'),()=>message(JSON.stringify(page,null,2),refresh)]);
      if(page.nextAfter)entries.push([label('下一批事实','Next facts'),()=>requesterFacts(assistanceId,page.nextAfter,back)]);
      menu(`${plain(page.title)}\n${label('当前可见事实','Currently visible facts')}: ${page.visibleFactCount}\n${label('验收／取消／争议事件','Acceptance / cancellation / dispute events')}: ${page.counts.acceptances} / ${page.counts.cancellations} / ${page.counts.disputes}\n${label('重复验收仍属于同一个请求；提供者反馈是其本人评价。','Repeated acceptance belongs to the same request; provider feedback is their own assessment.')}`,entries,back);
    },back);
  }
  function requesterHistory(subjectId, after) {
    const criteria={limit:8,...(subjectId?{subjectId}:{}),...(after?{after}:{})};
    void run(() => controller.queryRequesterHistory(criteria), page => {
      const entries = page.items.map(item => [plain(item.title), () => item.factsSupported===1&&controller.queryRequesterHistoryFacts
        ? requesterFacts(item.assistanceId,undefined,()=>requesterHistory(subjectId,after)) : void run(()=>controller.queryRequesterHistory(criteria),current=>{
          const fresh=current.items.find(row=>row.assistanceId===item.assistanceId),back=()=>requesterHistory(subjectId,after);
          if(!fresh)return message(label('这份记录当前已不可读，请返回查看当前记录。','This record is no longer readable. Return to the current records.'),back);
          const body=[requestText(fresh.description??{}),...(fresh.facts??[]).map(fact=>[
            eventName(fact.kind),fact.summary?plain(fact.summary):'',fact.descriptionClarity?label('描述','Description')+'：'+clarityName(fact.descriptionClarity):'',
            fact.scopeMatched===undefined?'':label(fact.scopeMatched?'符合协作范围':'与协作范围不符',fact.scopeMatched?'Scope matched':'Scope differed')
          ].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
          const show=()=>menu(plain(fresh.title),[[label('继续查看求助经历','Continue request history'),back],
            [label('来源与完整记录','Source and full record'),()=>message(JSON.stringify(fresh,null,2),show)]],back);
          const version=generation;info(plain(fresh.title),body,()=>{if(alive()&&generation===version)show();});
        },()=>requesterHistory(subjectId,after)),plain(item.description?.scope)]);
      if (page.nextAfter) entries.push([label('下一批记录','Next records'), () => requesterHistory(subjectId, page.nextAfter)]);
      entries.push([label('查看其他身份的记录','View another identity’s records'),()=>form(label('原身份引用','Original identity reference'),[['subjectId',label('已掌握的请求者稳定身份','Known requester identity')]],value=>requesterHistory(value.subjectId),()=>requesterHistory(subjectId,after))]);
      menu(label('求助经历','Request history'), entries,more);
    });
  }
  function home() {
    menu(label('求助与协作', 'Help and collaboration'), [
      ...(controller.prepareCollaboration && has('consent') ? [[label('发起求助', 'Ask for help'), create]] : []),
      [label('我发起的求助', 'My requests'), () => listing('requested')],
      [label('我参与的协作', 'My participation'), () => listing('participating')],
      [label('找需要帮助的工作', 'Find requests'), () => listing('open')],
      ...(controller.listAssistanceDrafts && controller.listCollaborationOperations ? [[label('继续未完成内容', 'Continue saved work'), () => drafts().open()]] : []),
      ...(controller.queryNotifications && has('notifications') ? [[label('消息','Messages'), () => notifications()]] : []),
      [label('更多','More'),more],
    ], leave);
  }
  function more(){
    menu(label('更多协作功能','More collaboration options'),[
      ...(controller.listContextDrafts && controller.listContextOperations ? [[label('继续准备协作材料','Continue saved materials'), () => materials().open()]] : []),
      ...(controller.queryNotifications && has('notifications') ? [[label('通知偏好','Notification preferences'), notificationPreferences]] : []),
      ...(controller.queryRequesterHistory ? [[label('我的求助经历','My request history'), () => requesterHistory()]] : []),
      ...(controller.queryBuilders && has('builders') ? [[label('建设者登记与目录','Builder registry and directory'),()=>createBuilderMenu({controller,select,prompt,info,language,isCurrent,onBack:home,availableScopes}).open()]] : []),
      ...(controller.queryCapsules && has('capsules') ? [[label('解决方法','Methods'),()=>createCapsuleMenu({controller,select,prompt,info,language,isCurrent,onBack:home,availableScopes,readWorkContext}).open()]] : []),
      ...(controller.honorRules && has('history') ? [[label('贡献与Honor','Contribution and Honor'),()=>createHonorMenu({controller,select,prompt,info,language,isCurrent,onBack:home}).open()]] : []),
      ...(controller.qualificationPolicies ? [[label('参与条件','Participation requirements'),qualifications]] : []),
      ...(controller.queryModeration && has('moderation') ? [[label('举报处理队列','Moderation queue'),()=>moderationList()]] : []),
      [label('按原引用打开求助','Open a request by its original reference'), () => form(label('已有求助引用','Existing request reference'), [['id', label('你已掌握的原求助引用', 'Original request reference you already hold')]], value => detail(value.id,more),more)],
    ], home);
  }
  function caseModeration(source){
    const back=()=>caseModeration(source);
    if(!has('moderation')||!controller.queryModeration){message(label('需要争议处理Scope。','Moderation scope required.'),leave);return;}
    const entries=[[label('Case举报与处理记录','Case reports and decisions'),()=>moderationList({caseId:source.caseId},undefined,back)]];
    if(has('consent')&&controller.prepareModeration)entries.push([label('就此Case提出争议','Report this Case'),()=>menu(label('选择争议来源事件','Choose the source event'),
      source.events.flatMap(event=>[[`${plain(event.kind)} · ${plain(event.id)}`,()=>form(label('Case争议','Case report'),
        [['category','abuse / privacy / misrepresentation / scope / other / malicious-artifact / data-extraction / work-fraud / false-verification'],['summary',label('争议说明；仅发送给配置的处理人','Report summary; shared only with configured moderators')]],
        value=>confirm({kind:'report',caseId:source.caseId,caseVersion:source.sourceVersion,targetEventId:event.id,...value},back,'moderation'),back)],
        ...(event.kind==='result'?[[`${label('此结果的Evidence争议','Dispute Evidence for result')} · ${plain(event.id)}`,()=>form(label('Evidence争议','Evidence dispute'),
          [['evidenceId',label('关联且你有权读取的Evidence ID','Linked Evidence ID you are authorized to read')],['summary',label('需要重验的原因','Reason to revalidate')]],
          value=>confirm({kind:'report',caseId:source.caseId,caseVersion:source.sourceVersion,targetEventId:event.id,category:'false-verification',...value},back,'moderation'),back)]]:[])]),back)]);
    menu(`${label('Case独立处理','Case independent review')}\n${plain(source.caseId)} · v${plain(source.sourceVersion)}\n${label('提出争议不等于裁决；原始Case及CI签名事实保留。','A report is not a decision; source Case and signed CI facts are retained.')}`,entries,leave);
  }
  function drafts() {
    return createAssistanceDraftMenu({controller,select,prompt,info,language,isCurrent,onBack:home,readWorkContext,
      onConfirm:(input,back,retry=false)=>confirm(input,back,false,retry),onOpenRequest:id=>detail(id,()=>drafts().open())});
  }
  function materials(){
    return createContextDraftMenu({controller,select,prompt,info,language,isCurrent,onBack:home,
      onConfirm:(input,back,retry=false)=>confirm(input,back,true,retry),
      onOpenGrant:(id,owner)=>materialDetail(id,owner,()=>materials().open()),canSubmit:has('context')&&has('consent')});
  }
  return Object.freeze({ open: home, openRequest: id=>{if(alive())detail(id,leave);}, openCaseModeration:source=>{if(alive())caseModeration(source);} });
}
