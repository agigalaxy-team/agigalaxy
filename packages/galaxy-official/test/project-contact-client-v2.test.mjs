import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyContactsV2 } from './contacts-v2-workflow.mjs';
import { getProjectContactClient } from '../../galaxy-web/src/project-contact-client.mjs';
import { discoveryToolDefinitions } from '../src/personal-mcp-discovery-v2.mjs';

test('browser coordinator and MCP use actual HTTP/Consent for transfer, recruitment and independent Contact', async () => {
  await verifyContactsV2(null, {
    afterWorkflow: async ({ f, p, alias, request }) => {
      const locals = new Map(),
        runtimes = new Map();
      let lostRecruitment = true;
      function runtime(who) {
        if (runtimes.has(who)) return runtimes.get(who);
        const local = new Map();
        locals.set(who, local);
        const api = {
          endpoint: who.access.endpoint,
          snapshot: () => ({ subjectId: who.actor.subjectId }),
          authorizePayload: (text, { action, objectId, visibility, viewers }) =>
            who.authorize(JSON.parse(text), action, {
              objectId,
              visibility,
              viewers,
              purpose:
                visibility === 'Public' ? 'public-profile' : 'operational',
            }),
          call: async (path, input, options = {}) => {
            const r = await request(
              who,
              path,
              options.method === 'GET' ? null : input,
            );
            if (path === '/v2/recruitment' && lostRecruitment) {
              lostRecruitment = false;
              throw new Error('synthetic response lost after actual commit');
            }
            return r;
          },
        };
        const value = {
          api,
          getLocal: async (k) => structuredClone(local.get(k)),
          putLocal: async (k, v) => local.set(k, structuredClone(v)),
        };
        runtimes.set(who, value);
        return value;
      }
      const fc = getProjectContactClient(runtime(f), f.actor.subjectId),
        pc = getProjectContactClient(runtime(p), p.actor.subjectId),
        ft = discoveryToolDefinitions(f, f.actor),
        pt = discoveryToolDefinitions(p, p.actor);
      assert.equal(Object.keys(ft).length, 13);
      assert.equal(ft.galaxy_contact_v2_event.write, true);
      const projectId = randomUUID(),
        document = {
          kind: 'project',
          title: 'Private synthetic transfer',
          summary: 'private original detail',
          functions: ['table-extraction'],
          discoverable: false,
        };
      await fc.submit(
        'project',
        { kind: 'create', projectId, expectedRevision: 0, document },
        { confirmed: true },
      );
      assert.equal(
        (await pt.galaxy_project_v2_query.run({})).items.some(
          (x) => x.projectId === projectId,
        ),
        false,
      );
      const transferId = randomUUID();
      await fc.submit(
        'project',
        {
          kind: 'offer-transfer',
          projectId,
          expectedRevision: 1,
          transferId,
          toSubjectId: p.actor.subjectId,
        },
        { viewers: [p.actor.subjectId], confirmed: true },
      );
      const pending = (await pt.galaxy_project_v2_query.run({})).items.find(
        (x) => x.projectId === projectId,
      );
      assert.equal(pending.document, null);
      assert.equal(pending.management.transfers[0].transferId, transferId);
      assert.equal(pending.permissions.manage, false);
      await request(alias, '/v2/projects/' + projectId, null, 404);
      await fc.submit(
        'project',
        { kind: 'cancel-transfer', projectId, expectedRevision: 2, transferId },
        { confirmed: true },
      );
      assert.equal(
        (await pt.galaxy_project_v2_query.run({})).items.some(
          (x) => x.projectId === projectId,
        ),
        false,
        'cancelled offer not surfaced as an active management role',
      );
      const shared = await fc.submit(
        'project',
        {
          kind: 'revise',
          projectId,
          expectedRevision: 3,
          patch: { ...document, discoverable: true },
        },
        { visibility: 'Public', confirmed: true },
      );
      const secondTransfer = randomUUID();
      await fc.submit(
        'project',
        {
          kind: 'offer-transfer',
          projectId,
          expectedRevision: shared.revision,
          transferId: secondTransfer,
          toSubjectId: p.actor.subjectId,
        },
        { viewers: [p.actor.subjectId], confirmed: true },
      );
      const incoming = await pt.galaxy_project_v2_get.run({ projectId });
      assert.equal(incoming.document.summary, document.summary);
      await pc.submit(
        'project',
        {
          kind: 'accept-transfer',
          projectId,
          expectedRevision: incoming.revision,
          transferId: secondTransfer,
        },
        { visibility: 'Public', confirmed: true },
      );
      assert.equal(
        (await pt.galaxy_project_v2_get.run({ projectId })).ownerId,
        p.actor.subjectId,
      );
      assert.equal(
        (await ft.galaxy_project_v2_query.run({})).items.some(
          (x) => x.projectId === projectId,
        ),
        false,
      );

      const publicId = randomUUID();
      await fc.submit(
        'project',
        {
          kind: 'create',
          projectId: publicId,
          expectedRevision: 0,
          document: {
            ...document,
            title: 'Real client help source',
            discoverable: true,
          },
        },
        { visibility: 'Public', confirmed: true },
      );
      const prefs = await f.discovery.preferences(f.actor);
      await f.discovery.save(f.actor, {
        expectedRevision: prefs.revision,
        preferences: { enabled: true },
      });
      const recruitmentId = randomUUID(),
        event = {
          kind: 'create',
          recruitmentId,
          projectId: publicId,
          expectedRevision: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          document: {
            title: 'Synthetic role',
            role: 'Parser collaborator',
            summary: 'Discuss parsing',
            functions: ['table-extraction'],
            contactSubjectId: f.actor.subjectId,
          },
        };
      let unknown;
      try {
        await fc.submit('recruitment', event, {
          visibility: 'Public',
          confirmed: true,
        });
        assert.fail('response must be lost');
      } catch (e) {
        unknown = e;
        assert.equal(e.resultUnknown, true);
      }
      assert.equal((await fc.pending()).length, 1);
      assert.equal(
        (await fc.reconcile(unknown.operationId)).current.recruitmentId,
        recruitmentId,
      );
      const retried = await fc.reconcile(unknown.operationId, {
        retry: true,
        confirmed: true,
      });
      assert.equal(retried.replayed, true);
      assert.equal((await fc.pending()).length, 0);
      assert.equal(
        (
          await f.db.query(
            'SELECT count(*)::int n FROM recruitment_events WHERE recruitment_id=$1',
            [recruitmentId],
          )
        ).rows[0].n,
        1,
      );
      const stop = {
        kind: 'pause',
        operationId: randomUUID(),
        recruitmentId,
        projectId: publicId,
        expectedRevision: 1,
      };
      const paused = await ft.galaxy_recruitment_v2_event.run(
        await f.authorize(stop, 'recruitment.write', {
          objectId: stop.operationId,
        }),
      );
      assert.equal(paused.state, 'paused');
      const query = {
        context: {
          kind: 'ephemeral',
          title: 'Client contact',
          functions: ['table-extraction'],
        },
        purposes: ['conversation'],
      };
      const opportunity = (
        await pt.galaxy_discovery_v2_query.run(query)
      ).items.find((x) => x.projectId === publicId);
      assert.ok(opportunity);
      const detail = await pt.galaxy_discovery_v2_detail.run({
        ...query,
        opportunityRef: opportunity.opportunityRef,
      });
      assert.deepEqual(
        detail.opportunity.opportunityRef,
        opportunity.opportunityRef,
      );
      const count = (
        await f.db.query('SELECT count(*)::int n FROM task_requests')
      ).rows[0].n;
      const sent = await pc.submit(
        'contact',
        {
          kind: 'send',
          contactId: randomUUID(),
          expectedRevision: 0,
          recipientId: f.actor.subjectId,
          purpose: 'conversation',
          context: query.context,
          opportunityRef: opportunity.opportunityRef,
          note: 'Independently willing to discuss',
          roomTitle: 'Independent client contact',
        },
        { viewers: [f.actor.subjectId], confirmed: true },
      );
      assert.equal(sent.state, 'sent');
      assert.equal(sent.roomId, null);
      const received = await ft.galaxy_contact_v2_get.run({
        contactId: sent.contactId,
      });
      const response = {
        kind: 'accept',
        operationId: randomUUID(),
        contactId: sent.contactId,
        expectedRevision: received.revision,
        note: 'I independently agree',
      };
      const accepted = await ft.galaxy_contact_v2_event.run(
        await f.authorize(response, 'contact.write', {
          objectId: response.operationId,
          viewers: [p.actor.subjectId],
        }),
      );
      assert.equal(accepted.state, 'accepted');
      assert.equal(accepted.roomId, sent.contactId);
      assert.equal(
        (await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0]
          .n,
        count,
      );
    },
  });
});

test('unknown retry is never rebound to another identity and a later rejection does not erase the original locator', async () => {
  const subjectId = 'GUID' + 'A'.repeat(28),
    records = new Map();
  let active = subjectId,
    calls = 0;
  const runtime = {
    api: {
      endpoint: 'https://synthetic.example.org',
      snapshot: () => ({ subjectId: active }),
      authorizePayload: async (payloadJson) => ({
        consentId: randomUUID(),
        payloadJson,
      }),
      call: async (path, input, options = {}) => {
        calls++;
        if (options.method === 'GET') return { projectId: id, revision: 1 };
        if (calls === 1) throw new Error('lost response');
        throw Object.assign(new Error('project_owner_required'), {
          status: 403,
          outcome: 'rejected',
        });
      },
    },
    getLocal: async (k) => structuredClone(records.get(k)),
    putLocal: async (k, v) => records.set(k, structuredClone(v)),
  };
  const id = randomUUID(),
    client = getProjectContactClient(runtime, subjectId);
  await assert.rejects(
    client.submit(
      'project',
      {
        kind: 'create',
        projectId: id,
        expectedRevision: 0,
        document: {
          kind: 'module',
          title: 'x',
          summary: 'x',
          functions: ['x'],
        },
      },
      { confirmed: true },
    ),
    (e) => e.resultUnknown,
  );
  const pending = (await client.pending())[0];
  active = 'GUID' + 'B'.repeat(28);
  await assert.rejects(
    client.reconcile(pending.operationId, { retry: true, confirmed: true }),
    /身份/,
  );
  assert.equal(calls, 1);
  active = subjectId;
  await assert.rejects(
    client.reconcile(pending.operationId, { retry: true, confirmed: true }),
    (e) => e.resultUnknown && e.status === 403,
  );
  assert.equal((await client.pending())[0].operationId, pending.operationId);
});
