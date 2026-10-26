import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,stat} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {loadComponents,affectedComponents,ownerOf,componentImports,unmappedEngineeringInputs,createOutputRoot} from '../components.mjs';

const directory=dirname(fileURLToPath(import.meta.url));
const actual=resolve(directory,'../..');
const candidate=actual;
const catalog=await loadComponents(candidate);
const imports=await componentImports(catalog,actual);
const plan=(...files)=>affectedComponents(catalog,files,imports.imports);

test('native builder and candidate tooling select Native plus actual dependents',()=>{
 for(const file of ['scripts/build-native-v2.mjs','scripts/prepare-client-candidate.mjs']){
  const p=plan(file);assert(p.direct.includes('native-client'));assert(p.affected.includes('web'));assert(p.affected.includes('site'));assert.deepEqual(p.unclassified,[]);
 }
});
test('shared check and setup entrypoints select the complete component set',()=>{
 for(const file of ['scripts/check.mjs','scripts/setup-development.mjs','scripts/checks/runner.mjs'])assert.equal(plan(file).affected.length,catalog.components.length);
});
test('declared configuration inputs participate in ownership and propagation',()=>{
 assert.equal(ownerOf(catalog,'scripts/serve-product.mjs'),'web');assert(plan('scripts/serve-product.mjs').affected.includes('site'));
 assert.equal(ownerOf(catalog,'scripts/test/capsule-lease-independent-review.test.mjs'),'web');
});
test('root tools and shared UI imports are read as actual source edges',async()=>{
 assert(imports.imports.some(e=>e.source==='scripts/build-native-v2.mjs'&&e.target==='scripts/release-identifiers.mjs'));
 assert(imports.imports.some(e=>e.source.startsWith('tools/qa/operations-read-renewal/')));
 const fixture=await mkdtemp(join(tmpdir(),'relative-import-'));await mkdir(join(fixture,'components'),{recursive:true});await mkdir(join(fixture,'scripts'),{recursive:true});
 await writeFile(join(fixture,'components/example.mjs'),"import '../scripts/check.mjs';\n");
 const graph=await componentImports(catalog,fixture);assert(graph.imports.some(e=>e.source==='components/example.mjs'&&e.target==='scripts/check.mjs'));
});
test('unmapped engineering code and configuration fail classification',()=>{
 for(const file of ['tools/new-service-adapter.mjs','docs/unknown-contract.json'])assert.deepEqual(unmappedEngineeringInputs(plan(file)),[file]);
 const retired='experiments/retired/tool.mjs',unknown='tools/new-service-adapter.mjs';
 assert.deepEqual(unmappedEngineeringInputs(plan(retired,unknown),[retired]),[unknown]);
});
test('ordinary documentation may intentionally produce an empty matrix',()=>{
 const p=plan('docs/operator-notes.md','docs/architecture-view.html','README.md');assert.deepEqual(p.affected,[]);assert.deepEqual(unmappedEngineeringInputs(p),[]);
 const originals=plan('originals/conversations/discussion.jsonl','docs/public/publish-manifest.json','WORK_STATUS.md');
 assert.deepEqual(originals.affected,[]);assert.deepEqual(unmappedEngineeringInputs(originals),[]);
 assert.equal(ownerOf(catalog,'docs/technical/native-client.md'),'native-client');
});
test('CLI writes an actionable failed plan and exits nonzero for unmapped source',async()=>{
 const destination=await mkdtemp(join(tmpdir(),'plan-cli-'));const files=join(destination,'files.json'),report=join(destination,'plan.json');
 await writeFile(files,JSON.stringify(['tools/new-service-adapter.mjs']));
 const run=spawnSync(process.execPath,[join(candidate,'scripts/components.mjs'),'plan','--files',files,'--output',report],{cwd:candidate,encoding:'utf8',windowsHide:true});
 assert.notEqual(run.status,0);const data=JSON.parse(await readFile(report,'utf8'));assert.deepEqual(data.blockedInputs,['tools/new-service-adapter.mjs']);
});
test('output creation is new, atomic, and refuses both sources and aliases',async()=>{
 const fixture=await mkdtemp(join(tmpdir(),'output-safety-')),repo=join(fixture,'repository'),source=join(repo,'packages/example'),outside=join(fixture,'external');
 await mkdir(source,{recursive:true});const sentinel=join(source,'keep.txt');await writeFile(sentinel,'original');
 const valid=join(repo,'outputs/first');await createOutputRoot(valid,repo);await writeFile(join(valid,'original-result.json'),'retained');
 await assert.rejects(createOutputRoot(valid,repo),{code:'EEXIST'});
 await assert.rejects(createOutputRoot(join(source,'must-not-create'),repo),/output must use/);
 await assert.rejects(createOutputRoot(repo,repo),/output must use/);
 await assert.rejects(createOutputRoot(fixture,repo),/output must use/);
 await mkdir(outside);const alias=join(outside,'source-alias');await symlink(source,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(createOutputRoot(join(alias,'must-not-create'),repo),/output must use/);
 await createOutputRoot(join(outside,'new-output'),repo);
 assert.equal(await readFile(sentinel,'utf8'),'original');assert.equal(await readFile(join(valid,'original-result.json'),'utf8'),'retained');
 await assert.rejects(stat(join(source,'must-not-create')),{code:'ENOENT'});
});
test('an unknown component does not create a result directory',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'unknown-component-')),output=join(parent,'not-created');
 const run=spawnSync(process.execPath,[join(candidate,'scripts/components.mjs'),'build','--component','not-real','--output',output],{cwd:candidate,encoding:'utf8',windowsHide:true});
 assert.notEqual(run.status,0);assert.match(run.stderr,/Unknown component/);await assert.rejects(stat(output),{code:'ENOENT'});
});
