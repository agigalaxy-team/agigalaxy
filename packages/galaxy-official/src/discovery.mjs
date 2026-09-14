import { discoveryQuerySchema, discoverySaveSchema, defaultDiscoveryPreferences } from './shared/discovery-schema.mjs';
import { effectiveDiscovery, matchProjects } from './domain/discovery-match.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';

const candidateWindow = 200;
export class DiscoveryService {
  constructor(access, profiles, notifications) { Object.assign(this, { access, profiles, notifications }); }
  view(preferences) {
    const value = preferences.settings.discovery ?? structuredClone(defaultDiscoveryPreferences);
    return { preferences: value, revision: preferences.revision, effective: effectiveDiscovery(value, this.access.now()) };
  }
  async preferences(actor) { return this.view(await this.notifications.preferences(actor)); }
  async save(actor, input) {
    const parsed = discoverySaveSchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_discovery_preferences');
    const current = await this.notifications.preferences(actor);
    return this.view(await this.notifications.save(actor, {
      expectedRevision: parsed.data.expectedRevision,
      settings: { ...current.settings, discovery: parsed.data.preferences },
    }));
  }
  async query(actor, input) {
    const parsed = discoveryQuerySchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_discovery_query');
    return this.access.runAuthorized(actor, 'history', async db => {
      const own = await this.profiles.readWithin(db, actor, actor.subjectId);
      const source = own.selfDeclared.projects?.find(value => value.id === parsed.data.projectId);
      if (!source) throw new ServiceError('discovery_project_not_found', 404);
      const wish = this.view(await this.notifications.preferencesWithin(db, actor)).effective;
      const result = { items: [], enabled: wish.enabled, method: 'functional-tags-v1', computedAt: this.access.now(),
        windowLimited: false, resultLimited: false, capabilityVerified: false };
      if (!wish.enabled) return result;
      // Read only the latest signed declaration per subject. A bounded first
      // version is explicit about incomplete recall; it is not a global index.
      const candidates = (await db.query(`SELECT subject_id FROM (
        SELECT DISTINCT ON(subject_id) subject_id,id,created_at FROM profile_statements
        WHERE subject_id<>$1 ORDER BY subject_id,revision DESC
      ) latest ORDER BY created_at DESC,id LIMIT $2`, [actor.subjectId, candidateWindow + 1])).rows;
      result.windowLimited = candidates.length > candidateWindow;
      for (const row of candidates.slice(0, candidateWindow)) {
        // The projection checks current Consent and binding, including after a
        // private replacement or revocation. No older declaration is a fallback.
        const profile = await this.profiles.readWithin(db, actor, row.subject_id);
        const projects = profile.selfDeclared.projects?.filter(value => value.discoverable) ?? [];
        if (!projects.length) continue;
        const otherWish = this.view(await this.notifications.preferencesWithin(db, { subjectId: row.subject_id })).effective;
        for (const project of projects) {
          const match = matchProjects(source, project, wish, otherWish);
          if (!match) continue;
          result.items.push({
            id: digest([actor.subjectId, source.id, own.selfDeclaredSource.id, row.subject_id, project.id, profile.selfDeclaredSource.id].join(':')),
            project, subjectId: row.subject_id, displayName: profile.selfDeclared.displayName ?? null,
            match, classification: 'self-declared', capabilityVerified: false,
            sources: [
              { subjectId: actor.subjectId, projectId: source.id, statementId: own.selfDeclaredSource.id, sourceUrl: source.sourceUrl ?? null },
              { subjectId: row.subject_id, projectId: project.id, statementId: profile.selfDeclaredSource.id, sourceUrl: project.sourceUrl ?? null },
            ],
          });
        }
      }
      result.items.sort((a, b) => b.match.score - a.match.score || a.id.localeCompare(b.id));
      result.resultLimited = result.items.length > parsed.data.limit;
      result.items = result.items.slice(0, parsed.data.limit);
      return result;
    });
  }
}
