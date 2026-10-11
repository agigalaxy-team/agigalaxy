import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {galaxySkillDiscovery} from '../native-client-installed-host-probe.mjs';

const cwd=resolve(tmpdir(),'galaxy-installed-host-probe-STRUCTURE','workspace');
const expectedPath=join(cwd,'.agents/skills/galaxy/SKILL.md');
const response=(skills,workspace=cwd)=>({id:3,result:{data:[{cwd:workspace,skills,errors:[]}]}});
const skill=(name='galaxy',path=expectedPath)=>({name,path,description:'Synthetic skill metadata',scope:'repo',enabled:true});

test('actual skills/list shape identifies the named candidate Skill at its copied path',()=>{
 assert.deepEqual(galaxySkillDiscovery(response([skill()]),cwd),{
  skillsListed:true,galaxySkillFound:true,galaxySkillEvidence:[{name:'galaxy',path:expectedPath,expectedPath}]
 });
});

test('a galaxy-named temporary cwd with no skills is not discovery',()=>{
 assert.equal(JSON.stringify(response([])).includes('galaxy'),true,'original substring matcher false-positive fixture');
 assert.deepEqual(galaxySkillDiscovery(response([]),cwd),{skillsListed:true,galaxySkillFound:false,galaxySkillEvidence:[]});
});

test('other Skill names or descriptions cannot substitute for Galaxy',()=>{
 const other={...skill('other'),description:'galaxy collaboration'},prefixed=skill('galaxy-helper'),caseChanged=skill('Galaxy');
 for(const entry of [other,prefixed,caseChanged])assert.equal(galaxySkillDiscovery(response([entry]),cwd).galaxySkillFound,false);
});

test('the right name at another path or a relative path does not prove candidate loading',()=>{
 for(const path of [join(cwd,'another-copy/galaxy/SKILL.md'),join(cwd,'.agents/skills/galaxy/README.md'),'.agents/skills/galaxy/SKILL.md']){
  const result=galaxySkillDiscovery(response([skill('galaxy',path)]),cwd);
  assert.equal(result.galaxySkillFound,false);assert.deepEqual(result.galaxySkillEvidence,[]);
 }
});

test('a different response workspace cannot supply evidence for the requested workspace',()=>{
 assert.equal(galaxySkillDiscovery(response([skill()],resolve(cwd,'../other-workspace')),cwd).galaxySkillFound,false);
 assert.equal(galaxySkillDiscovery(response([skill()],'.'),cwd).galaxySkillFound,false);
});

test('absolute paths normalize dot segments and directory separators before matching',()=>{
 const path=expectedPath.replace('galaxy'+(process.platform==='win32'?'\\':'/'),'galaxy'+(process.platform==='win32'?'\\':'/')+'..'+(process.platform==='win32'?'\\':'/')+'galaxy'+(process.platform==='win32'?'\\':'/'));
 const normalized=galaxySkillDiscovery(response([skill('galaxy',path)],cwd+ '/.'),cwd);
 assert.equal(normalized.galaxySkillFound,true);assert.equal(normalized.galaxySkillEvidence[0].expectedPath,expectedPath);
});

test('RPC errors and malformed result structures cannot claim a Skill was discovered',()=>{
 for(const value of [null,{}, {error:{code:-32603},result:response([skill()]).result},
  {result:{data:null}},{result:{data:{skills:[skill()]}}},{result:{data:[null,{cwd,skills:{}},{cwd,skills:[null,{name:'galaxy',path:17}]}]}}]){
  const result=galaxySkillDiscovery(value,cwd);assert.equal(result.galaxySkillFound,false);assert.deepEqual(result.galaxySkillEvidence,[]);
 }
 assert.equal(galaxySkillDiscovery({error:{code:-32603}},cwd).skillsListed,false);
});
