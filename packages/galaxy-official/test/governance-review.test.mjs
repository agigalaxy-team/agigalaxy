import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/database.mjs';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewedGovernanceFixture,verifyReviewedGovernanceWorkflow } from './governance-review-workflow.mjs';
import { prepareGovernanceBundle,loadGovernanceForRuntime } from '../src/operations/governance-review.mjs';
test('independent governance review binds exact configuration, key roles and monotonic runtime history',async()=>{
  const db=new PGlite();try{await migrate(db);await verifyReviewedGovernanceWorkflow(db);}finally{await db.close();}
});
test('reviewed bundle can be selected by runtime; pilot rejects unsigned nonempty configuration',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-governance-review-'));
  try{
    const f=await reviewedGovernanceFixture(),configurationPath=join(directory,'source.json'),reviewPath=join(directory,'signatures.json'),authoritiesPath=join(directory,'authorities.json');
    for(const [path,value] of [[configurationPath,f.configuration],[reviewPath,f.envelope],[authoritiesPath,f.authorities]])await writeFile(path,JSON.stringify(value));
    const output=join(directory,'prepared');
    const receipt=await prepareGovernanceBundle({configurationPath,reviewPath,authoritiesPath,directory:output,endpoint:f.endpoint,now:f.now});assert.equal(receipt.activated,false);
    const loaded=await loadGovernanceForRuntime({configurationPath:join(output,'governance.json'),reviewPath:join(output,'review.json'),authoritiesPath,environment:'pilot',endpoint:f.endpoint,now:f.now});
    assert.equal(loaded.review.changeId,f.change.changeId);assert.deepEqual(loaded.configuration.auditReaderIds,f.configuration.auditReaderIds);
    await assert.rejects(loadGovernanceForRuntime({configurationPath,environment:'pilot',endpoint:f.endpoint}),/independent review/);
    assert.equal((await loadGovernanceForRuntime({configurationPath,environment:'integration',endpoint:f.endpoint})).review,null);
    await assert.rejects(prepareGovernanceBundle({configurationPath,reviewPath,authoritiesPath,directory:output,endpoint:f.endpoint,now:f.now}));
    assert.equal(JSON.parse(await readFile(join(output,'prepared.json'),'utf8')).changeId,f.change.changeId);
  }finally{await rm(directory,{recursive:true,force:true});}
});
