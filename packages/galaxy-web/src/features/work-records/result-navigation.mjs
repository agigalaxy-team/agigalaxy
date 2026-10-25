const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/** @typedef {{id:string,version:number}} ResultReference */
/** @param {unknown} value @returns {value is ResultReference} */
export function isResultReference(value){return !!value&&typeof value==='object'&&'id' in value&&uuid(value.id)&&'version' in value&&Number.isSafeInteger(value.version)&&Number(value.version)>0;}
/** @param {string} search */
export function readTaskResult(search){
 const query=new URLSearchParams(search),reference={id:query.get('result'),version:Number(query.get('resultVersion'))};
 return {selected:query.has('result')||query.has('resultVersion'),reference:isResultReference(reference)?reference:null,deliveryId:uuid(query.get('delivery'))?query.get('delivery'):null};
}
/** @param {string} taskId @param {ResultReference|null} [reference] @param {string|null} [deliveryId] */
export function taskResultPath(taskId,reference=null,deliveryId=null){
 if(!uuid(taskId))throw Error('这件工作的地址不完整。');
 const query=new URLSearchParams({section:'collaboration',view:'work',record:'results'});
 if(isResultReference(reference)){query.set('result',reference.id);query.set('resultVersion',String(reference.version));}
 if(uuid(deliveryId))query.set('delivery',deliveryId);
 return '/app/tasks/'+taskId+'?'+query;
}
/** @param {string} taskId @param {string|null} deliveryId */
export function taskResultReturn(taskId,deliveryId){return uuid(deliveryId)?'/app/tasks/'+taskId+'?section=collaboration&view=people#delivery-'+deliveryId:taskResultPath(taskId);}
/** Never replace a requested historical version with another readable result.
 * @template {{id:string,version:number}} T @param {T[]} items @param {ResultReference|null} reference @returns {T|null} */
export function exactReadableResult(items,reference){return isResultReference(reference)?items.find(item=>item.id===reference.id&&item.version===reference.version)??null:null;}
