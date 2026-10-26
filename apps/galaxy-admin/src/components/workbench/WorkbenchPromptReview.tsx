import type {WorkbenchAiPromptReview} from "../../lib/ai-work-accounts/ai-work-prompt";
import {aiWorkPromptSourceLabel} from "../../lib/ai-work-accounts/ai-work-prompt";

export function WorkbenchPromptReview({review}:{review:WorkbenchAiPromptReview}){
 return <section className="wb-prompt-review" aria-label="岗位工作要求完整变更">
  <dl className="wb-action-basis"><div><dt>工作岗位</dt><dd>{review.name}</dd></div><div><dt>当前来源</dt><dd>{aiWorkPromptSourceLabel(review.source)}</dd></div><div><dt>配置版本</dt><dd>当前 v{review.expectedRevision}</dd></div></dl>
  <div className="wb-prompt-versions">{([{key:'before',label:'原岗位工作要求',version:review.promptVersion},{key:'after',label:'新岗位工作要求',version:review.nextPromptVersion}] as const).map(part=><section key={part.key} className="wb-prompt-version" aria-label={part.label}><header><h4>{part.label}</h4><span>{part.key==='after'?'保存后 ':''}v{part.version} · {review[part.key].length.toLocaleString('zh-CN')} 字符</span></header><div className="wb-prompt-body" tabIndex={0} aria-label={part.label+'全文'}>{review[part.key]||<span className="wb-prompt-empty">未填写岗位工作要求。</span>}</div></section>)}</div>
  <p className="wb-prompt-effect">保存后，新轮次使用新版本；已有任务和原操作继续使用各自绑定的版本。</p>
 </section>;
}
