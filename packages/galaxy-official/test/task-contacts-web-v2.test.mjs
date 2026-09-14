import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import {
  taskDraft,
  publicationFromDraft,
} from '../../galaxy-web/src/task-bounty-client.mjs';
import {
  createTaskContactClient,
  contactCandidates,
} from '../../galaxy-web/src/task-contact-client.mjs';

test(
  'Task contact browser: real signed HTTP, lost ACK/reentry, independent recipients and current-member room decisions',
  { timeout: 120000 },
  async () => {
    const now = Math.floor(Date.now() / 1000),
      endpoint = 'https://official.example.org';
    const issuer = await oidcProviderFixture(
      [endpoint + '/v1/identity/callback/fixture'],
      { emailVerified: true },
    );
    let f, api;
    const runtimes = [];
    try {
      const provider = await createOidcLoginProvider({
        id: 'fixture',
        name: 'Synthetic isolated OIDC',
        issuer: issuer.issuer,
        clientId: 'galaxy-fixture',
        redirectUri: endpoint + '/v1/identity/callback/fixture',
        allowLoopbackHttp: true,
        now: () => now,
      });
      f = await serviceFixture(browserScopes, null, {
        now,
        identityProviders: [provider],
        syntheticCommunityQuota: false,
      });
      api = createApi({ ...f, rateLimit: 3000 });
      await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${api.address().port}`;
      let loseInvite = false,
        loseRoom = false;
      const invites = [],
        consentWrites = [],
        roomWrites = [];
      const wire = async (url, init) => {
        const path = new URL(url).pathname;
        if (/^\/v2\/tasks\/.+\/events$/.test(path))
          invites.push(JSON.parse(init.body));
        if (path === '/v1/consents') consentWrites.push(JSON.parse(init.body));
        if (path === '/v2/chat/rooms/create')
          roomWrites.push(JSON.parse(init.body));
        const response = await fetch(origin + path, init);
        if (loseInvite && /^\/v2\/tasks\/.+\/events$/.test(path)) {
          loseInvite = false;
          assert.equal(response.status, 200);
          throw Error('lost exact invite ACK');
        }
        if (loseRoom && path === '/v2/chat/rooms/create') {
          loseRoom = false;
          assert.equal(response.status, 200);
          throw Error('lost exact room ACK');
        }
        return response;
      };
      const storage = () => {
        const values = new Map();
        return {
          get: async (key) => structuredClone(values.get(key)),
          put: async (key, value) => values.set(key, structuredClone(value)),
        };
      };
      const ownerStore = storage(),
        config = { endpoint, trustedKeys: f.bindings.trustedKeys };
      const make = async (store) => {
        const rt = await createWebRuntime(config, {
          store,
          fetch: wire,
          now: () => now,
        });
        runtimes.push(rt);
        return rt;
      };
      let a = await make(ownerStore);
      const b = await make(storage()),
        c = await make(storage());
      for (const [index, rt] of [a, b, c].entries()) {
        await rt.createIdentity({ confirmed: true });
        await rt.connect({ confirmed: true });
        issuer.setAccount(`synthetic-task-contact-${index}`);
        const login = await rt.api.call('/v1/identity/begin', {
          providerId: 'fixture',
        });
        const callback = await issuer.authorize(login.authorizationUrl);
        assert.equal(
          (await fetch(origin + callback.pathname + callback.search)).status,
          200,
        );
        await rt.confirmAccountLink(login.loginId, { confirmed: true });
      }
      const aid = a.api.snapshot().subjectId,
        bid = b.api.snapshot().subjectId,
        cid = c.api.snapshot().subjectId;
      const draft = taskDraft(
        {
          title: '联系与讨论隔离测试',
          summary: '演示数据，不是生产案例',
          goal: '独立诊断',
          situation: '无失败尝试也可寻求帮助',
          visibility: 'Public',
          intent: 'diagnosis',
        },
        now,
      );
      const published = await a.publishTask(
          publicationFromDraft(draft, [], now),
          { confirmed: true },
        ),
        taskId = published.taskId;
      const read = (rt) =>
        rt.api.call(`/v2/tasks/${taskId}`, null, { method: 'GET' });
      let task = await read(a),
        client = createTaskContactClient(a, taskId);
      assert.equal(task.caseId, null);
      const query = await client.search(task);
      assert.equal(query.length, 1);
      assert.equal(query[0].error, null);
      assert.equal(
        (await read(a)).taskId,
        taskId,
        'empty help lookup never undoes the publication',
      );
      // Explicit opportunity is legitimate without a prior success. Ownership of
      // a request alone never becomes a candidate's performed work.
      const candidates = contactCandidates(
        [
          {
            search: {},
            items: [
              {
                type: 'history',
                ref: { id: taskId, version: 'a'.repeat(64) },
                record: { requesterId: aid },
              },
              {
                type: 'opportunity',
                ref: { id: 'source', version: 'b'.repeat(64) },
                record: {
                  subjectId: bid,
                  participant: { kind: 'person' },
                  displayName: 'New participant',
                },
              },
            ],
          },
        ],
        aid,
      );
      assert.deepEqual(
        candidates.map((candidate) => candidate.subjectId),
        [bid],
      );
      const profile = {
        id: crypto.randomUUID(),
        expectedRevision: 0,
        selfDeclared: {
          displayName: 'Synthetic new collaborator',
          projects: [
            {
              id: crypto.randomUUID(),
              kind: 'module',
              title: '有限诊断',
              summary: '本人明确声明愿意交流，不声明已经核验的能力',
              functions: ['boundary-review'],
              technologies: [],
              discoverable: true,
            },
          ],
        },
      };
      const signedProfile = await b.api.submitAuthorization(
        await b.api.prepareAuthorization(profile, {
          action: 'profile.publish',
          objectId: profile.id,
          visibility: 'Public',
          confirmed: true,
        }),
        { confirmed: true },
      );
      await b.api.call('/v1/profiles/statements', signedProfile);
      await b.api.call('/v1/discovery/preferences/save', {
        expectedRevision: 0,
        preferences: {
          enabled: true,
          purposes: ['conversation', 'collaboration'],
        },
      });
      const sources = await client.search(task, {
        functions: ['boundary-review'],
      });
      assert.equal(
        sources.find((source) => source.type === 'opportunity').error,
        null,
      );
      const actualCandidates = contactCandidates(sources, aid);
      assert.deepEqual(
        actualCandidates.map((candidate) => candidate.subjectId),
        [bid],
      );
      actualCandidates[0].help = '希望你检查边界';
      actualCandidates[0].basis =
        '本人公开声明的功能与这次选择的功能相同，尚未核验实际能力';
      await client.saveSuggestions(actualCandidates, { confirmed: true });
      task = await read(a);
      assert.equal(
        task.contacts.suggestions.items[0].sourceRefs[0].includes(
          actualCandidates[0].sources[0].item.ref.version,
        ),
        true,
      );
      assert.equal(task.contacts.responses.invitations.length, 0);
      assert.equal(task.contacts.responses.applications.length, 0);
      invites.length = 0;
      const batch = await client.prepareInvites([
        { subjectId: bid, note: '仅请检查边界' },
        { subjectId: cid, note: '独立复核流程' },
      ]);
      assert.equal(invites.length, 0);
      loseInvite = true;
      let pending = await client.sendInvites({ confirmed: true });
      assert.equal(pending.items[0].state, 'result-unknown');
      assert.equal(pending.items[1].state, 'queued');
      assert.equal(
        JSON.parse(invites[0].payloadJson).event.eventId,
        batch.items[0].eventId,
      );
      const firstBytes = invites[0].payloadJson,
        firstConsent = invites[0].consentId,
        before = consentWrites.length;
      a.close();
      a = await make(ownerStore);
      await a.connect({ confirmed: true });
      client = createTaskContactClient(a, taskId);
      pending = await client.sendInvites({ confirmed: true });
      assert.deepEqual(
        pending.items.map((item) => item.state),
        ['acknowledged', 'acknowledged'],
        JSON.stringify(
          pending.items.map(({ state, error }) => ({ state, error })),
        ),
      );
      assert.equal(
        invites.length,
        2,
        'accepted first operation is not resent after runtime and component reconstruction',
      );
      assert.equal(
        consentWrites.length,
        before + 1,
        'only the second recipient receives a new exact Consent',
      );
      assert.equal(invites[0].payloadJson, firstBytes);
      assert.equal(invites[0].consentId, firstConsent);
      assert.equal(
        JSON.parse(invites[1].payloadJson).event.eventId,
        batch.items[1].eventId,
      );
      for (const rt of [b, c]) {
        task = await read(rt);
        const invitation = task.contacts.responses.invitations.find(
          (i) => i.recipientId === rt.api.snapshot().subjectId,
        );
        await rt.taskEvent(
          taskId,
          {
            kind: 'invitation-reply',
            expectedTaskVersion: task.version,
            invitationId: invitation.invitationId,
            response: 'interested',
            message: '愿意了解，不是接受任务',
          },
          { confirmed: true, viewers: [aid] },
        );
      }
      task = await read(a);
      assert.equal(task.participations.length, 0);
      const roomPlan = await client.prepareRooms('together', [bid, cid]);
      loseRoom = true;
      let roomBatch = await client.sendRooms({ confirmed: true });
      assert.equal(roomBatch.rooms[0].state, 'result-unknown');
      client = createTaskContactClient(a, taskId);
      roomBatch = await client.sendRooms({ confirmed: true });
      assert.equal(roomWrites.length, 2);
      assert.deepEqual(
        roomWrites[0],
        roomWrites[1],
        'unknown room creation retries exact original room and operation IDs',
      );
      const roomId = roomPlan.rooms[0].input.roomId,
        path = `/v2/chat/rooms/${roomId}`;
      assert.equal(roomBatch.rooms[0].state, 'waiting-for-members');
      assert.equal(roomBatch.rooms[0].invitations[1].state, 'queued');
      assert.deepEqual(
        (await a.api.call(path + '/read', {})).members.map((m) => m.subjectId),
        [aid],
      );
      await assert.rejects(
        b.api.call(path + '/read', {}),
        /chat_access_denied/,
      );
      assert.equal(
        (await createTaskContactClient(b, taskId).rooms()).rooms.length,
        0,
        "Task reference does not reveal another person's room",
      );
      const first = roomBatch.rooms[0].invitations[0];
      await b.api.call(path + '/accept', {
        decisionId: first.decisionId,
        accept: true,
      });
      assert.equal(
        (await client.roomProgress())[0].invitations[0].joined,
        true,
      );
      const refreshed = await client.refreshRoomPlan(roomId);
      assert.equal(
        refreshed.rooms[0].invitations[1].decisionId,
        roomPlan.rooms[0].invitations[1].decisionId,
        'unsent recipient retains original stable batch ID',
      );
      roomBatch = await client.sendRooms({ confirmed: true });
      const second = roomBatch.rooms[0].invitations[1],
        decisions = await a.api.call(path + '/decisions', {});
      assert.equal(
        decisions.decisions.find((d) => d.decisionId === second.decisionId)
          .state,
        'pending',
      );
      await assert.rejects(
        c.api.call(path + '/accept', {
          decisionId: second.decisionId,
          accept: true,
        }),
        /chat_decision_unavailable/,
      );
      await b.api.call(path + '/vote', {
        decisionId: second.decisionId,
        choice: 'approve',
      });
      await c.api.call(path + '/accept', {
        decisionId: second.decisionId,
        accept: true,
      });
      assert.equal((await a.api.call(path + '/read', {})).members.length, 3);
      assert.equal(
        (await createTaskContactClient(c, taskId).rooms()).rooms[0].roomId,
        roomId,
      );
      assert.equal(
        (await read(a)).participations.length,
        0,
        'independent chat membership never auto-confirms participation',
      );
      const anonymous = await (
        await fetch(origin + `/v2/tasks/${taskId}`)
      ).json();
      assert.equal(anonymous.contacts, undefined);
      assert.equal(
        (await a.api.call('/v2/account/quotas', {})).quotas.find(
          (q) => q.category === 'invitation',
        ).used,
        4,
      );
      // A permanently stale operation must not trap the generic Task queue.
      // This same runtime queue is used by invitations, applications and feedback.
      await assert.rejects(
        a.taskEvent(
          taskId,
          {
            kind: 'suggest-contacts',
            expectedTaskVersion: 1,
            state: 'empty',
            items: [],
          },
          { confirmed: true, viewers: [aid] },
        ),
        /task_version_conflict/,
      );
      const stale = await a.getLocal(`task-event:${taskId}`),
        stopPreview = await a.reviewTaskStop(taskId);
      assert.equal(stopPreview.receipt.state, 'absent');
      const stopped = await a.stopTaskOperation(stopPreview, {
        taskId,
        confirmed: true,
      });
      assert.equal(stopped.state, 'stopped-local');
      assert.equal(stopped.serverCancellationConfirmed, false);
      assert.equal(await a.getLocal(`task-event:${taskId}`), null);
      const archived = (await a.stoppedTaskOperations(taskId))[0];
      assert.equal(archived.eventId, stale.eventId);
      assert.equal(archived.payloadHash, stale.payloadHash);
      assert.equal(archived.payloadJson, undefined);
      assert.equal(archived.preparedConsent, undefined);
      task = await read(a);
      await a.taskEvent(
        taskId,
        {
          kind: 'suggest-contacts',
          expectedTaskVersion: task.version,
          state: 'empty',
          items: [],
        },
        { confirmed: true, viewers: [aid] },
      );
      assert.equal(
        (await a.queryStoppedTaskOperation(stale.eventId, { taskId })).receipt
          .state,
        'absent',
      );
      await assert.rejects(
        a.taskEvent(taskId, JSON.parse(stale.payloadJson).event, {
          confirmed: true,
          viewers: [aid],
        }),
        /已停止本机重试/,
      );
    } finally {
      for (const rt of runtimes) rt.close();
      if (api) {
        api.closeAllConnections();
        await new Promise((resolve) => api.close(resolve));
      }
      if (f) await f.db.close();
      await issuer.close();
    }
  },
);
