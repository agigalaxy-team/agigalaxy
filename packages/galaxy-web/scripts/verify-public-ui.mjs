import { chromium, browserToolOutput } from './browser-tool-runtime.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const out=browserToolOutput(import.meta.url, process.env.GALAXY_PUBLIC_UI_REPORT_DIR),events=[];await mkdir(out,{recursive:true});
const origin = process.env.GALAXY_PUBLIC_UI_ORIGIN ?? 'https://agigalaxy.org';
const browser=await chromium.launch({ headless:true });
try{const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',e=>events.push({pageError:e.message}));
 for(const [name,path]of [['home','/'],['search','/app/search']]){const response=await page.goto(new URL(path,origin).href,{waitUntil:'networkidle'});assert.equal(response.status(),200);await page.locator('h1').waitFor();for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1000});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(out,name+'-'+width+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);events.push({url:page.url(),width,title:await page.title(),heading:await page.locator('h1').innerText(),http:response.status(),overflow:false});}}
 assert.equal(events.filter(e=>e.pageError).length,0);
}finally{await writeFile(resolve(out,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),productionPublicReadOnly:origin==='https://agigalaxy.org',privateAccountOrBusinessWrites:false,events},null,2));await browser.close();}
