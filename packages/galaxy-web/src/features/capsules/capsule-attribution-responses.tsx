import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React from 'react';
import { Button } from '@/components/ui/button';
import { MemberAvatar, memberName } from "../../shared/people/conversation-ui";
import './capsule-source-reading.css';

type Source = { kind: string; id: string; version: number; caseId?: string };
type ContributionResponse = {
  eventId: string;
  actorId: string;
  relationship: 'requester' | 'self' | 'participant';
  state: 'accepted' | 'partial' | 'disputed';
  interventionRef: { id: string; version: number };
};
type ContributionResponses = {
  status: 'current' | 'source-version-superseded' | 'source-currentness-unavailable' | 'source-not-readable' | 'not-an-intervention';
  source?: Source;
  taskId?: string;
  confirmation: 'confirmed' | 'partially-confirmed' | 'disputed' | 'unconfirmed' | null;
  responses: ContributionResponse[];
};
type Attribution = { subjectId: string; source: Source; contributionResponses?: ContributionResponses | string };
const confirmationText = {
  confirmed: '当前可读的他人回应确认了这项协助。',
  'partially-confirmed': '当前可读的他人回应仅部分确认这项协助。',
  disputed: '当前可读的他人回应对这项协助提出了异议。',
  unconfirmed: '当前没有可读的他人确认。',
};
const relationshipText = { requester: '请求者', self: '记录本人', participant: '参与者' };
const historicalConfirmationText = {
  confirmed: '可读的历史回应确认了所引用的这一版。',
  'partially-confirmed': '可读的历史回应仅部分确认了所引用的这一版。',
  disputed: '可读的历史回应对所引用的这一版提出了异议。',
  unconfirmed: '所引用的这一版当前没有可读的他人确认。',
};
const responseText = { accepted: '确认这项协助', partial: '部分确认', disputed: '提出异议' };
const sourceText: Record<string, string> = { intervention: '协助记录', attempt: '尝试记录', result: '工作结果', verification: '验证记录', configuration: '工作配置', 'room-message': '交流内容', 'selected-message': '交流内容' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function CapsuleAttributionResponses({ attributions = [], navigate, subjectId, names = {} }: {
  attributions?: Attribution[];
  navigate?: (path: string) => void;
  subjectId?: string;
  names?: Record<string, string | null>;
}) {
  if (!attributions.length) return null;
  const person = (id: string) => memberName(id, subjectId, names[id] ?? undefined);
  return (
    <section className="method-source-authors" aria-label="来源作者与工作回应">
      <h3>来源作者与工作回应</h3>
      <p className="source-reading-note">以下是作者选定的来源，以及你当前可读的原工作回应。来源归属和工作回应不等同于这份方法的共同署名。</p>
      {attributions.map((attribution, index) => {
        const value = attribution.contributionResponses;
        const state = value && typeof value === 'object' ? value : null;
        const readable = attribution.source.kind === 'intervention' && state && ['current', 'source-version-superseded', 'source-currentness-unavailable'].includes(state.status)
          && state.source?.kind === 'intervention'
          && state.source.id === attribution.source.id
          && state.source.version === attribution.source.version;
        const responses = readable ? state.responses.filter(response =>
          response.interventionRef.id === attribution.source.id && response.interventionRef.version === attribution.source.version) : [];
        return (
          <article className="method-source-author" key={`${attribution.subjectId}:${attribution.source.kind}:${attribution.source.id}:${attribution.source.version}:${index}`}>
            <header className="member-line"><MemberAvatar subjectId={attribution.subjectId}/><div><h4>{person(attribution.subjectId)}</h4><p className="record-meta">{sourceText[attribution.source.kind] ?? '来源记录'} · 第 {attribution.source.version} 版</p></div></header>
            {attribution.source.kind === 'intervention' && !state && <p className="source-reading-note">原工作回应暂时无法读取。</p>}
            {state?.status === 'source-not-readable' && <p className="source-reading-note">原工作或读取许可当前不可用，回应已收起。无法据此判断其他人的意见。</p>}
            {state && !readable && !['source-not-readable', 'not-an-intervention'].includes(state.status) && <p className="source-reading-note">目前无法核对这一版来源的回应。</p>}
            {readable && <>
              {state.status === 'source-version-superseded' && <p className="source-reading-note">原记录已有新版。这里保留对第 {attribution.source.version} 版的回应。</p>}
              {state.status === 'source-currentness-unavailable' && <p className="source-reading-note">原记录的最新版本暂时无法核对。以下只说明所引用的第 {attribution.source.version} 版。</p>}
              <p className="source-response-summary">{state.confirmation ? (state.status === 'current' ? confirmationText : historicalConfirmationText)[state.confirmation] : '当前没有可解释的回应状态。'}</p>
              {responses.length > 0 && <ul className="source-response-list">{responses.map(response => <li key={response.eventId}>
                <span><strong>{person(response.actorId)}</strong><small>{relationshipText[response.relationship]}</small></span><span>{responseText[response.state]}</span>
              </li>)}</ul>}
              {navigate && state.taskId && uuid.test(state.taskId) && <Button type="button" variant="link" onClick={() => navigate(`/app/tasks/${state.taskId}?section=collaboration#original-help`)}>查看原工作与回应 </Button>}
            </>}
            <ReadingDetails className="source-reference-details"><ReadingSummary>准确来源与回应记录</ReadingSummary><dl><dt>来源作者</dt><dd>{attribution.subjectId}</dd><dt>来源</dt><dd>{attribution.source.kind} · {attribution.source.id} · 第 {attribution.source.version} 版</dd></dl>
              {readable && <><p>仅展示当前获准读取的各回应者最新记录；未读到的意见不会推断或补回。</p>{responses.map(response => <dl key={response.eventId}><dt>{person(response.actorId)}的回应</dt><dd>{response.eventId}</dd><dt>回应者</dt><dd>{response.actorId}</dd><dt>对应协助</dt><dd>{response.interventionRef.id} · 第 {response.interventionRef.version} 版</dd></dl>)}</>}
            </ReadingDetails>
          </article>
        );
      })}
    </section>
  );
}
