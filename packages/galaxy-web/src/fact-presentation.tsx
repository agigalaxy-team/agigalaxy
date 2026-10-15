import { ReadingDetails, ReadingSummary } from './reading-details';
import React from 'react';
import {memberName} from './conversation-ui';
import type {InterventionOpinionsView,ResolutionDecision} from './work-fact-presentation-types';

const resolutionNames: Record<string, string> = {
  unrecorded: '尚未记录', unresolved: '尚未解决', 'partially-resolved': '部分解决',
  resolved: '已解决（请求者记录）', inconclusive: '尚无定论', regressed: '出现回退',
};
const confirmationNames: Record<string, string> = {
  unconfirmed: '尚无其他相关方确认', confirmed: '其他相关方已确认',
  'partially-confirmed': '其他相关方部分确认', disputed: '其他相关方有异议',
};
const responseNames: Record<string, string> = { accepted: '认可这项介入', partial: '部分认可', disputed: '有异议' };
const relationshipNames: Record<string, string> = {
  self: '作者本人意见（不计作其他相关方确认）', requester: '请求者意见', participant: '其他参与者意见',
};
const supportReasons: Record<string, string> = {
  'referenced-result-superseded': '引用的结果已更正，当前解决程度需要重新确认。',
  'referenced-result-currentness-unavailable': '结果当前版本资料不完整，当前解决程度需要重新确认；不能据此判断结果已更正或工作失败。',
};

export function InterventionOpinions({ intervention, subjectId, names = {} }: { intervention: InterventionOpinionsView; subjectId?: string; names?: Record<string,string|null> }) {
  const incomplete=intervention.responseCoverage?.complete===false;
  const responses=intervention.responses??[];
  return <div className="intervention-opinions">
    {incomplete&&<p className="muted">部分回应当前无法读取。</p>}
    {!responses.length&&!incomplete&&<p className="muted">{confirmationNames[intervention.confirmation]??'暂无可读的回应'}。</p>}
    {responses.map((response, index) => <div className="work-response" key={response.id ?? index}>
      <p><strong title={response.actorId}>{memberName(response.actorId,subjectId,names[response.actorId]??undefined)}</strong> · {responseNames[response.state]??'回应'} <small>{relationshipNames[response.relationship]??'关系未标明'}</small></p>
      {response.summary&&<p className="reading-prose">{response.summary}</p>}
    </div>)}
  </div>;
}

export function ResolutionStatus({ resolution, resolutions = [] }: { resolution: ResolutionDecision|null|undefined; resolutions?: ResolutionDecision[] }) {
  if (!resolution || resolution.status==='unrecorded'&&!resolutions.length) return null;
  const needsReconfirmation = resolution.reconfirmationRequired === true || resolution.currentDecisionAvailable === false;
  const reason = needsReconfirmation ? supportReasons[resolution.currentSupport??''] ?? resolution.summary ?? '当前支持资料不足，需要重新确认。' : resolution.summary;
  return <div className="resolution-status">
    <p><strong>{needsReconfirmation ? '原结论需要重新确认' : resolutionNames[resolution.status] ?? '当前状态未提供'}</strong>{resolution.status!=='resolved'&&' · 发起者记录'}</p>
    {reason && <p>{reason}</p>}
    {!!resolution.remainingGoals?.length && <p>尚待完成：{resolution.remainingGoals.join('；')}</p>}
    {(needsReconfirmation || resolution.priorResolutionId) && <p className="muted">历史决定仍按当时范围和来源保留，不能作为当前结论。</p>}
    {!!resolutions.length && <ReadingDetails>
      <ReadingSummary>之前的结论</ReadingSummary>
      {resolutions.map((decision, index) => <article key={decision.id ?? index}>
        <p><strong>{resolutionNames[decision.status] ?? '状态未提供'}</strong>{decision.scopeVersion ? ` · 范围版本 ${decision.scopeVersion}` : ''}</p>
        {decision.summary && <p>{decision.summary}</p>}
        {!!decision.resultRefs?.length && <ReadingDetails className="source-locator"><ReadingSummary>当时采用的来源</ReadingSummary><p style={{ overflowWrap: 'anywhere' }}>{decision.resultRefs.map(ref => `${ref.id} / 版本 ${ref.version}`).join('；')}</p></ReadingDetails>}
      </article>)}
    </ReadingDetails>}
  </div>;
}
