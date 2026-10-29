// Format structured names only. Explicit labels are not parsed or reordered;
// the original name fields and all identity/authorization references stay intact.
const present=value=>typeof value==='string'&&value.trim()?value:'';
const han=/^\p{Script=Han}+$/u;

export function personDisplayName({firstName,lastName,displayName}={}){
 const first=present(firstName),last=present(lastName);
 const original=[first,last].filter(Boolean).join(' ').trim(),explicit=present(displayName);
 // A different declared label has its own meaning; do not infer its parts.
 if(explicit&&explicit.trim()!==original)return explicit;
 const given=first.trim(),family=last.trim();
 if(given&&family&&han.test(given)&&han.test(family))return family+given;
 return explicit||original||null;
}
