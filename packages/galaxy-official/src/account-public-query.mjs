import {z} from 'zod';
import {ServiceError} from './shared/service-error.mjs';

const subjectIdSchema=z.string().regex(/^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
const pageSchema=after=>z.strictObject({after:after.optional(),limit:z.number().int().min(1).max(50).default(20)});
const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)throw new ServiceError('invalid_account_query');return result.data;};
const iso=value=>new Date(value).toISOString();
const publicFlags=row=>({scope:row.query_scope,showLinkedIds:row.query_linked_ids===true,showExternalCredentials:row.query_external_credentials===true});

// These anonymous projections use the online account's explicit display choices.
// An association exposes no local work, other ID's private data or account control.
export class AccountPublicQuery {
  constructor({data,accounts,externalCredentials=null}){Object.assign(this,{data,accounts,externalCredentials});}
  providers(){return JSON.stringify([...(this.accounts?.providers??[])].map(value=>JSON.parse(value)));}
  async enabled(accountId,flag){
    parse(z.uuid(),accountId);
    const row=(await this.data.db.query(`SELECT p.* FROM official_account_profiles_v1 p JOIN community_accounts a ON a.id=p.account_id
      WHERE p.account_id=$1 AND a.endpoint=$2 AND p.query_enabled=true`,[accountId,this.data.endpoint])).rows[0];
    if(!row||row[flag]!==true)throw new ServiceError('not_found',404);
    return row;
  }
  async linkedIds(accountId,input={}){
    const page=parse(pageSchema(subjectIdSchema),input);await this.enabled(accountId,'query_linked_ids');
    const rows=(await this.data.db.query(`SELECT l.subject_id,MIN(l.created_at) AS linked_at
      FROM community_account_links g JOIN community_accounts a ON a.id=g.account_id
      JOIN external_identity_links l ON l.id=g.identity_link_id AND l.subject_id=g.subject_id
      WHERE a.id=$1 AND a.endpoint=$2 AND l.endpoint=$2 AND l.issuer=a.issuer AND l.external_subject=a.external_subject
      AND l.revoked_at IS NULL AND ($3::text IS NULL OR l.subject_id>$3)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) provider WHERE provider->>0=l.issuer AND provider->>1=l.client_id)
      GROUP BY l.subject_id ORDER BY l.subject_id LIMIT $5`,[accountId,this.data.endpoint,page.after??null,this.providers(),page.limit+1])).rows;
    const items=rows.slice(0,page.limit).map(row=>({subjectId:row.subject_id,linkedAt:iso(row.linked_at)}));
    return {accountId,items,nextAfter:rows.length>page.limit?items.at(-1).subjectId:null,checkedAt:this.data.now()};
  }
  async accountsForId(subjectId,input={}){
    parse(subjectIdSchema,subjectId);const page=parse(pageSchema(z.uuid()),input);
    const rows=(await this.data.db.query(`SELECT a.id,p.display_name,p.subject_type,p.query_scope,p.query_linked_ids,p.query_external_credentials,MIN(l.created_at) AS linked_at
      FROM community_account_links g JOIN community_accounts a ON a.id=g.account_id
      JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled=true AND p.query_linked_ids=true
      JOIN external_identity_links l ON l.id=g.identity_link_id AND l.subject_id=g.subject_id
      WHERE g.subject_id=$1 AND a.endpoint=$2 AND l.endpoint=$2 AND l.issuer=a.issuer AND l.external_subject=a.external_subject
      AND l.revoked_at IS NULL AND ($3::uuid IS NULL OR a.id>$3)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) provider WHERE provider->>0=l.issuer AND provider->>1=l.client_id)
      GROUP BY a.id,p.account_id ORDER BY a.id LIMIT $5`,[subjectId,this.data.endpoint,page.after??null,this.providers(),page.limit+1])).rows;
    const items=rows.slice(0,page.limit).map(row=>({accountId:row.id,displayName:row.display_name??null,subjectType:row.subject_type??null,
      typeSource:'account-owner-statement',linkedAt:iso(row.linked_at),publicQuery:publicFlags(row)}));
    return {subjectId,items,nextAfter:rows.length>page.limit?items.at(-1).accountId:null,checkedAt:this.data.now()};
  }
  async credentials(accountId,input={}){
    const page=parse(pageSchema(z.uuid()),input);await this.enabled(accountId,'query_external_credentials');
    if(!this.externalCredentials?.publicForAccount)throw new ServiceError('external_credentials_unavailable',503);
    return this.externalCredentials.publicForAccount(accountId,page);
  }
}
