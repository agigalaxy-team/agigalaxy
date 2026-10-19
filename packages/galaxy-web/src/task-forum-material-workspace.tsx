import {ReadingDetails,ReadingSummary} from './reading-details';
import React, { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { hasMaterialText, literalTaskText, localTaskTextView } from './task-material-client.mjs';
import { localDateTime } from './task-bounty-client.mjs';
import type {PublishDraft} from './task-entry-types';
import {availableForumContent,type ForumPostView} from './community-forum-view-types';
import type {TaskText,TaskTextField,TaskMaterialInput,TaskMaterialOptions,TaskMaterialStates} from './task-material-types';

type Props = { source: ForumPostView; sourceState: string; draft: PublishDraft; states: TaskMaterialStates; busy: boolean;
  onAdopt: (input: TaskMaterialInput, options: TaskMaterialOptions, assertSelectionCurrent: () => void) => void; onCancel: () => void; onRefresh: () => void };
const date = (value: number) => new Date(value * 1000).toLocaleString();
const present = (value: TaskText) => hasMaterialText(value) || !!literalTaskText(value).trim();
const error = () => Object.assign(new Error('带入材料期间内容或范围已变化，请重新选择；原稿仍保留。'), { code: 'task_material_selection_changed' });

export function TaskForumMaterialWorkspace({ source, sourceState, draft, states, busy, onAdopt, onCancel, onRefresh }: Props) {
  const revision = useRef(0), alive = useRef(true), initialSource = useRef(source), fieldId=useId();
  const [useTitle, setUseTitle] = useState(!present(draft.title)), [useBody, setUseBody] = useState(true);
  const [summaryMode, setSummaryMode] = useState<'append'|'replace'>(present(draft.summary) ? 'append' : 'replace');
  const [titleRange, setTitleRange] = useState({ start: 0, end: Array.from(source?.payload?.title ?? '').length });
  const [bodyRange, setBodyRange] = useState({ start: 0, end: Array.from(source?.payload?.body ?? '').length });
  const [title, setTitle] = useState(source?.payload?.title ?? ''), [body, setBody] = useState(source?.payload?.body ?? '');
  const [declared, setDeclared] = useState(false), [visibility, setVisibility] = useState(draft.visibility);
  const [expiresAt, setExpiresAt] = useState(() => Math.min(source?.publishedUntil ?? 0, Math.floor(Date.now() / 1000) + 2591900));
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const ids = useRef({ title: crypto.randomUUID(), body: crypto.randomUUID() });
  const populate=useEffectEvent(()=>{if(source.payload&&!initialSource.current.payload){initialSource.current=source;revision.current++;setTitle(source.payload.title);setBody(source.payload.body);setTitleRange({start:0,end:Array.from(source.payload.title).length});setBodyRange({start:0,end:Array.from(source.payload.body).length});setExpiresAt(Math.min(source.publishedUntil??0,Math.floor(Date.now()/1000)+2591900));}});
  useEffect(()=>{populate();},[source]);
  const available = sourceState === 'available' && availableForumContent(source,clock);
  const erase=useEffectEvent(()=>{initialSource.current={...source,payload:undefined};revision.current++;setTitle('');setBody('');setDeclared(false);});
  const updateClock=useEffectEvent(()=>{const time=Math.floor(Date.now()/1000);setClock(time);if(source.availability==='withdrawn'||source.availability==='expired'||(source.publishedUntil??Infinity)<=time)erase();});
  useEffect(() => { const lifetime=alive,edits=revision;lifetime.current = true; const timer = window.setInterval(() => updateClock(), 1000);
    return () => { lifetime.current = false; edits.current++; window.clearInterval(timer); }; }, []);
  function edit(action: () => void) { if (busy) return; revision.current++; action(); }
  function range(field: 'title' | 'body', node: HTMLTextAreaElement) {
    if (busy || !available || !source.payload || node.selectionStart === node.selectionEnd) return;
    const raw = source.payload[field], start = Array.from(raw.slice(0, node.selectionStart)).length, end = Array.from(raw.slice(0, node.selectionEnd)).length;
    edit(() => { const selected = Array.from(raw).slice(start, end).join('');
      if (field === 'title') { setTitleRange({ start, end }); setTitle(selected); setUseTitle(true); }
      else { setBodyRange({ start, end }); setBody(selected); setUseBody(true); }
    });
  }
  const titleValid = !useTitle || title.trim().length > 0 && title.length <= 120 && titleRange.end > titleRange.start;
  const bodyValid = !useBody || body.trim().length > 0 && body.length <= 10000 && bodyRange.end > bodyRange.start;
  const untilValid = expiresAt > clock && expiresAt <= (source?.publishedUntil ?? 0);
  function adopt() {
    if (busy || !available || !declared || !titleValid || !bodyValid || !untilValid || !useTitle && !useBody) return;
    const expectedRevision = revision.current, versionId = source.locator.versionId, postId = source.locator.postId;
    if(!versionId)return;
    const assertCurrent = () => {
      if (!alive.current || revision.current !== expectedRevision || initialSource.current?.locator?.versionId !== versionId
        || expiresAt <= Math.floor(Date.now() / 1000)) throw error();
    };
    const selections:TaskMaterialInput['selections'] = [
      ...(useTitle ? [{ materialId: ids.current.title, field: 'title' as const, ...titleRange, text: title }] : []),
      ...(useBody ? [{ materialId: ids.current.body, field: 'body' as const, ...bodyRange, text: body }] : []),
    ];
    onAdopt({ source: { postId, versionId }, selections, expiresAt },
      { useTitle, useBody, summaryMode, visibility, titleId: ids.current.title, bodyId: ids.current.body }, assertCurrent);
  }
  const previousTitle = localTaskTextView(draft.title, draft.materialBodies, states).text;
  const previousSummary = localTaskTextView(draft.summary, draft.materialBodies, states).text;
  return <section className="task-material-selection" aria-label="选择本人帖子材料" aria-busy={busy}>
    <header><p className="eyebrow">从社区讨论继续</p><h2>把这段内容带入求助</h2><p>选择要使用的文字，带入后可以继续编辑。</p></header>

    {!available ? <div className="message"><p>{sourceState === 'reading' ? '正在重新核对准确来源。' : '这版材料当前不能核对，已隐藏来源文字。原任务稿保持原样。'}</p>
      <Button type="button" variant="outline" disabled={busy} onClick={onRefresh}>重新核对这版材料</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>返回自己的草稿</Button></div> : <>
      <p className="muted">当前选择：第 {source.locator.versionNumber ?? '指定'} 版。原材料许可至 {date(source.publishedUntil??0)}。</p>
      {present(draft.title) || present(draft.summary) ? <ReadingDetails><ReadingSummary>查看已有原稿</ReadingSummary>
        <h3>{previousTitle || '原稿标题含当前不可用材料'}</h3><p className="forum-prose">{previousSummary || '尚无独立说明'}</p>
        <p className="muted">追加保留原说明；明确替换时，原字段只作为本机恢复项保留。</p></ReadingDetails> : <p className="message">可以直接使用下面的标题和说明。</p>}
      <fieldset disabled={busy}>
        <legend>选择要带入的文字</legend>
        <label><input type="checkbox" checked={useTitle} onChange={event => edit(() => setUseTitle(event.target.checked))}/>使用这版标题{present(draft.title) ? '（替换原稿标题）' : ''}</label>
        {useTitle && <label htmlFor={fieldId+'-title'}>求助标题<Input id={fieldId+'-title'} aria-label="求助标题" value={title} maxLength={120} onChange={event => edit(() => setTitle(event.target.value))}/>
          <small>这部分仍来自所选标题，修改文字也会保留来源约束。</small></label>}
        {!titleValid && <p role="alert">标题最多120字，请缩小原文选区或编辑上面的标题材料。</p>}
        <label><input type="checkbox" checked={useBody} onChange={event => edit(() => setUseBody(event.target.checked))}/>使用这版说明</label>
        {useBody && <>
          {present(draft.summary) && <label>如何带入说明<select value={summaryMode} onChange={event => edit(() => setSummaryMode(event.target.value==='replace'?'replace':'append'))}>
            <option value="append">追加材料段，保留原有说明</option><option value="replace">用材料替换说明，原值留作本机恢复</option></select></label>}
          <label htmlFor={fieldId+'-body'}>求助说明<Textarea id={fieldId+'-body'} aria-label="求助说明" value={body} maxLength={10000} onChange={event => edit(() => setBody(event.target.value))}/>
            <small>可以直接使用或编辑。这一材料段与原有独立说明分开保存。</small></label>
        </>}
        {!bodyValid && <p role="alert">说明材料最多10000字，请缩小原文选区或编辑上面的材料。</p>}
        <ReadingDetails mode="inline"><ReadingSummary>从准确原文缩小选区</ReadingSummary><p>在下列原文中选中文字，选区会直接更新对应的材料；不需要复制粘贴。</p>
          <label htmlFor={fieldId+'-source-title'}>原文标题<Textarea id={fieldId+'-source-title'} aria-label="原文标题" readOnly value={source.payload?.title??''} onSelect={event => range('title', event.currentTarget)}/></label>
          <label htmlFor={fieldId+'-source-body'}>原文正文<Textarea id={fieldId+'-source-body'} aria-label="原文正文" readOnly value={source.payload?.body??''} onSelect={event => range('body', event.currentTarget)}/></label>
        </ReadingDetails>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>这次材料的使用范围</legend>
        <label>谁可以看到<select value={visibility} onChange={event => edit(() => setVisibility(event.target.value))}>
          <option value="Public">公开求助</option><option value="Private">仅自己</option></select></label>
        <p>本次材料使用至 {date(expiresAt)}。到期或原材料撤回后，相应文字停止展示，独立说明继续保留。</p>
        <ReadingDetails mode="inline"><ReadingSummary>缩短材料使用期限</ReadingSummary><label htmlFor={fieldId+'-expires'}>材料使用截止<Input id={fieldId+'-expires'} type="datetime-local" value={Number.isFinite(expiresAt)?localDateTime(expiresAt):''}
          max={localDateTime(source.publishedUntil??0)} onChange={event => edit(() => setExpiresAt(Math.floor(Date.parse(event.target.value) / 1000)))}/></label></ReadingDetails>
        {!untilValid && <p role="alert">使用期限须在当前时间之后，且不晚于原材料许可。</p>}
        <label><input type="checkbox" checked={declared} onChange={event => edit(() => setDeclared(event.target.checked))}/>
          选中的内容是我可用于这份任务的材料；我已排除无权再发布的第三方内容。</label>
      </fieldset>
      <div className="button-row"><Button type="button" disabled={busy || !declared || !titleValid || !bodyValid || !untilValid || !useTitle && !useBody} onClick={adopt}>带入求助草稿</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>返回自己的草稿</Button></div>
      <p className="muted">带入后仍是你的草稿，由你点击发布。</p>
    </>}
  </section>;
}

type MaterialFieldProps = { field: TaskTextField; label: string; value: TaskText; draft: PublishDraft; states: TaskMaterialStates; clock: number; busy: boolean;
  onEdit: (materialId: string, text: string) => void; onRemove: (field: TaskTextField, materialId: string) => void; onRestore: (field: TaskTextField) => void;
  navigate: (path: string) => void };
export function TaskMaterialDraftField({ field, label, value, draft, states, clock, busy, onEdit, onRemove, onRestore, navigate }: MaterialFieldProps) {
  const segments = typeof value!=='string'&&value.format === 'task-text-v1' ? value.segments.filter(segment => segment.kind === 'material') : [];
  const maximum = field === 'title' ? 120 : field === 'expectedOutcome' ? 1500 : 10000;
  return <>{segments.map(segment => {
    const material = (draft.materials ?? []).find(item => item.materialId === segment.materialId);
    const body = (draft.materialBodies ?? []).find(item => item.materialId === segment.materialId), state = states?.[segment.materialId];
    const visible = state?.status === 'available' && (state.availableUntil??0) > clock && typeof body?.text === 'string';
    const path = material ? '/app/community/posts/' + material.source.postId + '/versions/' + material.source.versionId : null;
    return <div className="message task-material-part" key={segment.materialId}>
      <h3>{label} · 来源材料段</h3>
      {visible ? <label htmlFor={field+'-'+segment.materialId}>编辑这段{label}材料{field === 'title'
        ? <Input id={field+'-'+segment.materialId} disabled={busy} value={body?.text??''} maxLength={maximum} onChange={event => onEdit(segment.materialId, event.target.value)}/>
        : <Textarea aria-label={'编辑这段'+label+'材料'} id={field+'-'+segment.materialId} disabled={busy} value={body?.text??''} maxLength={maximum} onChange={event => onEdit(segment.materialId, event.target.value)}/>}</label>
        : <output>这段材料当前不可用或仍待核对，文字已隐藏。独立内容可以继续编辑。</output>}
      <p className="muted">编辑后的文字继续受原材料限制。{material && '材料使用至 ' + date(material.expiresAt) + '。'}</p>
      <div className="button-row">{path && <Button type="button" variant="link" disabled={busy} onClick={() => navigate(path)}>查看准确来源版本</Button>}
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onRemove(field, segment.materialId)}>移除这一材料段</Button></div>
    </div>;
  })}
    {Object.hasOwn(draft.materialRestore ?? {}, field) && present(draft.materialRestore[field]) && <Button type="button" variant="ghost" disabled={busy} onClick={() => onRestore(field)}>恢复替换前的{label}（仅本机原稿）</Button>}
  </>;
}
