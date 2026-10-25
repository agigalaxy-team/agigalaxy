import { AgentCard } from '@a2a-js/sdk';
import { fetchPublicJson, validatePublicUrl } from '../../../galaxy-official/src/public-fetch.mjs';
import { hash } from '../storage/journal.mjs';

// Discovery does not enroll a peer. The chosen trust policy supplies a current
// pin (or a separately verified signed-card digest), never a hash self-asserted
// by the downloaded card. No credential is accepted by this API.
export async function discoverA2aCard({ cardUrl, endpoint, tenant = '', expectedCardHash,
  trustExpiresAt, now = () => Date.now(), fetchJson = fetchPublicJson }) {
  const cardLocation = validatePublicUrl(cardUrl), selected = validatePublicUrl(endpoint);
  if (cardLocation.origin !== selected.origin || !/^[0-9a-f]{64}$/.test(expectedCardHash ?? '')
    || !Number.isSafeInteger(trustExpiresAt) || trustExpiresAt <= now()) throw new Error('Current host-selected AgentCard trust required.');
  const card = await fetchJson(cardLocation.href, { timeoutMs: 10000, maxBytes: 65536 });
  const cardHash = hash(JSON.stringify(card));
  if (cardHash !== expectedCardHash) throw new Error('AgentCard changed; review trust before use.');
  const wire = AgentCard.fromJSON(card);
  if (!wire.supportedInterfaces.some(i => i.url === selected.href && i.tenant === tenant
    && i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0')) throw new Error('Selected A2A 1.0 JSONRPC interface unavailable.');
  return { card, cardHash, endpoint: selected.href, tenant, trustExpiresAt,
    trustBasis: 'host-selected-card-digest', capabilityVerified: false };
}
