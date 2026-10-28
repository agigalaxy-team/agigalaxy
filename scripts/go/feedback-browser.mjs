// Existing Next/Payload view -> BFF -> Go -> original PostgreSQL business table.
// Only loopback, disposable database and a fresh independent headless profile.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';

const origin=new URL(process.env.GALAXY_GO_BROWSER_ORIGIN),api=new URL(process.env.GALAXY_GO_BROWSER_API),cms=new URL(process.env.GALAXY_GO_TEST_CMS_DATABASE_URL);
for(const value of [origin,api])assert(value.protocol==='http:'&&value.hostname==='127.0.0.1'&&value.pathname==='/');
assert(cms.protocol==='postgres:'&&cms.hostname==='127.0.0.1'&&cms.pathname==='/galaxy_go_test_cms');
const cookie=process.env.GALAXY_GO_BROWSER_OPERATOR_COOKIE,match=/^(galaxy-operator-fixture)=([A-Za-z0-9_-]{43})$/.exec(cookie??'');assert(match);
assert(/^[0-9a-f-]{36}$/.test(process.env.GALAXY_GO_BROWSER_FEEDBACK??''));
const directory=await mkdtemp(join(tmpdir(),'galaxy-go-headless-')),log=await open(join(directory,'next.log'),'w');
const app=resolve('apps/galaxy-admin');
const child=spawn(process.execPath,[join(app,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port',origin.port],{cwd:app,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,GALAXY_ADMIN_PUBLIC_ORIGIN:origin.origin,GALAXY_ADMIN_BFF_ORIGIN:api.origin,GALAXY_CMS_DATABASE_URL:cms.href,GALAXY_CMS_SECRET:randomBytes(32).toString('hex'),GALAXY_CMS_DEV_PUSH:'true',NEXT_TELEMETRY_DISABLED:'1'}});
let browser,page;const errors=[];
try{
 const deadline=Date.now()+120000;
 for(;;){if(child.exitCode!==null)throw Error('isolated Next process stopped; log: '+join(directory,'next.log'));try{const response=await fetch(origin.origin+'/admin/login',{redirect:'manual',signal:AbortSignal.timeout(10000)});if(response.status<500)break;}catch{}if(Date.now()>deadline)throw Error('isolated Next startup timeout; log: '+join(directory,'next.log'));await new Promise(r=>setTimeout(r,500));}
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1366,height:768}});await context.addCookies([{name:match[1],value:match[2],url:origin.origin,httpOnly:true,sameSite:'Lax'}]);
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin.origin+'/admin/operations/feedback?days=all&id='+process.env.GALAXY_GO_BROWSER_FEEDBACK,{waitUntil:'domcontentloaded',timeout:90000});
 await page.getByRole('heading',{name:'使用反馈',exact:true}).waitFor({timeout:60000});
 const editor=page.getByRole('complementary',{name:'反馈处理'});await editor.getByRole('combobox',{name:/^处理状态/}).selectOption('processing',{timeout:30000});
 await editor.getByRole('textbox').fill('已核对搜索返回流程，继续保留原分类选择。');await editor.getByRole('button',{name:'保存处理',exact:true}).click();
 await page.getByText('处理已保存。',{exact:true}).waitFor({timeout:20000});await page.waitForFunction(()=>document.querySelector('.galaxy-feedback-editor-fields > label:nth-child(3) select')?.value==='processing',{},{timeout:20000});assert.equal(await editor.getByRole('combobox',{name:/^处理状态/}).inputValue(),'processing');
 await page.reload({waitUntil:'domcontentloaded'});await editor.getByRole('combobox',{name:/^处理状态/}).waitFor();await page.waitForFunction(()=>document.querySelector('.galaxy-feedback-editor-fields > label:nth-child(3) select')?.value==='processing',{},{timeout:20000});assert.equal(await editor.getByRole('combobox',{name:/^处理状态/}).inputValue(),'processing');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({independentHeadless:true,actualNextPayload:true,goFeedbackSave:true,persistedAfterReload:true,pageErrors:errors.length}));
}catch(error){
 if(page)console.error((await page.locator('body').innerText()).slice(0,7000));
 throw error;
}finally{
 await browser?.close();
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null&&process.platform==='win32')await new Promise(resolve=>{const stop=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.once('exit',resolve);});}
 await log.close();
}
