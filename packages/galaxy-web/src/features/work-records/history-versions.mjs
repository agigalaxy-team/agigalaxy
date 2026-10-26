/**
 * Group only versions with the same explicit fact identity. The input remains
 * the complete authorized source used for downloads and currentness checks.
 * @template {{id?:string,version?:number}} T
 * @param {T[]} items
 * @returns {{latest:T,previous:T[]}[]}
 */
export function groupHistoryVersions(items){
 const groups=new Map();
 for(const [index,item] of items.entries()){
  const key=typeof item.id==='string'&&item.id?'id:'+item.id:'entry:'+index;
  const group=groups.get(key)??[];group.push(item);groups.set(key,group);
 }
 return [...groups.values()].map(group=>{
  const ordered=[...group].sort((a,b)=>(a.version??0)-(b.version??0));
  return {latest:ordered.at(-1),previous:ordered.slice(0,-1)};
 });
}
