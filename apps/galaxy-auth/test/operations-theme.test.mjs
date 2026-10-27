import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildOperationsTheme} from '../operations/build-theme.mjs';

test('management theme keeps native forms and gives changed resources path-level versions',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'galaxy-operations-theme-'));
 try{
  await mkdir(path.join(root,'parent/themes/galaxy/login'),{recursive:true});
  await writeFile(path.join(root,'parent/manifest.json'),JSON.stringify({resourceVersion:'parent-version'}));
  await writeFile(path.join(root,'parent/themes/galaxy/login/template.ftl'),'<#macro registrationLayout><html><head><script type="module" src="${url.resourcesPath}/js/search-entry.js?v=parent"></script></head><body class="old">old public navigation</body></html></#macro>');
  const built=await buildOperationsTheme({authRoot:path.join(root,'parent'),outputRoot:path.join(root,'candidate')});
  const template=await readFile(path.join(built.output,'template.ftl'),'utf8'),properties=await readFile(path.join(built.output,'theme.properties'),'utf8');
  assert.ok(template.includes('<#nested "form">'));assert.ok(template.includes('${url.loginAction}'));
  assert.equal(template.includes('old public navigation'),false);assert.equal(template.includes('search-entry.js'),false);
  for(const [kind,ext] of [['css','css'],['js','js']]){
   const file='operations-login.'+built.resourceVersion+'.'+ext;
   assert.ok(properties.includes(kind+'/'+file));assert.ok((await readFile(path.join(built.output,'resources',kind,file),'utf8')).length>0);
  }
  assert.ok((await readFile(path.join(built.output,'resources/js/operations-login.'+built.resourceVersion+'.js'),'utf8')).includes('restart.href'));
 }finally{await rm(root,{recursive:true,force:true});}
});
