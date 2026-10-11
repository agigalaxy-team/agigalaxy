import { authoredRows,nativeStateLabel,nativeAudienceLabel,a2aParticipantContent } from '../../../packages/galaxy-edge-mcp/src/native-v2/presentation.mjs';

export function workerPanelText(data) {
  const view=data.selected,preview=data.preview,result=data.actionResult;
  const lines=[view?.association?.purpose??preview?.purpose??(data.kind==='galaxy-a2a-panel'?'当前服务工作':'当前 Worker 工作')];
  const state=view?.peer?.peer?.state??view?.peer?.status??result?.result?.state??result?.state;
  if(state&&state!=='completed')lines.push(nativeStateLabel(state)??'当前结果尚待核对');
  const content=preview?.action==='result'&&data.kind==='galaxy-a2a-panel'?a2aParticipantContent(preview):view?.peer?.peer??result?.result?.peer??preview?.exact;
  for(const row of authoredRows(content,{limit:20}))if(!row.download)lines.push(row.label+'：'+row.text);
  if(preview)lines.push('本次内容与范围：'+nativeAudienceLabel(preview.visibility)+'。请在当前宿主完成必要选择。');
  for(const row of data.associations??[])lines.push(row.purpose??'已有工作');
  return lines.join('\n\n');
}

// Ordinary MCP retains the exact authorized review. Supported Apps may carry
// its private material only in component metadata, without changing authority.
export function workerPanelResult(data, { componentOnly = false } = {}) {
  if (data?.resultType === 'input_required' || Array.isArray(data?.content)) return data;
  const preview = data?.preview;
  const model = componentOnly && preview
    ? { ...data, preview: { ...preview, exact: undefined, exactContentInComponent: true } }
    : data;
  return {
    content: [{ type: 'text', text: workerPanelText(model) }], structuredContent: model,
    ...(componentOnly && preview ? { _meta: { galaxyWorker: { preview } } } : {}),
  };
}

export function workerComponentResult(result) {
  if (result?.resultType === 'input_required') return result;
  let data = result?.structuredContent ?? result;
  if (!result?.structuredContent && result?.content?.length === 1 && result.content[0].type === 'text') {
    try { data = JSON.parse(result.content[0].text); } catch { return result; }
  }
  const preview = result?._meta?.galaxyWorker?.preview;
  return preview ? { ...data, preview } : data;
}
