import {chromium} from 'file:///C:/Users/USER1/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const out=resolve('../../../07-logs/development/ui-resume-20261002/public-first-release'),events=[];await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/USER1/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe'});
try{const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',e=>events.push({pageError:e.message}));
 for(const [name,url]of [['home','https://agigalaxy.org/'],['search','https://agigalaxy.org/app/search']]){const response=await page.goto(url,{waitUntil:'networkidle'});assert.equal(response.status(),200);await page.locator('h1').waitFor();for(const width of [1440,390]){await page.setViewportSize({width,height:width===390?844:1000});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(out,name+'-'+width+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);events.push({url:page.url(),width,title:await page.title(),heading:await page.locator('h1').innerText(),http:response.status(),overflow:false});}}
 assert.equal(events.filter(e=>e.pageError).length,0);
}finally{await writeFile(resolve(out,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),productionPublicReadOnly:true,privateAccountOrBusinessWrites:false,events},null,2));await browser.close();}
