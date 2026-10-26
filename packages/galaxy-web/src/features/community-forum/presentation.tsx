import React from 'react';
import { forumBodyBlocks, forumBodyParagraphs, forumLinkLabel } from "./community-forum-browse.mjs";
import { forumTopics } from "../../../../galaxy-official/src/shared/community-forum-topics-v1.mjs";
import { ForumAudienceSummary } from "./forum-audience";
import { forumPreviewProjection, type ForumKind, type ForumPayload, type ForumPreviewPayload, type ForumPermission } from "./community-forum-view-types";

export const labels: Record<string, string> = { 'create-post': '写一条帖子', 'publish-version': '发表下一版', 'create-reply': '写回复',
  'withdraw-post': '撤回整条帖子', 'withdraw-version': '撤回这一版', 'withdraw-reply': '撤回我的回复', 'create-report': '私有举报',
  supplement: '补充我的举报', 'withdraw-report': '撤回我的举报', appeal: '提交申诉', resolve: '记录处理决定', 'create-section':'创建讨论版块','update-section':'维护讨论版块' };
export const resolutionLabels:Record<string,string>={dismissed:'不成立',accepted:'成立','needs-review':'需要进一步核对'};
export const categories = [['spam', '垃圾信息'], ['harassment', '骚扰'], ['privacy', '隐私'], ['misleading', '误导'], ['other', '其他']];
export const states: Record<string, string> = { expired: '此内容的读取许可已到期。', withdrawn: '此内容已撤回。', unavailable: '此内容当前不可读。' };
export const reasons: Record<string, string> = { 'content-expired': '公开许可到期', 'consent-revoked': '原许可已主动撤销',
  'binding-explicitly-revoked': '发表时连接被主动撤销', 'source-device-revoked': '发表设备已撤销', 'deletion-pending': '资料正在退出',
  'governance-hidden': '内容处于有限处理期限', 'historical-cause-unavailable': '原许可原因需要核对' };
export const date = (seconds: number) => new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
export const publicWrite = (kind: string) => ['create-post', 'publish-version', 'create-reply'].includes(kind);
export const sectionWrite=(kind:string)=>kind==='create-section'||kind==='update-section';
export function Body({body,code=false}:{body:string;code?:boolean}) {
  if(!code)return <div className="forum-prose">{forumBodyParagraphs(body).map((paragraph:string,index:number)=><p key={index}>{paragraph}</p>)}</div>;
  return <div className="forum-prose forum-prose--content">{forumBodyBlocks(body).map((block,index)=>block.kind==='code'
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Scrollable code must remain reachable by keyboard.
    ? <pre key={index} tabIndex={0} aria-label={block.language?block.language+' 代码':'代码'}><code data-language={block.language??undefined}>{block.text}</code></pre>
    : <p key={index}>{block.text}</p>)}</div>;
}

export function Links({ links = [], titled = false }: { links?: string[]; titled?:boolean }) {
  const rows=links.map(forumLinkLabel).filter((value):value is NonNullable<typeof value>=>value!==null);
  if(!rows.length)return null;
  const list=<ul className="forum-links">{rows.map((value,index)=><li key={index}><a href={value.href} title={value.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><span className="forum-link-text"><strong>{value.host}</strong>{value.detail&&<span>{value.detail}</span>}</span></a></li>)}</ul>;
  return titled?<section className="forum-related" aria-label="相关链接"><h2>相关链接</h2>{list}</section>:list;
}

export type ForumFocusTarget='topic'|'results'|'tabs';
export function ForumLink({target,children,className,active=false,focusTarget,navigate}:{target:string;children:React.ReactNode;className?:string;active?:boolean;focusTarget?:ForumFocusTarget;navigate:(path:string,focus?:ForumFocusTarget)=>void}) {
  return <a className={className} href={target} aria-current={active?'page':undefined} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(target,focusTarget);}}}>{children}</a>;
}
export function PostTime({createdAt,updatedAt}:{createdAt?:number;updatedAt?:number}) {
  const published=typeof createdAt==='number'&&Number.isFinite(createdAt)?new Date(createdAt*1000):null;
  const updated=typeof updatedAt==='number'&&Number.isFinite(updatedAt)&&updatedAt!==(createdAt??updatedAt)?new Date(updatedAt*1000):null;
  const display=(value:Date)=>value.toLocaleDateString('zh-CN',{year:'numeric',month:'numeric',day:'numeric'});
  return <>{published&&<time dateTime={published.toISOString()} title={'发表于 '+date(createdAt!)}>{display(published)}</time>}{updated&&<time dateTime={updated.toISOString()} title={'作者更新于 '+date(updatedAt!)}>更新于 {display(updated)}</time>}</>;
}

export function PreviewBody({ value }: { value: {kind:ForumKind;payload:ForumPayload|ForumPreviewPayload} }) {
  const payload = forumPreviewProjection(value.payload);
  return <><h3>{labels[value.kind]}</h3>{payload.title && <h4>{payload.title}</h4>}
    {payload.topic&&<p className="forum-topic-label">发布到 {forumTopics.find(topic=>topic.id===payload.topic)?.label}</p>}
    {(payload.body || payload.summary || payload.reason) && <Body body={payload.body ?? payload.summary ?? payload.reason ?? ''}/>}
    <Links links={payload.links} />
    {payload.theme&&<p>主题：{payload.theme}</p>}{payload.description&&<Body body={payload.description}/>}<ForumAudienceSummary value={payload.audience}/>
    {sectionWrite(value.kind)&&<p>{payload.state==='archived'?'版块归档后停止接收新帖子，已有内容按各自许可保留。':'版块由本次操作的账户维护，全站分类由运营整理。'}</p>}
    {payload.publishedUntil && <p>读取许可至 <strong>{date(payload.publishedUntil)}</strong>。到期不会自动续期。</p>}
    {value.kind === 'withdraw-post' && <p>这会停止整条帖子各版的公开读取及新回复；别人已经发表的独立回复按各自许可继续。立即停读与实际清理分别记录。</p>}
    {value.kind === 'withdraw-version' && <p>这会停止所选版本的公开读取及新回复。已有独立回复不会因此被删除，也不会带出已撤回正文。</p>}
    {value.kind === 'withdraw-reply' && <p>这会停止这一条回复的公开读取，不改变其他人的独立内容。</p>}
    {value.kind === 'withdraw-report' && <p>撤回自己的举报，不代替已经发生的处理决定或他人的申诉。</p>}
    {value.kind === 'resolve' && <p>处理结果：{resolutionLabels[payload.resolution??'']}。{payload.effect ? `暂时停止目标内容读取，最迟到 ${date(payload.effect.until)}。` : '本次不新增停止读取期限。'}</p>}
    {!publicWrite(value.kind) && !sectionWrite(value.kind) && !value.kind.startsWith('withdraw-') && <p className="muted">这是当前获准人员可见的私有记录，不公开举报者文字，也不自动恢复任何内容。</p>}
  </>;
}

export function PermissionDetail({ value }: { value: ForumPermission|null }) {
  return value ? <div className="message"><p>可读至 {date(value.publishedUntil)}。</p>{typeof value.originBindingExpiresAt==='number'?<p>发表时连接到期：{date(value.originBindingExpiresAt)}。自然到期不自动缩短这份内容许可。</p>:<p>这份内容由官网账户发表，许可与账户当前登录状态分别处理。</p>}{value.stoppedReasons?.length ? <p>本次核对的停止原因：{value.stoppedReasons.map((reason: string) => reasons[reason] ?? '需要核对原许可').join('、')}。</p> : <p>本次核对未发现停止原因；后续读取仍按当时实际状态判断。</p>}{typeof value.originBindingExpiresAt==='number'&&<p>撤销原连接或设备可能停止它签署的内容。恢复控制权不会恢复另一台设备的本机稿。</p>}</div> : null;
}
