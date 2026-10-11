import { discoveryPreferencesSchema, functionTagsSchema } from '../../../packages/galaxy-official/src/shared/discovery-schema.mjs';
import { createProfileMenu } from './profile-menu.mjs';
import {createNativeProjectDiscoveryMenu} from './project-contact-menu.mjs';

export function createProjectDiscoveryMenu({ controller=null, nativeCall=null, select, prompt, info, language, isCurrent, onBack, onReturnWork=onBack, onOpenRoom=null, openLink=null, readWorkContext=null, now = () => Math.floor(Date.now() / 1000) }) {
  if(nativeCall)return createNativeProjectDiscoveryMenu({call:nativeCall,select,prompt,info,language,isCurrent,onBack,onReturnWork,onOpenRoom,openLink,readWorkContext,now});
  const label = (cn, en) => language === 'en-US' ? en : cn;
  // oxlint-disable-next-line no-control-regex -- Prevent terminal controls in displayed user text.
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 2400);
  const brief = (value, max = 18) => { const text = Array.from(plain(value)); return text.length > max ? text.slice(0, max).join('') + '…' : text.join(''); };
  const purposes = { conversation: label('交流', 'Conversation'), reuse: label('模块复用', 'Reuse'), collaboration: label('协作', 'Collaboration'), recruitment: label('招募', 'Recruitment') };
  const join = values => values.map(plain).join(' · ') || label('无', 'None');
  const time = value => value && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : label('未设置', 'Not set');
  let generation = 0, status, projects = [];
  const gate = work => { const version = generation; return (...args) => { if (isCurrent() && version === generation) return work(...args); }; };
  const leave = () => { generation++; controller.cancel(); onBack(); };
  function menu(title, entries, back = home) {
    if (!isCurrent()) return; generation++;
    const routes = {}, options = entries.map(([title, work, description = ''], index) => {
      const number = String(index + 1); routes[number] = gate(work); return { number, title, description: brief(description, 32) };
    });
    select({ title, options, routes, onBack: gate(back) });
  }
  function notice(text, back = home) { if (!isCurrent()) return; generation++; info('Galaxy', text, gate(back)); }
  function ask(title, placeholder, done, back) {
    generation++; prompt({ title, placeholder, onConfirm: gate(done), onCancel: gate(back) });
  }
  async function run(work, done, back = home) {
    const version = ++generation;
    info('Galaxy', label('正在处理；返回可取消。', 'Working; go back to cancel.'), gate(() => { generation++; controller.cancel(); back(); }));
    try { const result = await work(); if (isCurrent() && version === generation) done(result); }
    catch (error) { if (isCurrent() && version === generation) notice(plain(error.message) + '\n' + label('请重新读取核对；不会自动重发。', 'Reload to check; no automatic resend.'), back); }
  }
  function home() {
    if (!isCurrent()) return;
    void run(async () => {
      status = await controller.status();
      if (status.state !== 'session-local' || !status.scopes?.includes('history')) throw new Error('Project discovery requires a history session.');
      return controller.queryHistory({ subjectId: status.subjectId, limit: 1 });
    }, profile => {
      projects = profile.selfDeclared?.projects ?? [];
      menu(label('项目／模块机会', 'Project / module opportunities') + '\n' + label('按功能寻找相关的人；单纯交流也可以。', 'Find people by shared functions; conversation is enough.'), [
        [label('选择项目并发现机会', 'Choose a project and find opportunities'), () => chooseProject(), `${projects.length} ` + label('项已发布介绍', 'published descriptions')],
        ...(controller.projectDiscoveryPreferences && status.scopes.includes('notifications') ? [[label('接触意愿', 'Contact wishes'), preferences]] : []),
        [label('我的资料与项目介绍', 'My Profile and project descriptions'), () => {
          const current = ++generation;
          createProfileMenu({ controller, select, prompt, info, language, isCurrent: () => isCurrent() && current === generation, onBack: home }).open();
        }],
      ], leave);
    }, leave);
  }
  function chooseProject(offset = 0) {
    const entries = projects.slice(offset, offset + 6).map(project => [brief(project.title, 32), () => query(project), join(project.functions)]);
    if (offset) entries.push([label('上一页', 'Previous page'), () => chooseProject(offset - 6)]);
    if (offset + 6 < projects.length) entries.push([label('下一页', 'Next page'), () => chooseProject(offset + 6)]);
    menu(projects.length ? label('选择自己的项目／模块', 'Choose your project / module') : label('请先在“我的资料”中填写并发布项目介绍。', 'First publish a project description in My Profile.'), entries);
  }
  function query(project,offset=0) {
    void run(() => controller.queryProjectDiscovery({ projectId: project.id, limit: 20 }), page => cards(project, page,Math.min(offset,Math.max(0,Math.floor((page.items.length-1)/6)*6))), () => chooseProject());
  }
  function cards(project, page, offset = 0) {
    const entries = page.items.slice(offset, offset + 6).map(card => [brief(card.project.title, 32), () => cardView(project, page, card, offset), join(card.match.sharedFunctions)]);
    if (offset) entries.push([label('上一页', 'Previous page'), () => cards(project, page, offset - 6)]);
    if (offset + 6 < page.items.length) entries.push([label('下一页', 'Next page'), () => cards(project, page, offset + 6)]);
    menu(label('相关机会', 'Related opportunities') + ' · ' + plain(project.title) + '\n'
      + (!page.enabled ? label('发现已关闭或暂时暂停；在接触意愿中调整。', 'Discovery is disabled or temporarily paused; change contact wishes.')
        : !page.items.length ? label('本次没有符合可见性、功能及意愿的机会。', 'No opportunity met visibility, function and contact wishes in this query.') : label('功能相关，自述未经认证；尚未发送任何接触消息。', 'Shared functions; self-declared, not certified. No contact message has been sent.'))
      + (page.windowLimited || page.resultLimited ? '\n' + label('结果有截断，不代表全部项目；可调整关注方向。', 'Results are bounded; this is not the complete directory. Adjust your focus if useful.') : ''), entries, () => chooseProject());
  }
  function cardView(project,page,card,offset){void run(()=>controller.queryProjectDiscovery({projectId:project.id,limit:20}),current=>{
    const fresh=current.items.find(item=>item.subjectId===card.subjectId&&item.project.id===card.project.id);
    if(!fresh)return notice(label('这项机会当前已不可见，或接触意愿已变化。','This opportunity is unavailable or the contact wish changed.'),()=>query(project,offset));
    renderCard(project,current,fresh,offset);
  },()=>query(project,offset));}
  function renderCard(project, page, card, offset) {
    const d = card.match.differences, back = () => query(project,offset);
    menu(plain(card.project.title) + '\n' + plain(card.project.summary) + '\n\n'
      + label('相关功能：', 'Shared functions: ') + join(card.match.sharedFunctions) + '\n'
      + label('共同目的：', 'Common purposes: ') + join(card.match.purposes.map(value => purposes[value])) + '\n'
      + label('我方独有功能：', 'Your distinct functions: ') + join(d.sourceOnlyFunctions) + '\n'
      + label('对方独有功能：', 'Their distinct functions: ') + join(d.candidateOnlyFunctions) + '\n'
      + label('我方不同技术：', 'Your distinct technologies: ') + join(d.sourceOnlyTechnologies) + '\n'
      + label('对方不同技术：', 'Their distinct technologies: ') + join(d.candidateOnlyTechnologies), [
        [label('查看当前来源资料', 'Read current source Profile'), () => void run(() => controller.queryHistory({ subjectId: card.subjectId, limit: 1 }), profile => {
          const current = profile.selfDeclared?.projects?.find(value => value.id === card.project.id);
          if (!current || !profile.selfDeclaredSource) { notice(label('这份来源当前已不可见。','This source is no longer visible.'), back); return; }
          notice((profile.selfDeclaredSource.id !== card.sources[1]?.statementId ? label('资料已更新；以下为当前来源。\n', 'Profile updated; current source follows.\n') : '')
            + `${plain(profile.selfDeclared.displayName)||card.subjectId}\n\n${plain(current.title)}\n${plain(current.summary)}\n${join(current.functions)}\n${plain(current.sourceUrl)}`, back);
        }, back)],
        [label('查看双方来源引用', 'View both source references'), () => notice(card.sources.map(source => `${source.subjectId}\n${source.projectId}\n${source.statementId}\n${plain(source.sourceUrl)}`).join('\n\n'), back)],
        [label('查看完整介绍与差异', 'Read full description and differences'), () => menu(label('完整资料（自述）', 'Full self-declared details'), [
          [label('功能介绍', 'Function description'), () => notice(plain(card.project.summary), () => cardView(project, page, card, offset))],
          ...[[label('相关功能', 'Shared functions'), card.match.sharedFunctions], [label('我方独有功能', 'Your distinct functions'), d.sourceOnlyFunctions],
            [label('对方独有功能', 'Their distinct functions'), d.candidateOnlyFunctions], [label('我方不同技术', 'Your distinct technologies'), d.sourceOnlyTechnologies],
            [label('对方不同技术', 'Their distinct technologies'), d.candidateOnlyTechnologies]].map(([title, values]) => [title, () => notice(join(values), () => cardView(project, page, card, offset))]),
        ], () => cardView(project, page, card, offset))],
      ], back);
  }
  function preferences() { void run(() => controller.projectDiscoveryPreferences(), renderPreferences); }
  function save(current, value) {
    const parsed = discoveryPreferencesSchema.safeParse(value);
    if (!parsed.success) { notice(label('请检查意愿、功能标签和截止时间。', 'Check purposes, function tags and expiry.'), preferences); return; }
    void run(() => controller.saveProjectDiscoveryPreferences({ expectedRevision: current.revision, preferences: parsed.data }), renderPreferences, preferences);
  }
  function editFunctions(value, done, back) {
    ask(label('关注的功能标签，用逗号分隔；留空不额外筛选', 'Function focus, comma-separated; blank means no extra filter'), (value ?? []).join(', '), raw => {
      const parsed = functionTagsSchema.safeParse(String(raw).split(/[,，\n]/).map(value => value.trim()).filter(Boolean));
      if (!parsed.success) { notice(label('最多16项，每项80字。', 'Up to16 tags, each80 characters.'), back); return; } done(parsed.data);
    }, back);
  }
  function editPurposes(values, done, back) {
    const selected = [...values];
    const render = () => menu(label('选择接触目的', 'Choose contact purposes'), [
      ...Object.entries(purposes).map(([key, title]) => [(selected.includes(key) ? '✓ ' : '○ ') + title, () => {
        const index = selected.indexOf(key); if (index < 0) selected.push(key); else selected.splice(index, 1); render();
      }]),
      [label('保存选择', 'Save selection'), () => { if (!selected.length) { notice(label('至少保留一种目的。', 'Keep at least one purpose.'), render); return; } done([...selected]); }],
    ], back); render();
  }
  function renderPreferences(current) {
    const p = current.preferences;
    menu(label('接触意愿', 'Contact wishes') + '\n' + (current.effective.enabled ? label('当前欢迎接触', 'Currently open to contact') : label('当前关闭或暂停', 'Currently disabled or paused'))
      + '\n' + label('当前目的：', 'Current purposes: ') + join(current.effective.purposes.map(value => purposes[value]))
      + '\n' + label('短期截止：', 'Temporary until: ') + time(current.effective.temporaryUntil), [
        [p.enabled ? label('关闭发现', 'Disable discovery') : label('开启发现', 'Enable discovery'), () => save(current, { ...p, enabled: !p.enabled })],
        [label('长期接触目的', 'Long-term purposes'), () => editPurposes(p.purposes, values => save(current, { ...p, purposes: values }), () => renderPreferences(current)), join(p.purposes.map(value => purposes[value]))],
        [label('长期关注方向', 'Long-term function focus'), () => editFunctions(p.functions, values => save(current, { ...p, functions: values }), () => renderPreferences(current)), join(p.functions)],
        [label('临时调整', 'Temporary override'), () => temporary(current), p.temporary ? `${p.temporary.contact} · ${time(p.temporary.until)}` : ''],
        [label('清除临时调整，恢复长期设置', 'Clear override and restore long-term settings'), () => save(current, { ...p, temporary: null })],
      ]);
  }
  function temporary(current) {
    const p = current.preferences, draft = p.temporary && p.temporary.until > now() ? structuredClone(p.temporary) : { contact: 'welcome', until: null };
    const render = () => menu(label('临时接触意愿草稿', 'Temporary contact wish draft') + '\n' + label('保存后生效，到期恢复长期设置。', 'Takes effect when saved; long-term settings return at expiry.'), [
      [label('切换欢迎／暂停', 'Toggle welcome / pause'), () => { draft.contact = draft.contact === 'welcome' ? 'paused' : 'welcome'; render(); }, draft.contact],
      [label('持续时长', 'Duration'), () => ask(label('请输入持续小时数，例如 2；可输入小数', 'Duration in hours, e.g. 2; decimals allowed'), '', raw => {
        const hours = Number(String(raw).trim()), until = now() + Math.round(hours * 3600);
        if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(until) || until <= now() || until > 8640000000000) { notice(label('请输入有效的正小时数。', 'Enter a valid positive duration in hours.'), render); return; }
        draft.until = until; render();
      }, render), time(draft.until)],
      [label('短期接触目的', 'Temporary purposes'), () => editPurposes(draft.purposes ?? p.purposes, value => { draft.purposes = value; render(); }, render), draft.purposes ? join(draft.purposes.map(value => purposes[value])) : label('沿用长期设置', 'Inherit long-term settings')],
      [label('短期关注方向', 'Temporary function focus'), () => editFunctions(draft.functions ?? p.functions, value => { draft.functions = value; render(); }, render), draft.functions ? join(draft.functions) : label('沿用长期设置', 'Inherit long-term settings')],
      [label('目的改为沿用长期', 'Inherit long-term purposes'), () => { delete draft.purposes; render(); }],
      [label('方向改为沿用长期', 'Inherit long-term focus'), () => { delete draft.functions; render(); }],
      [label('保存临时意愿', 'Save temporary wish'), () => {
        if (!draft.until || draft.until <= now()) { notice(label('请先设置未来截止时间。', 'Set a future expiry first.'), render); return; }
        save(current, { ...p, temporary: draft });
      }],
    ], () => renderPreferences(current)); render();
  }
  return Object.freeze({ open: home });
}
