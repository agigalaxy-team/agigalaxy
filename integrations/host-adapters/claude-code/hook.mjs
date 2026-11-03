import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {content,environment,runHook,short,uniqueId} from '../shared/recorder.mjs';

// Hooks provide no general turn identifier; independent events get unique IDs.
export function normalizeClaudeHook(input) {
  const sessionId=input?.session_id,event=input?.hook_event_name;
  if(typeof sessionId!=='string'||!sessionId)return null;
  const facts=environment('claude-code',input);
  if(event==='UserPromptSubmit' && typeof input.prompt==='string')return {sessionId,facts,sourceId:`prompt:${uniqueId()}`,kind:'message',source:{kind:'user-statement'},content:content(input.prompt),details:{role:'user',completed:false,event:'host-pre-submit'}};
  if(event==='Stop' && typeof input.last_assistant_message==='string')return {sessionId,facts,sourceId:`assistant:${uniqueId()}`,kind:'message',source:{kind:'model-report'},content:content(input.last_assistant_message),details:{role:'assistant',completed:true}};
  if((event==='PostToolUse'||event==='PostToolUseFailure') && typeof input.tool_use_id==='string')return {sessionId,facts,sourceId:`tool:${input.tool_use_id}`,kind:'tool',source:{kind:'tool-report',eventId:input.tool_use_id},details:{tool:short(input.tool_name,160),status:event==='PostToolUse'?'completed':'error',workOutcome:'unknown'}};
  return null;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await runHook('claude-code',normalizeClaudeHook);


