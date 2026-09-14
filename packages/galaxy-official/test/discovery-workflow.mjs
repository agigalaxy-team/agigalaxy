import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';

export async function verifyDiscoveryWorkflow(database = null, options = {}) {
  const scopes = ['binding', 'consent', 'history', 'notifications', 'data-export'];
  const f = await serviceFixture(scopes, database, options);
  const other = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const unrelated = await serviceFixture(scopes, f.db, { ...options, migrateDatabase: false });
  const api = createApi(f); await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  const post = async (fixture, path, input, status = 200) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.credential }, body: JSON.stringify(input) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const project = (title, functions, technologies, extra = {}) => ({ id: randomUUID(), kind: 'module', title, summary: title + ' — explicitly selected synthetic description', functions, technologies, discoverable: true, ...extra });
  const source = project('本地文档搜索', ['全文搜索', 'PDF 提取'], ['Python']);
  const target = project('文档检索模块', ['全文搜索', '中文分词'], ['Rust'], { sourceUrl: 'https://example.org/modules/search' });
  const hidden = project('没有开启发现', ['全文搜索'], ['Go'], { discoverable: false });
  const stackOnly = project('付款系统', ['发票处理'], ['Python']);
  const publish = async (fixture, projects, expectedRevision, visibility = 'Public') => {
    const statement = { id: randomUUID(), expectedRevision, selfDeclared: { displayName: 'Synthetic participant', projects } };
    const submission = await fixture.authorize(statement, 'profile.publish', { visibility, purpose: visibility === 'Public' ? 'public-profile' : 'operational' });
    await post(fixture, '/v1/profiles/statements', submission); return { ...submission, statement };
  };
  const save = async (fixture, preferences) => {
    const current = await post(fixture, '/v1/discovery/preferences/read', {});
    return post(fixture, '/v1/discovery/preferences/save', { expectedRevision: current.revision, preferences });
  };
  const query = () => post(f, '/v1/discovery/query', { projectId: source.id });
  try {
    await publish(f, [source], 0, 'Private');
    const targetSource = await publish(other, [target, hidden], 0);
    await publish(unrelated, [stackOnly], 0);
    assert.equal((await query()).enabled, false, 'discovery is opt-in');
    await save(f, { enabled: true });
    assert.equal((await query()).items.length, 0, 'candidate has not opted in');
    await save(other, { enabled: true }); await save(unrelated, { enabled: true });
    const found = await query(); assert.equal(found.items.length, 1);
    const card = found.items[0]; assert.equal(card.project.id, target.id);
    assert.deepEqual(card.match.sharedFunctions, ['全文搜索']); assert.equal(card.match.score, 1 / 3);
    assert.deepEqual(card.match.purposes, ['conversation'], 'conversation alone is a valid purpose');
    assert.deepEqual(card.match.differences, { sourceOnlyFunctions: ['pdf 提取'], candidateOnlyFunctions: ['中文分词'], sourceOnlyTechnologies: ['python'], candidateOnlyTechnologies: ['rust'] });
    assert.equal(card.sources[1].statementId, targetSource.statement.id);
    assert.equal(card.sources[1].sourceUrl, target.sourceUrl);
    assert.equal(card.classification, 'self-declared'); assert.equal(card.capabilityVerified, false);
    assert.equal(card.id, (await query()).items[0].id, 'stable card identity for unchanged sources');

    await save(other, { enabled: true, temporary: { contact: 'paused', until: f.now + 10 } });
    assert.equal((await query()).items.length, 0, 'candidate pause takes effect on the next query');
    f.access.now = () => f.now + 10;
    assert.equal((await query()).items.length, 1, 'temporary pause expires exactly at until');
    f.access.now = () => f.now;
    await save(other, { enabled: true });
    await save(f, { enabled: true, temporary: { contact: 'welcome', until: f.now + 10, functions: ['发票处理'] } });
    assert.equal((await query()).items.length, 0, 'temporary focus does not replace the requirement of shared project functions');
    await save(f, { enabled: true, temporary: { contact: 'welcome', until: f.now + 10, purposes: ['recruitment'] } });
    assert.equal((await query()).items.length, 0, 'both contact purposes must agree');
    await save(f, { enabled: true, temporary: { contact: 'paused', until: f.now + 10 } });
    assert.equal((await query()).enabled, false, 'owner pause stops the discovery query');
    const prefs = await save(f, { enabled: true });
    await post(f, '/v1/discovery/preferences/save', { expectedRevision: prefs.revision - 1, preferences: { enabled: false } }, 409);
    const legacy = await f.notifications.preferences(f.actor); delete legacy.settings.discovery;
    await f.notifications.save(f.actor, { expectedRevision: legacy.revision, settings: { ...legacy.settings, invitations: false } });
    assert.equal((await f.discovery.preferences(f.actor)).preferences.enabled, true, 'legacy notification client preserves discovery');
    await save(f, { enabled: true, functions: ['全文搜索'] });
    assert.equal((await f.notifications.preferences(f.actor)).settings.invitations, false, 'discovery update preserves unrelated settings');

    const privateSource = await publish(other, [target], 1, 'Private');
    assert.equal((await query()).items.length, 0, 'private replacement does not resurrect an older public source');
    await other.consents.revoke(other.actor, privateSource.consentId);
    assert.equal((await query()).items.length, 0);
    const restored = await publish(other, [target], 2);
    assert.equal((await query()).items.length, 1);
    await other.consents.revoke(other.actor, restored.consentId);
    assert.equal((await query()).items.length, 0, 'live Consent revocation removes the card');
    await publish(other, [target], 3);
    const exported = await f.dataExport.create(f.actor, { id: randomUUID(), datasets: ['profile-statements', 'notification-preferences'] });
    const profilePage = await f.dataExport.page(f.actor, { id: exported.id, dataset: 'profile-statements' });
    assert.equal(JSON.parse(profilePage.items[0].payload_text).selfDeclared.projects[0].id, source.id);
    const preferencesPage = await f.dataExport.page(f.actor, { id: exported.id, dataset: 'notification-preferences' });
    assert.equal(preferencesPage.items[0].settings.discovery.enabled, true);
    await other.bindings.revoke(other.actor.bindingId, other.actor.subjectId, randomUUID(), null, other.actor);
    assert.equal((await query()).items.length, 0, 'revoked candidate binding is immediately hidden');
    return { sharedFunctionsAcrossStacks: true, sameStackAloneExcluded: true, optIn: true, conversationOnly: true,
      explanationsAndSources: true, temporaryPauseAndExpiry: true, temporaryFocusAndPurposes: true, preferenceCompatibility: true,
      liveVisibilityAndRevocation: true, existingOwnerExport: true, actualHttp: true };
  } finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); if (!database) await f.db.close(); }
}
