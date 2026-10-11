// MCP content and structuredContent are both model-visible. Unsent device-local
// notes belong exclusively to the component metadata, including save receipts.
import {panelText} from './presentation.mjs';
export function panelResult(data, host = {}) {
  const { draft, replyDraft, preview, choice, ...context } = data;
  const model = { ...context,
    ...(draft ? { draft: { revision: draft.revision, scope: draft.scope, hasContent: !!draft.text } } : {}),
    ...(replyDraft ? { replyDraft: { revision: replyDraft.revision, scope: replyDraft.scope, hasContent: !!replyDraft.text } } : {}),
    ...(preview ? { preview: { operationId:preview.operationId,payloadHash:preview.payloadHash,authorizationRequestId:preview.authorizationRequestId,authorizationExpiresAt:preview.authorizationExpiresAt,kind:preview.kind,taskId:preview.taskId,
      recipientIds:preview.recipientIds,visibility:preview.visibility,state:preview.state,exactContentInComponent:true } } : {}),
    ...(choice ? {choice:{state:choice.state,operation:choice.operation,sideEffect:false}} : {}),
  };
  return {
    content: [{ type: 'text', text: panelText(model) }], structuredContent: model,
    _meta: { galaxyUi: host, ...((draft || replyDraft || preview || choice) ? { galaxyPanel: { ...(draft ? { draft } : {}), ...(replyDraft ? { replyDraft } : {}), ...(preview ? { preview } : {}), ...(choice ? {choice} : {}) } } : {}) },
  };
}

export function componentResult(result) {
  const data = result?.structuredContent ?? result;
  const component = result?._meta?.galaxyPanel;
  return component ? { ...data, ...(component.draft ? { draft: component.draft } : {}), ...(component.replyDraft ? {replyDraft:component.replyDraft} : {}), ...(component.preview ? { preview: component.preview } : {}), ...(component.choice ? {choice:component.choice} : {}) } : data;
}
