export function createA2aMenu({ controller, select, prompt, info, language, isCurrent, onBack, availableScopes = [] }) {
  const label = (zh, en) => language === 'en-US' ? en : zh;
  const plain = (value, max = 2000) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, max);
  let generation = 0;
  const leave = () => { generation++; controller.cancel(); onBack(); };
  const message = (text, back = home) => { if (isCurrent()) info('A2A', text, back); };
  function menu(title, entries, back = home, offset = 0) {
    if (!isCurrent()) return;
    const routes = {};
    const options = entries.slice(offset, offset + 8).map(([title, action, description = ''], index) => {
      routes[index + 1] = () => { if (isCurrent()) action(); };
      return { number: String(index + 1), title, description };
    });
    if (offset + 8 < entries.length) {
      options.push({ number: '9', title: label('下一页', 'Next page'), description: '' });
      routes[9] = () => menu(title, entries, back, offset + 8);
    }
    select({ title, options, routes, onBack: offset ? () => menu(title, entries, back, offset - 8) : back });
  }
  async function run(work, done, back = home) {
    const version = ++generation;
    message(label('正在读取或准备', 'Reading or preparing'), () => { generation++; controller.cancel(); back(); });
    try { const result = await work(); if (isCurrent() && generation === version) done(result); }
    catch (error) { if (isCurrent() && generation === version) message(plain(error.message), back); }
  }
  function confirm(input, back) {
    void run(() => controller.prepareA2a(input), preview => {
      let submitted = false;
      const cancel = () => { generation++; controller.cancel(); back(); };
      const show = () => prompt({ title: `${label('确认目标与选定内容', 'Confirm destination and selected content')}\n${preview.endpoint}\n${preview.intentJson ?? ''}\n${preview.payloadJson}\n${preview.confirmation}`,
        placeholder: preview.confirmation, onCancel: cancel,
        onConfirm: async value => {
          if (!isCurrent() || submitted) return;
          if (value !== preview.confirmation) return message(label('确认文本不匹配，未提交', 'Confirmation mismatch; nothing submitted'), show);
          submitted = true; const version = ++generation;
          message(label('正在提交；取消本地等待不代表远端任务已取消', 'Submitting; aborting this wait does not cancel the remote task'), cancel);
          try {
            const result = await controller.executeA2a(preview, value);
            if (isCurrent() && generation === version) message(`${label('已记录', 'Recorded')}: ${plain(result.peer?.state ?? result.eventId ?? result.status)}\n${plain(result.id)}`, back);
          } catch { if (isCurrent() && generation === version) message(label('结果未确认。请读取任务或核对导入回执后再操作。', 'Outcome unconfirmed. Read the task or reconcile the import before continuing.'), back); }
        } });
      show();
    }, back);
  }
  function textInput(input, back) {
    prompt({ title: label('输入要发送给此端点的内容', 'Enter the selected text to send to this endpoint'), placeholder: '', onCancel: back,
      onConfirm: value => { if (isCurrent()) confirm({ ...input, text: String(value) }, back); } });
  }
  function start(peer) {
    const back = () => peerHome(peer);
    prompt({ title: label('已有银河 Case ID', 'Existing Galaxy Case ID'), placeholder: '', onCancel: back,
      onConfirm: caseId => { if (isCurrent()) void run(() => controller.getCase(String(caseId).trim()), current => {
        const attempts = current.events.filter(event => event.kind === 'attempt');
        menu(label('选择此次关联的尝试', 'Choose the Attempt for this task'), attempts.map(attempt => [
          `${attempt.sequence}: ${plain(attempt.approach, 140)}`, () => textInput({ peerId: peer.id, kind: 'send', caseId: current.caseId, attemptId: attempt.id }, back), plain(attempt.id)
        ]), back);
      }, back); } });
  }
  function importResult(peer, link) {
    const back = () => detail(peer, link.id);
    menu(label('这份结果的可见性', 'Visibility of this result'), [
      [label('私有', 'Private'), () => prompt({ title: label('允许查看的 Galaxy ID，逗号分隔；留空仅自己', 'Viewer Galaxy IDs, separated by commas; empty means yourself'), placeholder: '', onCancel: back,
        onConfirm: value => { if (isCurrent()) confirm({ peerId: peer.id, kind: 'result', associationId: link.id, visibility: 'Private', viewers: String(value).split(/[,，]/).map(s => s.trim()).filter(Boolean) }, back); } })],
      [label('公开选定结果', 'Public selected result'), () => confirm({ peerId: peer.id, kind: 'result', associationId: link.id, visibility: 'Public', viewers: [] }, back)],
    ], back);
  }
  function detail(peer, associationId) {
    const back = () => detail(peer, associationId), input = { peerId: peer.id, associationId };
    void run(() => controller.readA2a('get', input), link => {
      const entries = [
        [label('查看状态和来源', 'Read status and source'), () => message(JSON.stringify({ endpoint: peer.endpoint, principal: peer.peerPrincipal,
          caseId: link.caseId, attemptId: link.attemptId, status: link.status, peer: link.peer, operations: link.operations, resultImport: link.resultImport }, null, 2), back)],
      ];
      if (link.peer?.taskId) entries.push([label('查询远端任务', 'Poll remote task'), () => void run(() => controller.readA2a('poll', input), () => back(), back)]);
      if (link.status === 'observed' && ['input-required', 'auth-required'].includes(link.peer?.state))
        entries.push([label('发送补充内容', 'Send follow-up'), () => textInput({ ...input, kind: 'reply' }, back)]);
      if (link.status === 'observed' && ['submitted', 'working', 'input-required', 'auth-required'].includes(link.peer?.state))
        entries.push([label('请求取消远端任务', 'Request remote cancellation'), () => confirm({ ...input, kind: 'cancel' }, back)]);
      if (availableScopes.includes('consent') && link.status === 'observed' && ['completed', 'failed', 'rejected', 'canceled'].includes(link.peer?.state) && link.resultImport?.state !== 'acknowledged')
        entries.push([label('导入为未验证的 Case 结果', 'Import as unverified Case Result'), () => importResult(peer, link)]);
      if (link.resultImport) entries.push([label('核对结果导入回执', 'Reconcile Result import'), () => void run(() => controller.readA2a('reconcile', input), result => message(JSON.stringify(result), back), back)]);
      menu(`${plain(peer.name)} · ${plain(link.peer?.state ?? link.status)}\n${plain(link.id)}`, entries, () => tasks(peer));
    }, () => tasks(peer));
  }
  function tasks(peer) {
    void run(() => controller.readA2a('list', { peerId: peer.id }), links => menu(label('本机关联任务', 'Locally associated tasks'), links.map(link => [
      `${plain(link.peer?.state ?? link.status)} · ${plain(link.id)}`, () => detail(peer, link.id), plain(link.caseId)
    ]), () => peerHome(peer)), () => peerHome(peer));
  }
  function peerHome(peer) {
    menu(`${plain(peer.name)}\n${peer.endpoint}\n${plain(peer.peerPrincipal)}`, [
      [label('向已有尝试发送任务', 'Send task for an existing Attempt'), () => start(peer)],
      [label('查看关联任务', 'Read associated tasks'), () => tasks(peer)],
    ], home);
  }
  function home() {
    void run(() => controller.readA2a('peers'), peers => menu(label('选择已配置的 A2A 端点', 'Choose a configured A2A endpoint'), peers.map(peer => [
      plain(peer.name), () => peerHome(peer), `${peer.endpoint} · ${plain(peer.peerPrincipal)}`
    ]), leave), leave);
  }
  return { open: home };
}
