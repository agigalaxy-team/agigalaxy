// Prepare bounded lexical clues across the request; this is not semantic search.
export function prepareExperienceQuery(input) {
 if(typeof input!=='string'||!input.trim())return '';
 const counts=new Map(), stop=new Set(['the','and','for','that','with','this','from','请问','需要','可以','如何','问题','一个','我们','这个']);
 for(const match of input.toLowerCase().matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
  const word=match[0], han=/^\p{Script=Han}+$/u.test(word), chars=Array.from(word);
  const terms=han&&chars.length>3?chars.slice(0,-2).map((_,i)=>({term:chars.slice(i,i+3).join(''),offset:i})):[{term:word,offset:0}];
  for(const {term,offset} of terms) {
   const length=Array.from(term).length;
   if(stop.has(term)||length<2||length>80)continue;
   const previous=counts.get(term);
   if(previous)previous.count++;
   else counts.set(term,{term,count:1,position:match.index+offset});
  }
 }
 // Repetition is not evidence of relevance. Consider rarer clues first;
 // for equally repeated clues, sample across the whole input in rounds.
 const groups=new Map();
 for(const value of counts.values()) {
  if(!groups.has(value.count))groups.set(value.count,Array.from({length:8},()=>[]));
  const bucket=Math.min(7,Math.floor(value.position*8/Math.max(1,input.length)));
  groups.get(value.count)[bucket].push(value.term);
 }
 const selected=[];
 for(const count of [...groups.keys()].sort((a,b)=>a-b)) {
  const buckets=groups.get(count),positions=Array(8).fill(0);
  while(selected.length<24) {
   let found=false;
   for(let i=0;i<buckets.length&&selected.length<24;i++) {
    if(positions[i]<buckets[i].length){selected.push(buckets[i][positions[i]++]);found=true;}
   }
   if(!found)break;
  }
  if(selected.length===24)break;
 }
 return selected.join(' ');
}
