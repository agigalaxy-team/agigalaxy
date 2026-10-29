// Derive protocol bases without changing the operator's saved input or host.
// Custom prefixes remain explicit; no provider probing or fallback is used.
export function modelProtocolBase(address, apiFormat) {
 const url=new URL(address);
 let path=url.pathname.replace(/\/+$/,'');
 if(apiFormat==='gemini') path=path.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/,'');
 else path=path.replace(/\/(?:chat\/completions|responses|messages)$/,'');
 if(!path) path=apiFormat==='gemini'?'/v1beta':apiFormat.startsWith('openai-')?'/v1':'';
 url.pathname=path;
 return url.toString().replace(/\/$/,'');
}
