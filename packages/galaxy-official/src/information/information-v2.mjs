import canonicalize from 'canonicalize';
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { informationQuerySchema } from "../shared/information-v2-schema.mjs";
import { searchV2Scope } from "../shared/search-v2-schema.mjs";

export const informationDigest = (value) => digest(canonicalize(value));
export function informationScope(source) {
  return source.kind === 'honor'
    ? 'history'
    : searchV2Scope(
        source.kind === 'reference'
          ? source.request.search.type
          : source.request.type,
      );
}
export function informationBase(source) {
  const value = structuredClone(source),
    query =
      value.kind === 'honor'
        ? value.request
        : value.kind === 'reference'
          ? value.request.search.query
          : value.request.query;
  delete query.after;
  delete query.expectedFingerprint;
  return value;
}
export function informationWithCursor(source, after) {
  const value = structuredClone(source),
    q =
      value.kind === 'honor'
        ? value.request
        : value.kind === 'search'
          ? value.request.query
          : null;
  if (q) {
    if (after) q.after = after;
    else delete q.after;
  }
  return value;
}
const hidden = (e) =>
  e instanceof ServiceError && [401, 403, 404].includes(e.status);
const malformed = (e) => e instanceof ServiceError && e.status === 400;
export const informationHelpPaths = [
  'continue-current-ai',
  'capsule-or-history',
  'open-assistance',
  'bounty-or-expert-assistance',
];
const limitations = [
  'Only the current viewer’s permitted sources are queried; no global count or expert ranking.',
  'Missing history, unavailable sources and unexpressed willingness are not lack of ability.',
  'Original event, environment, configuration, failure and verification meanings remain in each record.',
  'The user or their Agent interprets and chooses; querying never publishes, contacts or runs a model.',
];
// Aggregation adds a bounded response envelope, never a new authority or source.
export class InformationServiceV2 {
  constructor(access, { search, honor }) {
    Object.assign(this, { access, search, honor });
  }
  now() {
    return this.access.now();
  }
  queryId(actor, purpose, sources) {
    return informationDigest({
      version: 2,
      endpoint: this.access.endpoint,
      viewer: actor?.subjectId ?? null,
      purpose,
      sources: sources.map((s) => ({
        key: s.key,
        source: informationBase(s.source),
      })),
    });
  }
  async source(actor, selection) {
    const { key, source } = selection,
      scope = informationScope(source),
      checkedAt = this.now();
    const base = {
      key,
      scope,
      source: informationBase(source),
      method: {
        id: 'galaxy-permitted-information',
        version: '2.0.0',
        view:
          source.kind === 'honor'
            ? 'scoped-honor'
            : source.kind === 'reference'
              ? 'current-object'
              : 'source-query',
      },
      checkedAt,
      observedAt: checkedAt,
      observedAtMeaning:
        'time this authorized projection was observed; original source dates are not refreshed',
      cacheable: false,
    };
    try {
      let page,
        items,
        nextCursor = null;
      if (source.kind === 'honor') {
        page = await this.honor.query(actor, source.request);
        nextCursor = page.nextAfter;
        items = [
          {
            id: page.card.id,
            sourceVersion: page.sourceFingerprint,
            ref: { id: page.card.id, version: page.sourceFingerprint },
            title: page.card.rule.title ?? page.card.rule.id,
            record: page.card,
            authority:
              'versioned-scoped-rule-over-current-authorized-contributions',
            recordKind: 'honor-view',
            source: page.card.rule,
            // Full supporting records retain independent provenance and event dates.
            supportingItems: page.items,
            limitations: [
              'A scoped Honor is not a global score, a source-text grant or paid qualification.',
            ],
            sourceStatus: page.card.status,
          },
        ];
      } else if (source.kind === 'reference') {
        page = await this.search.reference(actor, source.request);
        items = page.item ? [page.item] : [];
      } else {
        page = await this.search.query(actor, source.request);
        items = page.items;
        nextCursor = page.nextCursor;
      }
      if (!Array.isArray(items))
        throw new ServiceError('information_source_response_invalid', 503);
      const sourceVersions = items.map((i) => ({
        id: i.id,
        version: i.sourceVersion,
      }));
      return {
        ...base,
        state: items.length ? 'available' : 'no-visible-data',
        items,
        sourceVersions,
        nextCursor: nextCursor ?? null,
        coverage: page.coverage ??
          page.coverageDescription ?? {
            scope: page.coverage ?? 'selected-source',
          },
        countsScope: 'current-authorized-page-only',
        complete: !nextCursor,
        sourceState:
          page.sourceState ?? page.state ?? page.card?.status ?? null,
        limitations: [...limitations, ...(page.limitations ?? [])],
        nextActions: ['read-source', 'refine-scope', 'choose-help-path'],
        ...(source.kind === 'honor'
          ? {
              method: { ...base.method, rule: page.card.rule },
              sourceFingerprint: page.sourceFingerprint,
            }
          : {}),
      };
    } catch (error) {
      if (malformed(error)) throw error;
      return {
        ...base,
        state: hidden(error) ? 'no-visible-data' : 'temporarily-unavailable',
        items: [],
        sourceVersions: [],
        nextCursor: null,
        complete: false,
        coverage: { scope: 'no-extra-source-existence-disclosed' },
        countsScope: 'current-authorized-page-only',
        limitations: [
          ...limitations,
          hidden(error)
            ? 'No permitted result is available.'
            : 'This source could not be read; other sources remain independent.',
        ],
        nextActions: hidden(error)
          ? ['refine-scope', 'choose-help-path']
          : ['retry-source', 'choose-help-path'],
      };
    }
  }
  async query(actor, input) {
    const parsed = informationQuerySchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_information_query');
    const x = parsed.data,
      queryId = this.queryId(actor, x.purpose, x.sources);
    if (x.queryId && x.queryId !== queryId)
      throw new ServiceError('information_query_scope_changed', 409);
    // Sequential bounded reads avoid saturating the shared DB pool; failures are
    // isolated. Each original service validates the current binding and source.
    const items = [];
    for (const selected of x.sources)
      items.push(await this.source(actor, selected));
    return {
      schemaVersion: 2,
      queryId,
      purpose: x.purpose,
      scope: x.sources.map((s) => ({
        key: s.key,
        source: informationBase(s.source),
        requiredScope: informationScope(s.source),
      })),
      method: {
        id: 'independent-authorized-source-projections',
        version: '2.0.0',
        ranking: false,
      },
      observedAt: this.now(),
      observedAtMeaning:
        'query observation, not evidence occurrence or external observation date',
      items,
      cursors: Object.fromEntries(items.map((i) => [i.key, i.nextCursor])),
      partial: items.some((i) => i.state === 'temporarily-unavailable'),
      helpPaths: informationHelpPaths,
      nextActions: [
        'continue-current-ai',
        'read-capsule-or-history',
        'publish-open-assistance',
        'consider-bounty-or-expert',
        'discover-or-chat',
      ],
      cacheable: false,
      modelCalls: 0,
      interpretation: 'user-or-user-agent',
      limitations,
    };
  }
}
