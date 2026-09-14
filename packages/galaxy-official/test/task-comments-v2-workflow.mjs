import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { createApi } from '../src/http.mjs';
import { taskCommentsV2MigrationSql } from '../src/infrastructure/task-comments-v2-schema.mjs';
import { TaskCommentServiceV2 } from '../src/task-comments-v2.mjs';
import { CommentGovernanceServiceV2 } from '../src/comment-governance-v2.mjs';
import { digest } from '../src/shared/digest.mjs';

export async function verifyTaskCommentsV2({
  database = null,
  repositories,
  migrateDatabase = true,
  adminDatabase,
  afterWorkflow,
} = {}) {
  const endpoint = 'https://official.example.org',
    now = Math.floor(Date.now() / 1000),
    clock = { now },
    scopes = [
      'binding',
      'consent',
      'case-teaser',
      'assistance',
      'moderation',
      'notifications',
      'data-export',
      'data-delete',
    ];
  const issuer = await oidcProviderFixture(
    [endpoint + '/v1/identity/callback/fixture'],
    { emailVerified: true },
  );
  let f, api;
  try {
    const provider = await createOidcLoginProvider({
      id: 'fixture',
      name: 'Synthetic OIDC',
      issuer: issuer.issuer,
      clientId: 'galaxy-fixture',
      redirectUri: endpoint + '/v1/identity/callback/fixture',
      allowLoopbackHttp: true,
      now: () => clock.now,
    });
    const options = {
      now,
      identityProviders: [provider],
      syntheticCommunityQuota: false,
      repositories,
      migrateDatabase,
    };
    f = await serviceFixture(scopes, database, options);
    const admin = adminDatabase ?? f.db;
    if (
      !(
        await admin.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name='task_comments_v2'",
        )
      ).rows.length
    ) {
      if (admin.exec) await admin.exec(taskCommentsV2MigrationSql);
      else await admin.query(taskCommentsV2MigrationSql);
    }
    const second = await serviceFixture(scopes, f.db, {
        ...options,
        migrateDatabase: false,
      }),
      owner = await serviceFixture(scopes, f.db, {
        ...options,
        migrateDatabase: false,
      }),
      moderator = await serviceFixture(scopes, f.db, {
        ...options,
        migrateDatabase: false,
      });
    for (const who of [f, second, owner, moderator])
      who.access.now = () => clock.now;
    const comments = new TaskCommentServiceV2(
      f.access,
      f.assistance.consents,
      f.assistance,
      {
        accounts: f.communityAccounts,
        publicWrites: f.publicWrites,
        inbox: f.inbox,
      },
    );
    assert.ok(comments.accounts?.resolveWithin);
    assert.ok(comments.publicWrites?.consumeWithin);
    const governance = new CommentGovernanceServiceV2(
      f.access,
      comments.consents,
      comments,
      {
        moderatorIds: [moderator.actor.subjectId],
        accounts: f.communityAccounts,
      },
    );
    f.inbox.commentGovernance = governance;
    api = createApi({
      ...f,
      comments,
      commentGovernance: governance,
      rateLimit: 500,
      failureAudit: async () => 'stored',
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + api.address().port;
    const post = async (path, body = {}, who = f) => {
      const r = await fetch(origin + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + who.credential,
        },
        body: JSON.stringify(body),
      });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      return b;
    };
    async function login(who, account) {
      issuer.setAccount(account);
      const started = await post(
          '/v1/identity/begin',
          { providerId: 'fixture' },
          who,
        ),
        cb = await issuer.authorize(started.authorizationUrl);
      const callback = await fetch(origin + cb.pathname + cb.search);
      assert.equal(callback.status, 200);
      const p = await post('/v1/identity/status', { id: started.loginId }, who);
      await post(
        '/v1/identity/confirm',
        {
          id: started.loginId,
          signed: await who.signForTest(
            p.payloadJson,
            'galaxy-identity-link+jws',
          ),
        },
        who,
      );
    }
    const task = async (visibility = 'Public', viewers = []) => {
      const p = {
        operationId: randomUUID(),
        taskId: randomUUID(),
        caseId: null,
        intent: 'proactive-review',
        workContext: {
          goal: 'Review a parser',
          currentSituation: 'No failed history',
          attemptRefs: [],
        },
        title: 'Parser boundary',
        summary: 'Discuss useful approaches',
        visibility,
        collaboration: 'open-assistance',
        enrollmentExpiresAt: now + 3600,
      };
      const envelope = await owner.authorize(p, 'assistance.publish', {
        objectId: p.operationId,
        visibility,
        purpose: visibility === 'Public' ? 'public-profile' : 'operational',
        viewers,
      });
      await owner.assistance.createTask(owner.actor, envelope);
      return p;
    };
    await login(owner, 'synthetic-task-owner');
    const t = await task();
    const draft = (taskId, body = 'Useful parser question') => ({
      schemaVersion: 2,
      id: randomUUID(),
      commentId: randomUUID(),
      taskId,
      expectedRevision: 0,
      kind: 'create',
      body,
      visibility: 'inherit-task',
      replyTo: null,
    });
    const authorization = async (who, p, visibility = 'Public', viewers = []) =>
      who.authorize(p, 'comment.publish', {
        objectId: p.id,
        visibility,
        viewers,
        purpose: visibility === 'Public' ? 'public-profile' : 'operational',
      });
    const blocked = draft(t.taskId);
    await assert.rejects(
      () =>
        comments.submit(f.actor, {
          consentId: randomUUID(),
          payloadJson: JSON.stringify(blocked),
        }),
      (e) => e.code === 'account_verification_required',
    );
    await login(f, 'synthetic-commenter');
    await login(second, 'synthetic-commenter');
    await login(moderator, 'synthetic-independent-handler');
    const a = (await f.publicWrites.status(f.actor)).accountId;
    assert.equal(a, (await f.publicWrites.status(second.actor)).accountId);
    const p = draft(
        t.taskId,
        '报价可以讨论，相关仓库 https://github.com/example/parser 。谢谢，这不是正式验收。',
      ),
      env = await authorization(f, p);
    const created = await post('/v2/comments', env);
    assert.equal(created.state, 'visible');
    assert.equal(created.quota.used, 1);
    const anonymous = await fetch(origin + '/v2/comments/' + p.commentId);
    assert.equal(anonymous.status, 200);
    assert.equal((await anonymous.json()).body, p.body);
    assert.ok(
      (
        await post('/v2/comments/query', { taskId: t.taskId }, owner)
      ).items.some((x) => x.commentId === p.commentId),
    );
    assert.equal((await comments.get(null, p.commentId)).body, p.body);
    assert.equal(
      (await f.assistance.getTask(owner.actor, t.taskId)).state,
      'open',
    );
    await comments.submit(f.actor, env);
    assert.equal(
      (await f.publicWrites.status(second.actor)).quotas.find(
        (q) => q.category === 'comment',
      ).used,
      1,
    );
    const receipt = await post('/v2/comments/receipt', {
      operationId: p.id,
      payloadHash: digest(env.payloadJson),
    });
    assert.equal(receipt.state, 'acknowledged');
    // Seed only the prior count to focus the real last-slot transaction; real
    // verified Account lookup, business write and original receipt are untouched.
    await admin.query(
      "UPDATE community_daily_usage SET used=19 WHERE account_id=$1 AND category='comment'",
      [a],
    );
    const x = draft(t.taskId, 'First concurrent question'),
      y = draft(t.taskId, 'Other concurrent question'),
      xe = await authorization(f, x),
      ye = await authorization(second, y);
    const results = await Promise.allSettled([
      comments.submit(f.actor, xe),
      comments.submit(second.actor, ye),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((r) => r.status === 'rejected').reason.code,
      'community_quota_exceeded',
    );
    assert.equal(
      (await f.publicWrites.status(f.actor)).quotas.find(
        (q) => q.category === 'comment',
      ).used,
      20,
    );
    const replayed = new TaskCommentServiceV2(
      f.access,
      comments.consents,
      f.assistance,
      { accounts: f.communityAccounts, publicWrites: f.publicWrites },
    );
    await replayed.submit(f.actor, env);
    const edit = {
      schemaVersion: 2,
      id: randomUUID(),
      commentId: p.commentId,
      taskId: t.taskId,
      expectedRevision: 1,
      kind: 'edit',
      body: '更正一个错字，仍可报价 https://github.com/example/parser',
      visibility: 'inherit-task',
    };
    await comments.submit(f.actor, await authorization(f, edit));
    assert.equal(
      (await f.publicWrites.status(f.actor)).quotas.find(
        (q) => q.category === 'comment',
      ).used,
      20,
    );
    assert.ok(
      (await f.inbox.query(owner.actor)).items.some(
        (x) => x.object.type === 'task-comment' && x.object.id === p.commentId,
      ),
    );
    // A separate verified Account has its own quota despite using the same IP.
    const reply = draft(t.taskId, '独立回复：我愿意先了解情况。');
    reply.replyTo = { id: p.commentId, revision: 2 };
    await comments.submit(owner.actor, await authorization(owner, reply));
    assert.ok((await comments.get(null, reply.commentId)).replyTo.body);
    assert.equal(
      (await admin.query('SELECT count(*)::int n FROM task_participations'))
        .rows[0].n,
      0,
    );
    const report = {
      schemaVersion: 2,
      id: randomUUID(),
      target: { type: 'task-comment', id: p.commentId, revision: 2 },
      category: 'advertising',
      summary: '需要复核是否与任务有关。',
    };
    const noConfig = new CommentGovernanceServiceV2(
      f.access,
      comments.consents,
      comments,
    );
    const queued = await noConfig.report(
      owner.actor,
      await owner.authorize(report, 'moderation.publish'),
    );
    assert.equal(queued.handlingState, 'awaiting-authorized-handler');
    assert.equal((await comments.get(null, p.commentId)).body, edit.body);
    await assert.rejects(
      () => governance.get(moderator.actor, report.id),
      (e) => e.code === 'not_found',
    );
    const supplement = {
      schemaVersion: 2,
      id: randomUUID(),
      reportId: report.id,
      expectedVersion: 1,
      kind: 'supplement',
      summary: '明确向当前处理者分享：请复核这条评论的相关性。',
    };
    await governance.event(
      owner.actor,
      report.id,
      await owner.authorize(supplement, 'moderation.publish', {
        viewers: [moderator.actor.subjectId],
      }),
    );
    const g = await governance.get(moderator.actor, report.id);
    assert.equal(g.canModerate, true);
    assert.equal(g.source.body, edit.body);
    const ge = async (kind, extra = {}, who = moderator) => {
      const current = await governance.get(who.actor, report.id),
        v = {
          schemaVersion: 2,
          id: randomUUID(),
          reportId: report.id,
          expectedVersion: current.version,
          kind,
          summary: '合成处置说明',
          ...extra,
        };
      return governance.event(
        who.actor,
        report.id,
        await who.authorize(v, 'moderation.publish', {
          viewers:
            who === moderator
              ? current.decisionRecipients
              : [moderator.actor.subjectId],
        }),
      );
    };
    const self = new CommentGovernanceServiceV2(
      f.access,
      comments.consents,
      comments,
      {
        moderatorIds: [owner.actor.subjectId, moderator.actor.subjectId],
        accounts: f.communityAccounts,
      },
    );
    const malicious = {
      schemaVersion: 2,
      id: randomUUID(),
      reportId: report.id,
      expectedVersion: 2,
      kind: 'pause',
      summary: '自裁不得成立',
      until: now + 600,
      rule: 'test/1',
    };
    await assert.rejects(
      async () =>
        self.event(
          owner.actor,
          report.id,
          await owner.authorize(malicious, 'moderation.publish', {
            viewers: [f.actor.subjectId, moderator.actor.subjectId],
          }),
        ),
      (e) => e.code === 'comment_independent_handler_required',
    );
    await ge('pause', { until: now + 600, rule: 'comment-rules/1' });
    assert.equal((await comments.get(null, p.commentId)).body, null);
    assert.equal(
      (await comments.get(null, reply.commentId)).replyTo.body,
      null,
    );
    const pausedInbox = await f.inbox.query(owner.actor);
    assert.equal(
      pausedInbox.items.some(
        (x) => x.object.type === 'task-comment' && x.object.id === p.commentId,
      ),
      false,
    );
    assert.ok(
      pausedInbox.items.some(
        (x) => x.object.type === 'comment-governance' && x.serviceReceipt,
      ),
    );
    assert.equal(
      (await comments.query(null, { taskId: t.taskId, query: '错字' })).items
        .length,
      0,
    );
    await ge('resolve', {
      verdict: 'dismissed',
      reviewDisposition: 'approve',
      rule: 'comment-rules/1',
    });
    assert.equal(
      (await comments.get(null, p.commentId)).body,
      null,
      'resolution does not silently resume a different control action',
    );
    await ge('appeal', {}, f);
    await ge('resume');
    assert.equal((await comments.get(null, p.commentId)).body, edit.body);
    await ge('resolve', {
      verdict: 'dismissed',
      reviewDisposition: 'unchanged',
      rule: 'comment-rules/1',
    });
    const privateTask = await task('Private', [f.actor.subjectId]);
    const privateComment = draft(privateTask.taskId, '受限澄清');
    await comments.submit(
      f.actor,
      await authorization(f, privateComment, 'Private', [
        owner.actor.subjectId,
      ]),
    );
    assert.equal(
      (await comments.get(f.actor, privateComment.commentId)).body,
      privateComment.body,
    );
    await assert.rejects(
      () => comments.get(null, privateComment.commentId),
      (e) => e.status === 404,
    );
    // Capacity test was completed; reset only the synthetic preexisting count to
    // exercise duplicate classification with successful normal submissions.
    await admin.query(
      "UPDATE community_daily_usage SET used=0 WHERE account_id=$1 AND category='comment'",
      [a],
    );
    const ds = [];
    for (let i = 0; i < 3; i++) {
      const d = draft(t.taskId, ' 同样的介绍 https://example.org/docs ');
      ds.push(d);
      const r = await comments.submit(
        i === 1 ? second.actor : f.actor,
        await authorization(i === 1 ? second : f, d),
      );
      assert.equal(r.state, i === 2 ? 'pending-review' : 'visible');
    }
    assert.equal((await comments.get(null, ds[2].commentId)).body, null);
    assert.ok((await comments.get(f.actor, ds[2].commentId)).body);
    assert.equal((await f.publicWrites.status(f.actor)).quotas.find(q=>q.category==='comment').used,3,'accepted pending-review content consumes one public publication');
    for(let n=0;n<4;n++){
      const target=await task('Private',[f.actor.subjectId]);
      const value=draft(target.taskId,`不同问题 ${n}：https://example.org/common-material`);
      const recorded=await comments.submit(f.actor,await authorization(f,value,'Private',[owner.actor.subjectId]));
      assert.equal(recorded.rule.reasons.includes('repeated-link-across-tasks'),n===3);
    }
    const aged=ds[0];await admin.query("UPDATE task_comments_v2 SET created_at=$2::timestamptz-interval '1 second',expires_at=$2::timestamptz+interval '90 days'-interval '1 second' WHERE id=$1",[aged.commentId,new Date((now-86400)*1000).toISOString()]);
    const lateEdit={schemaVersion:2,id:randomUUID(),commentId:aged.commentId,taskId:t.taskId,expectedRevision:1,kind:'edit',body:'Later corrected statement',visibility:'inherit-task'};
    await assert.rejects(async()=>comments.submit(f.actor,await authorization(f,lateEdit)),e=>e.code==='comment_edit_window_closed');
    await comments.submit(f.actor,await authorization(f,{...lateEdit,id:randomUUID(),kind:'correct',reason:'24h之后明确追加更正'}));
    const review={schemaVersion:2,id:randomUUID(),target:{type:'task-comment',id:ds[2].commentId,revision:1},category:'review-request',summary:'Review this held original.'};
    await governance.report(f.actor,await f.authorize(review,'moderation.publish',{viewers:[moderator.actor.subjectId]}));
    const sourceConsent=(await admin.query('SELECT consent_id FROM task_comment_events_v2 WHERE id=$1',[ds[2].id])).rows[0].consent_id;
    await f.consents.revoke(f.actor,sourceConsent);
    const invalidApproval={schemaVersion:2,id:randomUUID(),reportId:review.id,expectedVersion:1,kind:'resolve',summary:'Revoked source cannot reappear.',verdict:'dismissed',reviewDisposition:'approve',rule:'comment-rules/1'};
    const rv=await governance.get(moderator.actor,review.id);assert.equal(rv.canReviewSource,false);
    await assert.rejects(async()=>governance.event(moderator.actor,review.id,await moderator.authorize(invalidApproval,'moderation.publish',{viewers:rv.decisionRecipients})),e=>e.status===403);
    assert.equal((await comments.get(null,ds[2].commentId)).body,null);
    const retract = {
      schemaVersion: 2,
      id: randomUUID(),
      commentId: p.commentId,
      taskId: t.taskId,
      expectedRevision: 2,
      kind: 'retract',
    };
    await comments.submit(f.actor, await authorization(f, retract, 'Private'));
    assert.equal((await comments.get(null, p.commentId)).body, null);
    assert.equal((await comments.get(null, reply.commentId)).body, reply.body);
    assert.equal(
      (await admin.query('SELECT count(*)::int n FROM cases')).rows[0].n,
      0,
    );
    if (afterWorkflow)
      await afterWorkflow({
        f,
        second,
        owner,
        moderator,
        comments,
        governance,
        clock,
        task: t,
        comment: p,
        reply,
        privateComment,
        report,
        admin,
        localEndpoint: origin,
      });
    assert.deepEqual(issuer.failures, []);
    return {
      accountQuota: true,
      exactGovernance: true,
      taskStateIndependent: true,
    };
  } finally {
    if (api) {
      api.closeAllConnections();
      await new Promise((r) => api.close(r));
    }
    if (f && !database) await f.db.close();
    await issuer.close();
  }
}
