import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { builderEventSchema, conformanceChecks, legacyConformanceChecks } from '../src/shared/builders-schema.mjs';
import { reportCoverage } from '../src/shared/conformance-schema.mjs';
test('legacy six-check reports stay partial; v2 requires all seven including Evidence', () => {
  const legacy={kind:'compatibility',id:randomUUID(),builderId:randomUUID(),expectedRevision:1,declarationId:randomUUID(),declarationHash:'a'.repeat(64),
    suite:{name:'Suite',version:'1',sha256:'b'.repeat(64),source:'https://suite.example.org/v1'},observedAt:1,expiresAt:2,
    checks:legacyConformanceChecks.map(id=>({id,status:'pass',detail:'Synthetic report'})),limitations:'Fixture only'};
  const old=builderEventSchema.parse(legacy);
  assert.equal('profile' in old,false);assert.deepEqual(reportCoverage(old).missing,['evidence']);
  assert.equal(builderEventSchema.safeParse({...legacy,profile:'galaxy-conformance/2'}).success,false);
  const complete={...legacy,profile:'galaxy-conformance/2',checks:conformanceChecks.map(id=>({id,status:id==='evidence'?'not-tested':'pass',detail:'Fixture only'}))};
  assert.equal(reportCoverage(builderEventSchema.parse(complete)).complete,true);
  assert.equal(builderEventSchema.safeParse({...complete,checks:[...complete.checks.slice(1),complete.checks[1]]}).success,false);
  assert.equal(builderEventSchema.safeParse({...complete,profile:'galaxy-conformance/3'}).success,false);
  assert.equal(builderEventSchema.safeParse({...complete,profile:undefined}).success,false);
});
