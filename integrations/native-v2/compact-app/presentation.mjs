const contentLabels = {
  title: '标题', summary: '内容', text: '内容', description: '说明', goal: '希望得到什么',
  currentSituation: '目前情况', purpose: '用途', reason: '原因', limitations: '适用限制',
  message: '消息', name: '名称', filename: '文件', fileName: '文件', label: '材料', url: '链接',
  requestedScope: '需要的帮助', resultSummary: '结果', outcome: '结果', notes: '补充说明',
};
export const actionLabels = {'publish-task': '发布请求', 'task-event': '更新请求',
  'participation-propose': '申请参与', 'participation-event': '更新参与情况',
  'context-grant': '分享材料', 'context-event': '调整材料范围'};
export const audienceLabel = (value,recipients=[]) => ['Private','private'].includes(value)&&recipients.length?'自己与所选接收方':({Public: '所有人', Private: '仅自己', Shared: '所选成员',
  public: '所有人', private: '仅自己', shared: '所选成员'}[value] ?? '本次选择的范围');
export const operationLabel = value => ({prepared: '待发送', absent: '尚未发送', submitting: '正在发送',
  unknown: '正在确认是否发送', acknowledged: '已完成', conflict: '内容发生变化', declined: '已取消',
  accepted: '已发送', proposed: '已申请', revoked: '已撤销', active: '进行中', open: '进行中', closed: '已结束',
  pending: '正在发送', retracted: '已撤回', expired: '已过期', available: '可使用'}[value] ?? '已更新');

// Exact references, hashes and payloads stay in structuredContent. The human
// surface uses the actual authored content; it never turns an object dump into
// a purported explanation or invents names for opaque subject references.
export function readableContent(value, {limit = 24, maxText = 16000} = {}) {
  const rows = [], seen = new Set();
  function walk(object, depth = 0) {
    if (!object || depth > 5 || rows.length >= limit) return;
    if (Array.isArray(object)) { for (const item of object) walk(item, depth + 1); return; }
    if (typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      if (rows.length >= limit) break;
      if (contentLabels[key] && typeof item === 'string' && item.trim()) {
        const text = item.slice(0, maxText), signature = contentLabels[key] + '\0' + text;
        if (!seen.has(signature)) { seen.add(signature); rows.push({label: contentLabels[key], text}); }
      } else if (!/(?:id|hash|proof|signature|authorization|receipt|secret|token|key|revision|version)$/i.test(key)) walk(item, depth + 1);
    }
  }
  walk(value); return rows;
}

export function panelText(data) {
  if (data.error) return '当前内容暂时无法取得。保留原输入，稍后重试或继续原工作。';
  if (data.url && !data.schemaVersion) return (data.launched ? '已请求打开当前内容。' : '可以打开当前内容：') + '\n' + data.url;
  if (data.draft && !data.schemaVersion) return '笔记已保存在本机。';
  const lines = [];
  if (data.sourceError || data.helpError) lines.push('部分内容暂不可用，请继续原工作或稍后重试。');
  if (data.source) {
    lines.push(data.source.title ?? '当前工作');
    if (data.source.summary) lines.push(data.source.summary);
    if(data.source.method?.solutionStrategy){
      const method=data.source.method;
      if(method.problemPattern)lines.push(method.problemPattern);
      lines.push('解决方法：'+method.solutionStrategy);
      if(method.applicableScope)lines.push('适用范围：'+method.applicableScope);
      if(method.limitations?.length)lines.push('限制：'+method.limitations.join('；'));
    }
    if (data.source.conversation?.messages?.length) {
      const messages = data.source.conversation.messages;
      lines.push('当前已读取的消息：');
      for (const m of messages.slice(-5)) lines.push((m.authorLabel ?? '成员') + '：' + (m.text ?? '这条消息已撤回。'));
    }
  }
  for (const offer of (data.help?.offers ?? []).filter(o => o.state === 'current').slice(0, 4)) {
    lines.push(offer.helpDescription); if (offer.userFacingReason) lines.push(offer.userFacingReason);
  }
  if (data.preview) lines.push('已准备' + (actionLabels[data.preview.kind] ?? '本次操作') + '，请查看内容与范围。');
  if (data.actionResult) lines.push(operationLabel(data.actionResult.state));
  if (data.messageResult) lines.push(data.messageResult.state === 'accepted' ? '消息已发送。' : operationLabel(data.messageResult.state));
  if (data.handoff) lines.push('可以带着当前结果继续原工作。');
  return lines.join('\n\n') || '在原工作中说明想取得的帮助，银河将沿用已有内容和身份继续。';
}
