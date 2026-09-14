import { Task, Message, Artifact, TaskState } from '@a2a-js/sdk';
import { hash } from './journal.mjs';

const states = new Map([
  [TaskState.TASK_STATE_SUBMITTED, 'submitted'], [TaskState.TASK_STATE_WORKING, 'working'],
  [TaskState.TASK_STATE_COMPLETED, 'completed'], [TaskState.TASK_STATE_FAILED, 'failed'],
  [TaskState.TASK_STATE_CANCELED, 'canceled'], [TaskState.TASK_STATE_INPUT_REQUIRED, 'input-required'],
  [TaskState.TASK_STATE_REJECTED, 'rejected'], [TaskState.TASK_STATE_AUTH_REQUIRED, 'auth-required'],
]);
export const terminal = state => ['completed', 'failed', 'canceled', 'rejected'].includes(state);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/\p{Cc}/u.test(value);

// Hashes describe received bytes/objects; they do not authenticate the peer,
// download linked artifacts, or certify the result as a Galaxy Proof.
export function snapshot(result, previous) {
  const isTask = Object.hasOwn(result ?? {}, 'id');
  const wire = isTask ? Task.toJSON(result) : Message.toJSON(result);
  const serialized = JSON.stringify(wire);
  if (Buffer.byteLength(serialized) > 1048576) throw new Error('A2A response exceeds profile limit.');
  if (!identifier(result.contextId)) throw new Error('Invalid peer context ID.');
  if (previous?.contextId && result.contextId !== previous.contextId) throw new Error('Peer context ID changed.');
  if (!isTask) {
    if (previous?.taskId || !identifier(result.messageId) || result.taskId) throw new Error('Unexpected standalone A2A message.');
    return { kind: 'message', contextId: result.contextId, messageId: result.messageId,
      state: 'message-only', responseHash: hash(serialized), artifacts: [], verification: 'peer-reported',
      text: textParts(result.parts) };
  }
  const state = states.get(result.status?.state);
  if (!identifier(result.id) || !state) throw new Error('Invalid peer task/state.');
  if (previous?.taskId && result.id !== previous.taskId) throw new Error('Peer task ID changed.');
  if (previous && terminal(previous.state) && state !== previous.state) throw new Error('Peer terminal state changed.');
  if (result.artifacts.length > 64) throw new Error('Too many A2A artifacts.');
  const artifacts = result.artifacts.map(artifact => {
    if (!identifier(artifact.artifactId) || artifact.parts.length > 64) throw new Error('Invalid A2A artifact.');
    return { artifactId: artifact.artifactId, name: artifact.name.slice(0, 160),
      objectHash: hash(JSON.stringify(Artifact.toJSON(artifact))),
      parts: artifact.parts.map(part => {
        const content = part.content;
        if (!content) throw new Error('Unsupported A2A part.');
        const raw = content.$case === 'raw';
        const bytes = raw ? Buffer.from(content.value) : Buffer.from(typeof content.value === 'string' ? content.value : JSON.stringify(content.value));
        return { kind: content.$case, mediaType: part.mediaType.slice(0, 160), bytes: bytes.length,
          sha256: hash(bytes), ...(content.$case === 'text' ? { text: content.value.slice(0, 1200) } : {}),
          ...(content.$case === 'url' ? { referenceHash: hash(content.value), downloaded: false } : {}) };
      }) };
  });
  if (new Set(artifacts.map(a => a.artifactId)).size !== artifacts.length) throw new Error('Duplicate A2A artifact ID.');
  return { kind: 'task', taskId: result.id, contextId: result.contextId, state,
    responseHash: hash(serialized), artifacts, verification: 'peer-reported',
    text: textParts(result.status?.message?.parts ?? []) };
}

function textParts(parts) {
  return parts.filter(p => p.content?.$case === 'text').map(p => p.content.value).join('\n').slice(0, 1200);
}

export function resultDraft(link, caseVersion, id) {
  const peer = link.peer;
  if (link.status !== 'observed' || !terminal(peer?.state)) throw new Error('Observed terminal A2A task required.');
  const failed = ['failed', 'rejected'].includes(peer.state);
  return { kind: 'result', id, caseId: link.caseId, attemptId: link.attemptId, expectedVersion: caseVersion,
    outcome: peer.state === 'completed' ? 'succeeded' : failed ? 'failed' : 'inconclusive',
    summary: peer.text || `A2A peer reported ${peer.state}; ${peer.artifacts.length} artifact(s).`,
    failureReason: failed ? peer.text || `A2A peer reported ${peer.state}.` : '',
    limitations: ['External peer report; no independent execution or capability verification.',
      `A2A state: ${peer.state}; association: ${link.id}; response SHA-256: ${peer.responseHash}`,
      'Artifact hashes identify received content/references. Referenced URLs were not fetched; this is not a Proof.'] };
}
