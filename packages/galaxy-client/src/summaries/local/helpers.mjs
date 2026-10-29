
export const clone=x=>structuredClone(x);
export const failure=code=>Object.assign(new Error(code),{code});
export const validOrigin=endpoint=>{const u=new URL(endpoint);if(u.protocol!=='https:'||u.origin!==endpoint||u.username||u.password)throw failure('invalid_summary_target');return endpoint;};
export const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const sameHead=(a,b)=>a===null?b===null:!!a&&!!b&&Object.keys(a).length===2&&a.draftId===b.draftId&&a.revision===b.revision;
export const draftIdentity=({endpoint,roomId,summaryId})=>{validOrigin(endpoint);if(!uuid(roomId)||!uuid(summaryId))throw failure('invalid_summary_id');return JSON.stringify([endpoint,roomId,summaryId]);};
