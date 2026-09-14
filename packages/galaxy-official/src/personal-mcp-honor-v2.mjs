import {z} from 'zod';
import {contributionStatusSchema,contributionOwnedSourcesSchema,contributionPreviewSchema,contributionProjectionReadSchema} from './shared/contribution-sharing-v2-schema.mjs';
import {honorQueryV2Schema} from './shared/honor-v2-schema.mjs';
import {honorRankingSchema} from './shared/honor-schema.mjs';
import {requesterHistoryV2Schema,requesterHistoryFactsV2Schema} from './shared/requester-history-v2-schema.mjs';
export function honorToolDefinitions(services,actor){
  const tool=(scope,inputSchema,description,run,write=false)=>({scope,inputSchema,description,run,write});
  const signed=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(48000)});
  return{
    galaxy_contribution_status:tool('history',contributionStatusSchema,'Reconcile your exact publication or revocation by operation and payload hash; get current source, expiry and permission status without broadening source text access.',i=>services.contributionSharing.status(actor,i)),
    galaxy_contribution_sources:tool('history',contributionOwnedSourcesSchema,'List your currently valid publishable Case or Task event references and exact source hashes before selecting fields. Never enumerate another author’s sources or infer permission to publish; nextAfter continues only this owned source page.',i=>services.contributionSharing.ownedSources(actor,i)),
    galaxy_contribution_preview:tool('history',contributionPreviewSchema,'Preview exactly selected fields from your own immutable source events and bounded Honor/requester-history purposes. Preview does not publish; it grants no original text access.',i=>services.contributionSharing.preview(actor,i)),
    galaxy_contribution_publish:tool('history',signed,'Publish or revoke exact author-signed contribution projection permission. Consent action contribution.publish, objectId payload.id. Each source author chooses fields, purposes and expiry separately; Private Task text remains private. Reading or delivery acceptance is not capability certification.',i=>services.contributionSharing.submit(actor,i),true),
    galaxy_contribution_read:tool('history',contributionProjectionReadSchema,'Read currently permitted selected contribution fields using source reference or opaque publicationId/sourceKey. Rechecks original source and publication withdrawal/deletion; does not open the original Task or Case.',i=>services.contributionSharing.readProjection(actor,i)),
    galaxy_honor_v2_query:tool('history',honorQueryV2Schema,'Read current facts-v2 scoped contribution Honor, source limitations and multi-party roles. Accepted partial/failed scoped work is distinct from a solved Case; simulation never grants Honor or eligibility.',i=>services.honor.v2.query(actor,i)),
    galaxy_honor_v2_ranking:tool('history',honorRankingSchema,'Read only an explicitly approved scoped public contribution cohort. Ranking is suppressed by default and when the required real public sample is absent; no global ability score.',i=>services.honor.v2.ranking(i)),
    galaxy_requester_history_v2_query:tool('assistance',requesterHistoryV2Schema,'Read currently permitted actual request, acceptance, cancellation and dispute facts. Missing response is unknown, cancellation is not maliciousness, and private provider feedback is not automatically public.',i=>services.requesterHistoryV2.query(actor,i)),
    galaxy_requester_history_v2_facts:tool('assistance',requesterHistoryFactsV2Schema,'Read paged request facts and exact current/superseded provider feedback. Descriptive reports are not independent quality ratings; earlier feedback cannot silently replace a correction.',i=>services.requesterHistoryV2.facts(actor,i)),
  };
}
