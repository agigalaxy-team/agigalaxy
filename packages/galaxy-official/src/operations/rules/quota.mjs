// Shared arithmetic for the existing persisted daily counters and dry samples.
// This does not reserve or increment use, or create a new quota category.
export function p14QuotaCounts(limit,used){
 if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(used)||used<0)throw Error('Invalid quota counter');
 return {limit,used,remaining:Math.max(0,limit-used)};
}
