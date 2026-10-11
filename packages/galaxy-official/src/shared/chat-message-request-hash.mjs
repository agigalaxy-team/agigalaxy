import canonicalize from 'canonicalize';
import {chatSendSchema} from './chat-schema.mjs';

// Browser-safe and identical to ChatService's canonical parsed send digest.
// Default replyTo is included; optional attachment/grant fields remain absent.
export async function chatSendRequestHash(input){
 const bytes=new TextEncoder().encode(canonicalize(chatSendSchema.parse(input)));
 return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
