import {showExactChoice} from './exact-choice.mjs';
export function createAuditMenu({ controller, select, prompt, info, language, isCurrent, onBack, availableScopes = [] }) {
  const zh = language !== 'en-US', label = (a, b) => zh ? a : b;
  const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 180);
  let generation = 0, config;
  const back = () => { generation++; controller.cancel(); onBack(); };
  const message = (text, next = home) => { if (isCurrent()) info(label('审计记录', 'Audit records'), text, next); };
  function menu(title, entries, next = home, offset = 0) {
    if (!isCurrent()) return;
    const routes = {}, options = entries.slice(offset, offset + 8).map(([title, action], i) => {
      routes[i + 1] = () => { if (isCurrent()) action(); }; return { number: String(i + 1), title, description: '' };
    });
    if (entries.length > offset + 8) { options.push({ number: '9', title: label('下一页', 'Next page'), description: '' }); routes[9] = () => menu(title, entries, next, offset + 8); }
    select({ title, options, routes, onBack: offset ? () => menu(title, entries, next, offset - 8) : next });
  }
  async function run(work, done, next = home) {
    const version = ++generation;
    message(label('正在处理', 'Working'), () => { generation++; controller.cancel(); next(); });
    try { const value = await work(); if (version === generation && isCurrent()) done(value); }
    catch (error) { if (version === generation && isCurrent()) message(plain(error.message), next); }
  }
  function form(title, fields, done, next = home, values = {}, index = 0) {
    if (!isCurrent()) return;
    if (index === fields.length) return done(values);
    const [key, name, initial = ''] = fields[index];
    prompt({ title: `${title}\n${name}`, placeholder: String(values[key] ?? initial),
      onCancel: () => next(), onConfirm: value => { if (!isCurrent()) return;
        values[key] = String(value).trim(); form(title, fields, done, next, values, index + 1); } });
  }
  function results(input) {
    void run(() => controller.readAudit('query', input), page => menu(label('操作记录', 'Operation records'), [
      ...page.items.map(item => [`${plain(item.sequence)} · ${plain(item.action)} · ${plain(item.outcome)}`,
        () => message(JSON.stringify(item, null, 2), () => results(input))]),
      [label('导出当前页 JSON', 'Export this page as JSON'), () => void run(() => controller.readAudit('export', { ...input, through: page.through }),
        value => message(`${value.filename}\n${JSON.stringify(value, null, 2)}`, () => results(input)), () => results(input))],
      ...(page.nextAfter ? [[label('读取后续记录', 'Read following records'), () => results({ ...input, after: page.nextAfter, through: page.through })]] : []),
    ], home));
  }
  function search(grant) {
    form(label('查询审计', 'Query audit'), [
      ['subjectId', label('主体 Galaxy ID', 'Subject Galaxy ID'), grant?.subjectIds[0] ?? config.subjectId],
      ['action', label('动作筛选；留空显示全部', 'Action filter; empty for all')],
      ['requestId', label('请求 UUID；留空不限', 'Request UUID; empty for all')],
    ], values => results({ ...Object.fromEntries(Object.entries(values).filter(([, value]) => value)), ...(grant ? { grantId: grant.id } : {}) }));
  }
  function grants() {
    void run(() => controller.readAudit('grants'), value => menu(label('我的审计授权', 'My audit grants'), value.items.map(grant => [
      `${plain(grant.id)} · ${grant.revoked ? label('已撤销', 'Revoked') : plain(grant.readerId)}`,
      () => menu(label('授权内容', 'Grant details'), [
        [label('查看准确范围与期限', 'Read scope and lifetime'), () => message(JSON.stringify(grant, null, 2), grants)],
        ...(!grant.revoked && grant.readerId === config.subjectId ? [[label('按此授权查询', 'Query with this grant'), () => search(grant)]] : []),
        ...(!grant.revoked && grant.reviewerId === config.subjectId && availableScopes.includes('audit-review') ? [[label('撤销此授权', 'Revoke this grant'),
          () => menu(label('确认撤销此审计授权', 'Confirm revocation'), [[label('撤销', 'Revoke'), () => void run(() => controller.readAudit('revoke', { id: grant.id }),
            () => message(label('已撤销；后续读取将重新核验', 'Revoked; following reads will recheck authorization'), grants), grants)]], grants)]] : []),
      ], grants)]), home));
  }
  function approval() {
    form(label('审批他人审计访问', 'Approve another reader'), [
      ['readerId', label('获配置权限的读取者 Galaxy ID', 'Configured reader Galaxy ID')],
      ['subjectIds', label('允许查询的主体 ID，逗号分隔', 'Allowed subject IDs, comma separated')],
      ['actions', label('动作 query / export，逗号分隔', 'Actions query / export, comma separated'), 'query'],
      ['reasonCode', label('追查事项编号，仅小写字母数字点或连字符', 'Reason code; lowercase letters, digits, dot or hyphen')],
      ['lifetimeSeconds', label('有效秒数，最多3600', 'Lifetime seconds, maximum3600'), '1800'],
    ], values => void run(() => controller.prepareAudit({ ...values, lifetimeSeconds: Number(values.lifetimeSeconds),
      subjectIds: values.subjectIds.split(/[,，]/).map(value => value.trim()).filter(Boolean),
      actions: values.actions.split(/[,，]/).map(value => value.trim()).filter(Boolean) }), preview => {
      const cancel = () => { generation++; controller.cancel(); home(); };
      let submitted = false;
      const previewVersion=generation;
      showExactChoice({preview,title:label('允许本次限时记录查询','Allow this time-limited record access'),select,info,language,isCurrent:()=>isCurrent()&&generation===previewVersion&&!submitted,
        onCancel: cancel, onConfirm: value => {
          if (!isCurrent() || submitted) return;
          submitted = true;
          void run(() => controller.executeAudit(preview, value), result => message(`${label('授权已记录', 'Approval recorded')}: ${result.id}`, grants));
        } });
    }));
  }
  function home() {
    void run(() => controller.readAudit('config'), value => { config = value;
      menu(label('审计与访问授权', 'Audit and access approval'), [
        [label('查询自己的操作', 'Query my operations'), () => search()],
        [label('我的审计授权', 'My audit grants'), grants],
        ...(config.canReview && availableScopes.includes('audit-review') ? [[label('审批他人访问', 'Approve another reader'), approval]] : []),
      ], back);
    }, back);
  }
  return { open: home };
}
