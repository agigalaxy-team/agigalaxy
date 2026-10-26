import React from 'react';
import { Button } from '@/components/ui/button';
import { ReadingDetails, ReadingSummary } from "../../../shared/reading/reading-details";
import { MemberAvatar, memberName, readableTime } from "../../../shared/people/conversation-ui";
import type { CommentView, CommentTarget, CommentReportView, CommentReportTarget, CommentKind } from "./task-comment-view-types";

export const states: Record<string, string> = {
  visible: '可见',
  'pending-review': '待人工复核',
  rejected: '未获发布通过',
  retracted: '作者已撤回',
  'governance-hidden': '暂时停止展示',
  'comment-expired': '保留期已结束',
  blocked: '已屏蔽',
  'comment-permission-unavailable': '原文授权当前不可用',
  'comment-source-erased': '原文已清理',
  received: '已接收',
  resolved: '已形成处理决定',
  appealed: '申诉处理中',
  withdrawn: '举报者已撤回',
};
export const actions: Record<string, string> = {
  create: '发布评论',
  edit: '修改评论',
  correct: '追加更正',
  retract: '撤回评论',
  report: '提交举报',
  supplement: '补充说明',
  appeal: '提出申诉',
  'withdraw-report': '撤回举报',
  pause: '暂时停止展示',
  resolve: '记录处理决定',
  resume: '解除本项临时限制',
};
export function Audience({ids,selected,onChange,names,subjectId,disabled=false}:{ids:string[];selected:string[];onChange:(value:string[])=>void;names:Record<string,string|null>;subjectId?:string;disabled?:boolean}) {
  return <fieldset className="discussion-audience" disabled={disabled}><legend>谁可以看到这份内容</legend><p>你自己始终可见；选中的人员可以读取。</p><div>{ids.map((id:string)=><label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={event=>onChange(event.target.checked?[...selected,id]:selected.filter((value:string)=>value!==id))}/><MemberAvatar subjectId={id}/><span>{memberName(id,subjectId,names[id]??undefined)}</span></label>)}</div>{!selected.length&&<small>目前仅自己可见。</small>}</fieldset>;
}

export function CommentStream({comments,subjectId,requesterId,connected,busy,person,menu,onMenuChange,begin,onReports}:{
  comments:CommentView[];subjectId?:string;requesterId:string;connected:boolean;busy:boolean;
  person:(id:string)=>string;menu:string|null;onMenuChange:(commentId:string,open:boolean)=>void;
  begin:(kind:CommentKind,comment?:CommentTarget,report?:CommentReportTarget)=>void;onReports:(commentId:string)=>void;
}) {
  return <div className="discussion-stream">{comments.map(comment=><article id={'comment-'+comment.commentId} key={comment.commentId} className={'discussion-comment'+(comment.authorId===subjectId?' own':'')}>
      <MemberAvatar subjectId={comment.authorId} own={comment.authorId===subjectId}/><div className="discussion-comment-content">
        <header><strong>{person(comment.authorId)}</strong>{comment.authorId===requesterId&&<span>发起人</span>}<time title={new Date(comment.createdAt).toLocaleString('zh-CN')}>{readableTime(comment.createdAt)}</time>{comment.state!=='visible'&&<span className="discussion-state">{states[comment.state]??'当前暂不可见'}</span>}</header>
        {comment.replyTo&&<blockquote><span>{comment.replyTo.body??'所回复的内容已变化或无法读取。'}</span></blockquote>}
        {comment.body?<p className="discussion-body">{comment.body}</p>:<p className="discussion-unavailable">{states[comment.state]??'这条评论当前无法读取。'}</p>}
        <footer>{connected&&comment.body&&<button className="text-link" disabled={busy} onClick={()=>begin('create',comment)}>回复</button>}
          <ReadingDetails className="discussion-more" open={menu===comment.commentId} onOpenChange={open=>onMenuChange(comment.commentId,open)}><ReadingSummary>评论操作与记录</ReadingSummary>
            <div className="discussion-action-list">{connected&&<>{comment.canEdit&&<button disabled={busy} onClick={()=>begin('edit',comment)}>修改评论</button>}{comment.canCorrect&&<button disabled={busy} onClick={()=>begin('correct',comment)}>追加更正</button>}{comment.canRetract&&<button disabled={busy} onClick={()=>begin('retract',comment)}>撤回评论</button>}{(comment.body||comment.authorId===subjectId)&&<button disabled={busy} onClick={()=>begin('report',comment)}>{comment.authorId===subjectId?'请求复核':'举报'}</button>}<button disabled={busy} onClick={()=>onReports(comment.commentId)}>查看相关处理</button></>}
              <ReadingDetails><ReadingSummary>记录信息</ReadingSummary><dl><dt>版本</dt><dd>{comment.revision}</dd><dt>保留期限</dt><dd>{new Date(comment.expiresAt).toLocaleString('zh-CN')}</dd><dt>作者标识</dt><dd><code>{comment.authorId}</code></dd></dl>{!!comment.rule?.reasons?.length&&<p>复核提示：{comment.rule.reasons.map((value:string)=>({duplicate:'近期内容重复',advertising:'可能含无关推广','repeated-links':'多处出现相同链接','many-mentions':'提及较多人'} as Record<string,string>)[value]??value).join('、')}。</p>}</ReadingDetails>
            </div>
          </ReadingDetails>
        </footer>
      </div>
    </article>)}</div>;
}
export function CommentReports({reports,busy,person,begin,onReadAndBegin}:{
  reports:CommentReportView[];busy:boolean;person:(id:string)=>string;
  begin:(kind:CommentKind,comment?:CommentTarget,report?:CommentReportTarget)=>void;
  onReadAndBegin:(kind:'supplement'|'appeal',reportId:string)=>void;
}) {
  return <>{reports.map(report=><article key={report.reportId} className="discussion-report">
        <header><strong>{states[report.state]??'评论处理'}</strong>{report.pauseUntil&&<span>暂停展示至 {readableTime(report.pauseUntil)}</span>}</header>
        {report.source?.body&&<blockquote>{report.source.body}</blockquote>}
        {!report.events.length&&<p className="muted">相关说明当前没有向你开放。</p>}
        {report.events.map((event)=><div className="discussion-report-event" key={event.eventId}><MemberAvatar subjectId={event.authorId}/><div><p><strong>{person(event.authorId)}</strong><span>{actions[event.kind??'report']}</span></p><p className="reading-prose">{event.summary}</p></div></div>)}
        <div className="discussion-report-actions">{report.canSupplement&&<button className="text-link" disabled={busy} onClick={()=>onReadAndBegin('supplement',report.reportId)}>补充说明</button>}{report.canAppeal&&<button className="text-link" disabled={busy} onClick={()=>onReadAndBegin('appeal',report.reportId)}>提出申诉</button>}
          <ReadingDetails mode="inline"><ReadingSummary>更多处理</ReadingSummary><div className="button-row">{report.canWithdrawReport&&<Button variant="ghost" disabled={busy} onClick={()=>begin('withdraw-report',undefined,report)}>撤回举报</Button>}{report.canModerate&&<>{report.canReviewSource&&<Button variant="outline" disabled={busy} onClick={()=>begin('pause',undefined,report)}>暂时停止展示</Button>}{!['resolved','withdrawn'].includes(report.state)&&<Button variant="outline" disabled={busy} onClick={()=>begin('resolve',undefined,report)}>作出处理决定</Button>}{report.pauseUntil&&<Button variant="outline" disabled={busy} onClick={()=>begin('resume',undefined,report)}>解除本项暂停</Button>}</>}</div><p className="muted">评论版本 {report.target.revision} · 处理版本 {report.version}</p></ReadingDetails>
        </div>
      </article>)}</>;
}
