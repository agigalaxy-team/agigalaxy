import { digest } from './digest.mjs';
const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]))):value;
export const retainedPayloadHash=value=>digest(JSON.stringify(canonical(value)));

// A retained summary is not the original operator text. Preserve its original
// hash separately, and verify the explicitly marked replacement summary.
export function readDeletionEventPayload(event){
  if(!/^[a-f0-9]{64}$/.test(event.payload_hash))throw new Error('Deletion event hash missing');
  if(event.payload_minimized===true){
    if(event.actor_kind!=='operator'||event.signature!==null||event.payload_text!==''
      ||!['approve','reject','needs-information','execute'].includes(event.kind)||!event.retained_payload
      ||retainedPayloadHash(event.retained_payload)!==event.retained_hash)throw new Error('Minimized deletion event mismatch');
    return event.retained_payload;
  }
  if(digest(event.payload_text)!==event.payload_hash)throw new Error('Deletion event hash mismatch');
  return JSON.parse(event.payload_text);
}
