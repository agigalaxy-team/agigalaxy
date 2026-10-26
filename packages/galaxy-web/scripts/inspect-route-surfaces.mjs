import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const origin='http://127.0.0.1:5190',out=browserToolOutput(import.meta.url, undefined),events=[];
await mkdir(out,{recursive:true});const fixture=await(await fetch(origin+'/__fixture')).json();
const browser=await chromium.launch({ headless:true });
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});await context.addInitScript(now=>{Date.now=()=>now*1000;},fixture.now);
await context.route('https://official.example.org/**',async route=>{const req=route.request(),url=new URL(req.url());const res=await context.request.fetch(fixture.api+url.pathname+url.search,{method:req.method(),headers:{...req.headers(),origin:'https://galaxy-ui.example.org'},data:req.postData()??undefined});await route.fulfill({response:res,headers:{...res.headers(),'access-control-allow-origin':origin}});});
const page=await context.newPage();page.on('pageerror',e=>events.push({pageError:e.message,url:page.url()}));
try{
 await page.goto(origin+'/app/settings/identity');await page.getByRole('button',{name:'创建我的银河身份'}).click();await page.getByRole('heading',{name:'当前银河身份',exact:true}).waitFor();await page.getByRole('button',{name:'连接并返回'}).click();await page.getByRole('heading',{name:'你想推进什么？',exact:true}).waitFor();
 for(const path of ['/app/match','/app/projects','/app/capsules','/app/information','/app/configurations','/app/hubs','/app/builders','/app/worker-packs','/app/governance','/app/notifications','/app/history','/app/settings/privacy','/app/settings/summaries','/app/settings/trust-package','/app/qualification-permissions']){
  await page.setViewportSize({width:1440,height:1000});await page.locator('.personal-menu').evaluate(el=>el.open=true);await page.locator('.site-more').evaluate(el=>el.open=true);const links=page.locator('a[href="'+path+'"]');await links.first().click();await page.waitForURL(origin+path);await page.waitForLoadState('networkidle');await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{window.scrollTo(0,0);document.activeElement?.blur();});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const text=await page.locator('.site-content').innerText(),name=path.slice(5).replaceAll('/','-');await writeFile(resolve(out,name+'.txt'),text);await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});events.push({path,actualUrl:page.url(),title:await page.locator('h1').allTextContents(),visibleButtons:await page.getByRole('button').count(),height:await page.evaluate(()=>document.documentElement.scrollHeight),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),errors:await page.locator('[role="alert"]').allTextContents()});
 }
}finally{await writeFile(resolve(out,'route-inspection.json'),JSON.stringify({synthetic:true,actualHttp:true,actualDatabase:true,emptySyntheticIdentity:true,visualInspectionOnly:true,events},null,2));await browser.close();}

