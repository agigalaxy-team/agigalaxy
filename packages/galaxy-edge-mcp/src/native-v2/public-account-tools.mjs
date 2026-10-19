import * as z from 'zod/v4';

const accountId=z.uuid(),subjectId=z.string().regex(/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
const page=after=>({after:after.optional(),limit:z.number().int().min(1).max(50).default(20)});
export const nativePublicAccountProfileSchema=z.strictObject({accountId});
export const nativePublicAccountIdsSchema=z.strictObject({accountId,...page(subjectId)});
export const nativePublicAccountCredentialsSchema=z.strictObject({accountId,...page(accountId)});
export const nativePublicAccountPostsSchema=z.strictObject({accountId,...page(z.string().max(512).regex(/^fp1\.[A-Za-z0-9_-]+$/))});
export const nativePublicAccountsForIdSchema=z.strictObject({subjectId,...page(accountId)});

// Only already public online projections. No local identity, background,
// credential, new Consent or model is needed to read these exact resources.
export function nativePublicAccountDefinitions(api){
 const read=(schema,path,paginated=false)=>({inputSchema:schema,write:false,
  run:input=>{const value=schema.parse(input);let target=path(value);
   if(paginated){const query=new URLSearchParams();if(value.after)query.set('after',value.after);query.set('limit',String(value.limit));target+='?'+query;}
   return api.call(target,undefined,{method:'GET',authenticated:false});}});
 return {
  galaxy_account_public_profile:{...read(nativePublicAccountProfileSchema,input=>'/v1/account/public/'+input.accountId),
   description:'Read this known online account’s enabled public profile anonymously. Returns the current published fields and their stated sources, without a credibility judgment. Hidden or disabled data remains unavailable; no local background is uploaded and no identity or account is created.'},
  galaxy_account_public_ids:{...read(nativePublicAccountIdsSchema,input=>'/v1/account/public/'+input.accountId+'/ids',true),
   description:'Read one page of IDs this known account explicitly allows in public queries. Use the returned nextAfter for the next page, at most 50 items. Other links, private histories and identity control are not exposed or inferred. Anonymous GET; no local background or new authorization.'},
  galaxy_account_public_credentials:{...read(nativePublicAccountCredentialsSchema,input=>'/v1/account/public/'+input.accountId+'/credentials',true),
   description:'Read one page of externally issued credentials this known account explicitly permits for public query. Preserve issuer, source and current status as returned; Galaxy supplies no certification or credibility assessment. Use nextAfter, at most 50 items. Anonymous GET with no local material.'},
  galaxy_account_public_posts:{...read(nativePublicAccountPostsSchema,input=>'/v1/account/public/'+input.accountId+'/posts',true),
   description:'Continue reading this known account’s anonymously readable published posts. Pass the returned nextAfter unchanged, at most 50 items. Each page checks the current account disclosure and post audience; missing entries are not evidence of no private activity. Anonymous GET with no local context or new authorization.'},
  galaxy_account_public_by_id:{...read(nativePublicAccountsForIdSchema,input=>'/v1/account/public/by-id/'+input.subjectId,true),
   description:'Read one page of accounts that explicitly make their association with this known Galaxy ID publicly queryable. An omitted account is not evidence that no private association exists. Use nextAfter, at most 50 items. Anonymous GET; no local context, identity creation or control permission.'},
 };
}
