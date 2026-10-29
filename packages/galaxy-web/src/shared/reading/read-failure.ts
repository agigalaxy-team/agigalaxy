/** A failed renewal only removes previously displayed data when the source has
 * explicitly rejected the identity or says that the requested object is gone. */
export function definitiveReadFailure(reason:unknown):boolean{
 const value=reason&&typeof reason==='object'?reason as {status?:unknown;code?:unknown;message?:unknown}:null;
 const code=typeof value?.code==='string'?value.code:typeof value?.message==='string'?value.message:'';
 return [401,403,404,410].includes(Number(value?.status))||['query_scope_reset','official_account_changed','official_account_session_expired','not_found','forum_section_not_found','account_work_not_found','account_work_deleted','account_work_owner_deleted'].includes(code);
}
