import { randomUUID } from 'node:crypto';
import { projectDescriptionSchema } from '../../../packages/galaxy-official/src/shared/discovery-schema.mjs';

// Only edits the containing Profile draft. Publication keeps its existing exact
// Consent preview and local signature; no workspace inspection occurs here.
export function createProjectDescriptionMenu({ projects = [], onChange, select, prompt, info, language, isCurrent, onBack }) {
  const label = (cn, en) => language === 'en-US' ? en : cn;
  // oxlint-disable-next-line no-control-regex -- Prevent terminal controls in displayed user text.
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 2200);
  const brief = value => { const text = Array.from(plain(value)); return text.length > 32 ? text.slice(0, 32).join('') + '…' : text.join(''); };
  let generation = 0, values = structuredClone(projects);
  const gate = work => { const version = generation; return (...args) => { if (isCurrent() && version === generation) return work(...args); }; };
  function notice(text, back) { generation++; info('Galaxy', text, gate(back)); }
  function list(offset = 0) {
    if (!isCurrent()) return; generation++;
    const options = [], routes = {};
    const add = (title, work, description = '') => { const number = String(options.length + 1); options.push({ number, title: brief(title), description: brief(description) }); routes[number] = gate(work); };
    values.slice(offset, offset + 6).forEach(project => add(plain(project.title), () => edit(structuredClone(project), offset), plain(project.functions.join(' · '))));
    if (values.length < 10) add(label('添加项目／模块', 'Add project / module'), () => edit({ id: randomUUID(), kind: 'module', title: '', summary: '', functions: [], technologies: [], discoverable: false }, offset));
    if (offset) add(label('上一页', 'Previous page'), () => list(Math.max(0, offset - 6)));
    if (offset + 6 < values.length) add(label('下一页', 'Next page'), () => list(offset + 6));
    select({ title: label('项目／模块介绍草稿', 'Project / module description drafts') + ` · ${values.length}/10\n`
      + label('仅填写你选择的介绍；不会扫描本机。\n仍需回到自述页面预览发布；资料可见性决定谁能读取。', 'Explicit descriptions only; no local scanning.\nReturn to Profile to preview and publish; Profile visibility controls reading.'), options, routes, onBack: gate(onBack) });
  }
  function field(draft, offset, name, title, array = false) {
    generation++;
    prompt({ title, placeholder: array ? draft[name].join(', ') : draft[name] ?? '', onCancel: gate(() => edit(draft, offset)), onConfirm: gate(raw => {
      const value = array ? String(raw).split(/[,，\n]/).map(value => value.trim()).filter(Boolean) : String(raw).trim();
      const parsed = projectDescriptionSchema.shape[name].safeParse(name === 'sourceUrl' && !value ? undefined : value);
      if (!parsed.success) { notice(label('格式不正确：名称120字、简介2000字、标签最多16项／每项80字；来源使用HTTPS网址。', 'Invalid input: title120, summary2000, up to16 tags of80 characters; use an HTTPS source URL.'), () => edit(draft, offset)); return; }
      draft[name] = parsed.data; edit(draft, offset);
    }) });
  }
  function edit(draft, offset) {
    if (!isCurrent()) return; generation++;
    const existing = values.some(value => value.id === draft.id);
    select({ title: label('编辑项目介绍','Edit project description') + (draft.title?'\n'+plain(draft.title):''), options: [
      { number: '1', title: label('名称', 'Title'), description: plain(draft.title) },
      { number: '2', title: label('功能简介', 'Function summary'), description: brief(draft.summary) },
      { number: '3', title: label('功能标签', 'Function tags'), description: brief(draft.functions.join(' · ')) },
      { number: '4', title: label('技术标签', 'Technology tags'), description: brief(draft.technologies.join(' · ')) },
      { number: '5', title: label('来源网址', 'Source URL'), description: brief(draft.sourceUrl) },
      { number: '6', title: label('切换项目／模块', 'Toggle project / module'), description: draft.kind==='module'?label('模块','Module'):label('项目','Project') },
      { number: '7', title: label('允许作为发现候选', 'Allow discovery candidate'), description: draft.discoverable ? label('是；还需主体开启发现且资料可见', 'Yes; owner opt-in and visible Profile also required') : label('否；不改变已发布资料的可见性', 'No; does not hide published Profile data') },
      ...(existing ? [{ number: '8', title: label('从草稿移除此项', 'Remove from draft') }] : []),
      { number: '9', title: label('完成此项编辑', 'Apply to draft'), description: label('尚未发布', 'Not published yet') },
    ], routes: {
      1: gate(() => field(draft, offset, 'title', label('项目／模块名称', 'Project / module title'))),
      2: gate(() => field(draft, offset, 'summary', label('说明实际功能与用途', 'Describe its functions and purpose'))),
      3: gate(() => field(draft, offset, 'functions', label('功能标签，用逗号分隔，例如：全文搜索, PDF提取', 'Function tags, comma-separated, e.g. full-text search, PDF extraction'), true)),
      4: gate(() => field(draft, offset, 'technologies', label('技术标签，用逗号分隔；不参与相似度计算', 'Technology tags, comma-separated; not used for matching'), true)),
      5: gate(() => field(draft, offset, 'sourceUrl', label('来源HTTPS网址；留空移除', 'HTTPS source URL; blank removes it'))),
      6: gate(() => { draft.kind = draft.kind === 'module' ? 'project' : 'module'; edit(draft, offset); }),
      7: gate(() => { draft.discoverable = !draft.discoverable; edit(draft, offset); }),
      8: gate(() => { if (!existing) return; values = values.filter(value => value.id !== draft.id); onChange(structuredClone(values)); list(Math.min(offset, Math.max(0, Math.floor((values.length - 1) / 6) * 6))); }),
      9: gate(() => {
        const parsed = projectDescriptionSchema.safeParse(draft);
        if (!parsed.success) { notice(label('请填写名称、功能简介和至少一个功能标签。', 'Provide a title, summary and at least one function tag.'), () => edit(draft, offset)); return; }
        values = existing ? values.map(value => value.id === draft.id ? parsed.data : value) : [...values, parsed.data];
        onChange(structuredClone(values)); list(offset);
      }),
    }, onBack: gate(() => list(offset)) });
  }
  return Object.freeze({ open: () => list() });
}
