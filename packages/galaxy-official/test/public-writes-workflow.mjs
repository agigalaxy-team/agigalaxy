import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CommunityAccountRegistry } from '../src/community-accounts.mjs';
import { PublicWriteService } from '../src/public-writes.mjs';
import { accountQuotaMigrationSql } from '../src/infrastructure/account-quota-schema-v2.mjs';
import { migrate, transaction } from '../src/database.mjs';
import { digest } from '../src/shared/digest.mjs';

// All identities and account facts here are synthetic database fixtures.
// Real OIDC claim verification is covered separately in oidc-login.test.mjs.
export async function verifyPublicWrites(db, { migrateDatabase = true, concurrency = true, runtimeDb = db } = {}) {
  if (migrateDatabase) await migrate(db);
  if (!(await db.query("SELECT to_regclass('community_accounts') AS table_name")).rows[0].table_name) {
    if (db.exec) await db.exec(accountQuotaMigrationSql); else await db.query(accountQuotaMigrationSql);
  }
  let clock = Date.parse('2026-09-13T12:00:00Z') / 1000;
  const endpoint = 'https://official.example.org', issuer = 'https://issuer.example.org';
  const access = { endpoint, now: () => clock, runAuthorized: (_actor, _scope, fn) => transaction(runtimeDb, fn) };
  const accounts = new CommunityAccountRegistry(access, [{ describe: () => ({ issuer, clientId: 'synthetic' }) }]);
  const service = new PublicWriteService(access, accounts);
  const owners = [randomUUID(), randomUUID(), randomUUID()];
  async function associate(subjectId, externalSubject, verified) {
    const bindingId = randomUUID(), challengeId = randomUUID(), linkId = randomUUID();
    await db.query("INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,'synthetic','{}')", [subjectId]);
    await db.query("INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1,$2,'{}',$3,'2099-01-01')",
      [challengeId, subjectId, randomUUID()]);
    await db.query("INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,'synthetic',$4,'[]','synthetic','2099-01-01')",
      [bindingId, subjectId, challengeId, endpoint]);
    await db.query("INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature) VALUES($1,$2,$3,$4,'synthetic',$5,$6,'synthetic','{}',$7,'synthetic')",
      [linkId, subjectId, bindingId, endpoint, issuer, externalSubject, digest('{}')]);
    if (verified) await transaction(db, conn => accounts.linkVerifiedWithin(conn, {
      subjectId, linkId, endpoint, issuer, externalSubject, verifiedAt: clock, verificationMethod: 'email',
    }));
    return { subjectId, bindingId };
  }
  const one = await associate(owners[0], 'same-real-account-fixture', true);
  const two = await associate(owners[1], 'same-real-account-fixture', true);
  const unverified = await associate(owners[2], 'other-unverified-fixture', false);
  assert.equal((await service.status(one)).accountId, (await service.status(two)).accountId);
  assert.equal((await service.status(unverified)).accountVerified, false);
  const op = (kind, extras = {}) => ({ kind, operationId: randomUUID(), payloadHash: digest(randomUUID()), ...extras });
  const consume = (actor, input) => transaction(runtimeDb, conn => service.consumeWithin(conn, actor, input));
  await assert.rejects(consume(unverified, op('task')), { code: 'account_verification_required' });
  const first = op('task');
  assert.equal((await consume(one, first)).used, 1);
  const candidates = [op('task'), op('task')];
  const results = concurrency ? await Promise.allSettled(candidates.map((input, i) => consume(i ? one : two, input)))
    : [await consume(two, candidates[0]).then(value => ({status:'fulfilled',value})),
      await consume(one, candidates[1]).then(value => ({status:'fulfilled',value}),reason=>({status:'rejected',reason}))];
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'community_quota_exceeded');
  assert.equal((await consume(two, first)).used, 2, 'another GUID retries same operation without a second charge');
  await assert.rejects(consume(one, { ...first, payloadHash: digest('changed') }), { code: 'public_write_conflict' });
  const failed = op('comment');
  await assert.rejects(transaction(db, async conn => {
    await service.consumeWithin(conn, one, failed); throw new Error('synthetic business insert failed');
  }), /business insert failed/);
  assert.equal((await service.status(one)).quotas.find(q=>q.category==='comment').used, 0);
  for (let i=0; i<19; i++) await consume(i%2 ? one:two, op('comment'));
  const lastComment = op('comment');
  assert.equal((await consume(two, lastComment)).used, 20);
  await assert.rejects(consume(one, op('comment')), { code:'community_quota_exceeded' });
  const restarted = new PublicWriteService(access, new CommunityAccountRegistry(access, [{describe:()=>({issuer,clientId:'synthetic'})}]));
  assert.equal((await transaction(db,conn=>restarted.consumeWithin(conn,one,lastComment))).used,20);
  const taskId = randomUUID(), recipientId = 'synthetic-other-recipient';
  await consume(one, op('invitation',{taskId,recipientId}));
  await assert.rejects(consume(two, op('invitation',{taskId:randomUUID(),recipientId})), {code:'invitation_cooldown'});
  await transaction(db,conn=>service.markInvitationRespondedWithin(conn,{taskId,recipientId}));
  await consume(two,op('invitation',{taskId,recipientId}));
  clock += 86400;
  assert.equal((await consume(one,op('task'))).used,1,'UTC day resets, not credential refresh');
  clock += 7*86400;
  assert.equal((await service.status(one)).quotas[0].tier,'new','age without real interaction is insufficient');
  await transaction(db,conn=>accounts.recordInteractionWithin(conn,{subjectId:one.subjectId,counterpartyId:two.subjectId,
    sourceId:randomUUID(),sourceKind:'accepted-participation'}));
  assert.equal((await service.status(one)).quotas[0].tier,'new','self-account interaction cannot upgrade');
  await transaction(db,conn=>accounts.recordInteractionWithin(conn,{subjectId:one.subjectId,counterpartyId:unverified.subjectId,
    sourceId:randomUUID(),sourceKind:'accepted-participation'}));
  assert.equal((await service.status(two)).quotas[0].limit,10);
  const id = (await service.status(one)).accountId;
  await db.query("UPDATE community_accounts SET restricted_until=$2,restriction_reason='synthetic adjudicated limit' WHERE id=$1",
    [id,new Date((clock+3600)*1000).toISOString()]);
  await assert.rejects(consume(one,op('task')),{code:'community_restricted'});
  // Re-linking the same provider subject retains the original account and its ledger.
  const again = await associate(randomUUID(),'same-real-account-fixture',true);
  assert.equal((await service.status(again)).accountId,id);
  await assert.rejects(consume(again,op('task')),{code:'community_restricted'});
  return { groupsSharedAcrossGuids:true, concurrentQuota:concurrency, rollback:true,
    durableReplay:true, invitationCooldown:true, promotionRequiresOtherAccount:true, relinkPreservesRestriction:true };
}
