import {authoredRows,isStructuredToolPayload} from '../presentation/native-result.mjs';
const contentLabels = {
  title: '标题', summary: '内容', content: '内容', text: '内容', description: '说明', goal: '希望得到什么',
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

// A tool's bounded excerpt may be only the beginning of structured output.
// Show authored text, but do not present partial machine records as prose.
export function readableToolOutput(value, depth=0) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text=value.trimStart();
  if (text[0] !== '{' && text[0] !== '[') return value;
  if (depth>=8) return '';
  try {
    const parsed=JSON.parse(text);
    if (!isStructuredToolPayload(parsed)) return value;
    return authoredRows(parsed).filter(row=>!row.download).map(row=>['内容','消息','说明','标题'].includes(row.label)?row.text:row.label+'：'+row.text).join('\n\n');
  } catch {
    // Incomplete machine-like object excerpts cannot be interpreted as a result.
    return /^\{\s*"(?:[^"\\]|\\.)+"\s*:/.test(text) || /^\[\s*\{\s*"/.test(text) ? '' : value;
  }
}

// Exact references, hashes and payloads stay in structuredContent. The human
// surface uses the actual authored content; it never turns an object dump into
// a purported explanation or invents names for opaque subject references.
export function readableContent(value, {limit = 24, maxText = 16000, allowedKeys, skipKeys} = {}) {
  const rows = [], seen = new Set();
  function walk(object, depth = 0) {
    if (!object || depth > 5 || rows.length >= limit) return;
    if (Array.isArray(object)) { for (const item of object) walk(item, depth + 1); return; }
    if (typeof object !== 'object') return;
    for (const [key, item] of Object.entries(object)) {
      if (rows.length >= limit) break;
      if (contentLabels[key] && (!allowedKeys || allowedKeys.has(key)) && typeof item === 'string' && item.trim()) {
        const text = item.slice(0, maxText), signature = contentLabels[key] + '\0' + text;
        if (!seen.has(signature)) { seen.add(signature); rows.push({label: contentLabels[key], text}); }
      } else if (!skipKeys?.has(key) && !/(?:id|hash|proof|signature|authorization|receipt|secret|token|key|revision|version)$/i.test(key)) walk(item, depth + 1);
    }
  }
  walk(value); return rows;
}

export function mcpErrorCode(result, fallback) {
  if (result?.structuredContent?.error) return result.structuredContent.error;
  try { return JSON.parse(result?.content?.[0]?.text)?.error ?? fallback; } catch { return fallback; }
}

export function panelErrorMessage(code, subject='内容') {
  if (['panel_identity_changed','local_identity_changed','local_work_identity_changed','local_archive_identity_changed'].includes(code)) return '当前身份已变化，请重新选择要查看的内容。';
  if (['panel_connection_changed','a2a_connection_changed','receipt_status_authority_changed'].includes(code)) return '当前连接已变化，请重新选择要查看的内容。';
  if (code==='chat_agent_not_authorized') return '当前回复授权已变化，请在完整对话中处理。';
  if (code==='panel_draft_conflict') return '这份草稿在另一处发生了修改，请核对后保存。';
  if (['a2a_preview_expired','a2a_preview_changed_or_expired','local_consent_expired','local_disclosure_expired'].includes(code)) return '本次内容已过期，请重新选择。';
  if (['chat_message_conflict','local_summary_conflict','local_work_summary_revision_conflict'].includes(code)) return '内容已变化，请核对后继续。';
  if (['local_recovery_required','local_work_identity_recovery_required','local_archive_identity_recovery_required'].includes(code)) return '本机资料需要恢复后才能继续。';
  if (code==='local_storage_busy') return '本机资料正在使用，请稍后再试。';
  return subject+'暂时无法处理，请稍后再试。';
}

export function panelText(data) {
  if (data.error) return panelErrorMessage(data.error);
  if (data.url && !data.schemaVersion) return (data.launched ? '已请求打开当前内容。' : '可以打开当前内容：') + '\n' + data.url;
  if (data.draft && !data.schemaVersion) return '笔记已保存在本机。';
  const lines = [];
  if (data.sourceError) lines.push('当前内容暂时无法读取。');
  if (data.helpError) lines.push('帮助暂时无法读取。');
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
  if (data.handoff) lines.push('已准备好继续处理。');
  return lines.join('\n\n') || '可以说明需要什么帮助。';
}
