import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=fileURLToPath(new URL('../../../',import.meta.url));

test('shared policy contracts load without database initialization while existing runtime loaders preserve exact policy semantics',async t=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const check=await promisify(execFile)(process.execPath,['--input-type=module','-e',"\n  import assert from 'node:assert/strict';\n  await import('./packages/galaxy-official/src/operations/agentos/query-tools.mjs');\n  const pureBudget=await import('./packages/galaxy-official/src/shared/policies/resource-budget.mjs');\n  const budget=await import('./packages/galaxy-official/src/infrastructure/resource-budgets.mjs');\n  const pureForum=await import('./packages/galaxy-official/src/shared/policies/forum-quota.mjs');\n  const forum=await import('./packages/galaxy-official/src/community/community-forum-policy-v1.mjs');\n  assert.equal(budget.resourceBudgetPolicySchema,pureBudget.resourceBudgetPolicySchema);\n  assert.equal(budget.defaultResourceBudgetPolicy,pureBudget.defaultResourceBudgetPolicy);\n  assert.equal(forum.forumPolicySchema,pureForum.forumPolicySchema);\n  assert.equal(forum.defaultForumPolicy,pureForum.defaultForumPolicy);\n  assert.equal(forum.forumPolicyHash,pureForum.forumPolicyHash);\n  assert.deepEqual(await budget.loadResourceBudgetPolicy(),pureBudget.defaultResourceBudgetPolicy);\n  assert.deepEqual(await forum.loadForumPolicy(),pureForum.defaultForumPolicy);\n  const cloned=await budget.loadResourceBudgetPolicy();cloned.maxQueuedJobsPerSubject++;\n  assert.notEqual(cloned.maxQueuedJobsPerSubject,pureBudget.defaultResourceBudgetPolicy.maxQueuedJobsPerSubject);\n  assert.equal(pureBudget.resourceBudgetPolicySchema.safeParse({...pureBudget.defaultResourceBudgetPolicy,maxQueuedJobsPerSubject:0}).success,false);\n  assert.equal(pureBudget.resourceBudgetPolicySchema.safeParse({...pureBudget.defaultResourceBudgetPolicy,role:'administrator'}).success,false);\n  assert.equal(pureForum.forumPolicySchema.safeParse({...pureForum.defaultForumPolicy,maxBodyCodePoints:0}).success,false);\n  assert.equal(pureForum.forumPolicySchema.safeParse({...pureForum.defaultForumPolicy,role:'administrator'}).success,false);\n  console.log(JSON.stringify({queryImportReady:true,compatibilityExportsIdentical:true,databasePreload:false}));\n "],{cwd:root,env,windowsHide:true,timeout:15000});
 assert.equal(JSON.parse(check.stdout).queryImportReady,true);

 const result=await build({absWorkingDir:root,
  entryPoints:['packages/galaxy-official/src/shared/operations-product-schema.mjs'],
  outfile:resolve(root,'outputs/policy-schema-memory-only.mjs'),bundle:true,platform:'node',format:'esm',
  packages:'external',metafile:true,write:false});
 const paths=Object.keys(result.metafile.inputs).map(path=>path.replaceAll('\\','/'));
 assert(paths.every(path=>path.startsWith('packages/galaxy-official/src/shared/')),
  'Shared validation must not depend on DB/SQL/runtime loaders: '+paths.join(', '));
 assert(paths.some(path=>path.endsWith('/policies/resource-budget.mjs')));
 assert(paths.some(path=>path.endsWith('/policies/forum-quota.mjs')));

 const budget=await import('../src/infrastructure/resource-budgets.mjs');
 const forum=await import("../src/community/community-forum-policy-v1.mjs");
 const directory=await mkdtemp(join(tmpdir(),'galaxy-pure-policy-'));
 const budgetPath=join(directory,'budget.json'),forumPath=join(directory,'forum.json');
 t.after(async()=>{await unlink(budgetPath);await unlink(forumPath);await rmdir(directory);});
 const budgetValue={...budget.defaultResourceBudgetPolicy,maxQueuedJobsPerSubject:33};
 const forumValue={...forum.defaultForumPolicy,maxLinks:7};
 await writeFile(budgetPath,JSON.stringify(budgetValue));await writeFile(forumPath,JSON.stringify(forumValue));
 assert.deepEqual(await budget.loadResourceBudgetPolicy(budgetPath),budgetValue);
 assert.deepEqual(await forum.loadForumPolicy(forumPath),forumValue);
});
