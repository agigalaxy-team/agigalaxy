import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTaskCommentsV2 } from './task-comments-v2-workflow.mjs';
import { createBrowserClient } from '../src/browser-client.mjs';
import { createTaskCommentClient } from '../../galaxy-web/src/task-comment-client.mjs';
import { commentToolDefinitions } from '../src/personal-mcp-comments-v2.mjs';
import { digest } from '../src/shared/digest.mjs';

test(
  'comment browser client uses actual signed HTTP, exact ACK recovery and explicit private report audience',
  { timeout: 120000 },
  async () => {
    await verifyTaskCommentsV2({
      afterWorkflow: async ({
        f,
        moderator,
        clock,
        task,
        comments,
        governance,
        localEndpoint,
      }) => {
        const records = new Map(),
          getLocal = async (k) => structuredClone(records.get(k)),
          putLocal = async (k, v) => records.set(k, structuredClone(v));
        let loseConsent = false,
          loseComment = false,
          offlineComment = false,
          consentPosts = 0,
          commentPosts = 0;
        const browser = createBrowserClient({
          endpoint: f.bindings.endpoint,
          trustedKeys: f.bindings.trustedKeys,
          sign: f.signForTest,
          now: () => clock.now,
          fetch: async (url, options) => {
            const path = new URL(url).pathname;
            if (path === '/v1/consents') {
              consentPosts++;
              const signed = JSON.parse(options.body).signedIntent;
              assert.ok(
                [...records.values()].some(
                  (x) => x?.active?.prepared?.signedIntent === signed,
                ),
                'exact signed Consent stored before its first send',
              );
            }
            if (path === '/v2/comments') {
              commentPosts++;
              if (offlineComment) {
                offlineComment = false;
                throw new Error('synthetic offline before original comment');
              }
            }
            const response = await fetch(localEndpoint + path, options);
            if (path === '/v1/consents' && loseConsent) {
              loseConsent = false;
              assert.equal(response.status, 200);
              throw new Error('synthetic lost Consent ACK');
            }
            if (path === '/v2/comments' && loseComment) {
              loseComment = false;
              assert.equal(response.status, 200);
              throw new Error('synthetic lost comment ACK');
            }
            return response;
          },
        });
        const scopes = ['binding', 'consent', 'assistance', 'moderation'],
          publicKeyPem = f.genesis.genesisProof.publicKeyPem,
          deviceId = crypto.randomUUID();
        const upgrade = {
          version: 2,
          kind: 'bootstrap',
          operationId: crypto.randomUUID(),
          subjectId: f.actor.subjectId,
          expectedEpoch: 0,
          previousEventHash: null,
          signerKeyId: digest(publicKeyPem),
          genesisProof: f.genesis.genesisProof,
          newDevice: {
            deviceId,
            publicKeyPem,
            scopes: ['manage-identity', ...scopes],
          },
        };
        const challenge = await f.identityControl.challenge(upgrade),
          signature = await f.signForTest(
            challenge.challenge,
            'galaxy-identity-control-v2+jws',
          );
        await f.identityControl.commit({
          operationId: upgrade.operationId,
          controllerSignature: signature,
          newDeviceProof: signature,
        });
        const connect = () =>
          browser.connect(
            {
              subjectId: f.actor.subjectId,
              genesisProof: f.genesis.genesisProof,
              installationId: crypto.randomUUID(),
              scopes,
              control: { deviceId, keyId: digest(publicKeyPem), epoch: 1 },
            },
            { confirmed: true },
          );
        const helper = () =>
          createTaskCommentClient({
            api: browser,
            getLocal,
            putLocal,
            subjectId: f.actor.subjectId,
            taskId: task.taskId,
            now: () => clock.now,
          });
        const payload = (body) => ({
          schemaVersion: 2,
          id: crypto.randomUUID(),
          commentId: crypto.randomUUID(),
          taskId: task.taskId,
          expectedRevision: 0,
          kind: 'create',
          body,
          visibility: 'inherit-task',
          replyTo: null,
        });
        try {
          await connect();
          let client = helper();
          const first = await client.prepare(
            'comment',
            payload('Browser actual parser question'),
            { visibility: 'Public' },
          );
          assert.equal(records.size, 0);
          assert.equal(consentPosts, 0);
          await assert.rejects(client.execute(first), /确认/);
          loseConsent = true;
          await assert.rejects(
            client.execute(first, { confirmed: true }),
            /lost Consent ACK/,
          );
          assert.equal(commentPosts, 0);
          const original = [...records.values()][0].active;
          assert.ok(original.prepared.signedIntent);
          browser.disconnect();
          await connect();
          client = helper();
          assert.equal(
            (await client.reconcile(first.operationId)).state,
            'absent',
          );
          const continued = await client.retry(first.operationId, {
            confirmed: true,
          });
          assert.equal(continued.commentId, first.payload.commentId);
          assert.equal(
            consentPosts,
            1,
            'reconnect reuses accepted original Consent',
          );
          assert.equal((await client.pending()).length, 0);
          const second = await client.prepare(
            'comment',
            payload('Distinct browser second question'),
            { visibility: 'Public' },
          );
          loseComment = true;
          await assert.rejects(
            client.execute(second, { confirmed: true }),
            /lost comment ACK/,
          );
          const before = commentPosts;
          assert.equal(
            (await client.reconcile(second.operationId)).state,
            'acknowledged',
          );
          assert.equal(commentPosts, before);
          const stopped = await client.prepare(
            'comment',
            payload('Original late arriving browser question'),
            { visibility: 'Public' },
          );
          offlineComment = true;
          await assert.rejects(
            client.execute(stopped, { confirmed: true }),
            /offline before/,
          );
          const pending = [...records.values()][0].active,
            exact = pending.submission;
          assert.equal(
            (
              await client.stopLocalRetry(stopped.operationId, {
                confirmed: true,
              })
            ).serverCancellationConfirmed,
            false,
          );
          assert.equal(
            JSON.stringify([...records.values()]).includes(
              stopped.payload.body,
            ),
            false,
            'stopped retry clears local original body/signature',
          );
          await assert.rejects(
            client.retry(stopped.operationId, { confirmed: true }),
            /已停止/,
          );
          await browser.call('/v2/comments', exact);
          assert.equal(
            (await client.reconcile(stopped.operationId)).state,
            'acknowledged',
            'an in-flight original may still finish; stop was never server cancellation',
          );
          const actual = await client.get(first.payload.commentId);
          const report = await client.prepare(
            'report',
            {
              schemaVersion: 2,
              id: crypto.randomUUID(),
              target: {
                type: 'task-comment',
                id: actual.commentId,
                revision: actual.revision,
              },
              category: 'review-request',
              summary: '请复核原文与本任务是否相关。',
            },
            { viewers: [moderator.actor.subjectId] },
          );
          const recorded = await client.execute(report, { confirmed: true });
          assert.equal(recorded.reportId, report.operationId);
          assert.equal(
            (await governance.get(moderator.actor, recorded.reportId))
              .canModerate,
            true,
          );
          const tools = commentToolDefinitions(
            { comments, commentGovernance: governance },
            moderator.actor,
          );
          assert.equal(tools.galaxy_comment_submit.write, true);
          assert.equal(
            tools.galaxy_comment_governance_event.scope,
            'moderation',
          );
          const ownCases = await tools.galaxy_comment_governance_query.run(
            tools.galaxy_comment_governance_query.inputSchema.parse({
              commentId: actual.commentId,
            }),
          );
          assert.ok(
            ownCases.items.some((x) => x.reportId === recorded.reportId),
          );
          assert.equal(
            (
              await f.db.query(
                'SELECT count(*)::int n FROM task_comment_events_v2 WHERE id=$1',
                [first.operationId],
              )
            ).rows[0].n,
            1,
          );
        } finally {
          browser.close();
        }
      },
    });
  },
);
