import assert from 'node:assert/strict';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message,timeout=30000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await check();if(last)return;}catch{}await pause(100);}assert.fail(message+(last===undefined?'':': '+String(last)));}
const growthPath=path=>/^\/v2\/community\/growth\/(?:accounts\/[^/]+|me)(?:\/contributions|\/legacy-honors)?$/.test(path);
function assertNoWeight(value){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){assert(!/^(?:weight|weights|weightValue|assessment|modelVersion|promptVersion|evidence|inputRevision|appliedRevision)$/i.test(key),'public response contains a management field');assertNoWeight(item);}}

// Called by the full-entry harness after the actual HTTPS edge, site, Payload,
// API and disposable PostgreSQL are running. No business response is supplied.
export async function runCommunityBrowser({browser,context,d,website,admin,endpoint,upstream,pages,observePage,jsonCall,inspectionErrors}){
 const inspected=[],pendingInspections=new Set();let active=true;
 const watch=page=>{observePage(page);page.on('response',response=>{const url=new URL(response.url());if(!active||url.host!==endpoint.host||!growthPath(url.pathname)||!response.ok())return;
  const task=response.json().then(value=>{assertNoWeight(value);if(active)inspected.push(url.pathname);}).catch(error=>{if(active)inspectionErrors.push({path:url.pathname,reason:error?.name==='AssertionError'?'public response contains a management field':'response body unavailable'});});
  pendingInspections.add(task);void task.then(()=>pendingInspections.delete(task));
 });};
 const author=await context.newPage();pages.push(author);watch(author);
 const second=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1366,height:900}});
 try{
  await second.route('**/*',route=>{const url=new URL(route.request().url());return ['data:','blob:'].includes(url.protocol)||upstream.has(url.host)?route.continue():route.abort('blockedbyclient');});
  await second.addCookies([{...d.people[1].cookie,url:endpoint.origin,httpOnly:true,secure:true,sameSite:'Lax'}]);
  const reader=await second.newPage();pages.push(reader);watch(reader);
  await author.goto(website.origin+'/',{waitUntil:'domcontentloaded'});await author.locator('main').waitFor();
  const publication=await jsonCall(author,'/v2/community/posts',{payloadJson:JSON.stringify(d.forum.payload)});assert(publication.status>=200&&publication.status<300,'real publication rejected');
  await author.goto(website.origin+'/app/accounts/'+d.people[0].accountId,{waitUntil:'domcontentloaded'});
  const growth=author.locator('section.public-account-relations').filter({has:author.getByRole('heading',{name:'社区成长',exact:true})});
  await growth.getByRole('heading',{name:'社区成长',exact:true}).waitFor({timeout:30000});
  await until(async()=>/\d+ 经验/.test(await growth.innerText()),'author growth unavailable');
  const experience=async()=>{const match=(await growth.innerText()).match(/(\d+) 经验/);return match?Number(match[1]):null;};
  const before=await experience();
  const social=author.locator('section.public-account-relations').filter({has:author.getByRole('heading',{name:'社区关系',exact:true})});
  await social.getByRole('button',{name:/^粉丝/}).click();
  await reader.goto(website.origin+'/app/community/posts/'+d.forum.postId,{waitUntil:'domcontentloaded'});
  await reader.getByRole('heading',{name:d.forum.payload.title,exact:true}).waitFor({timeout:30000});
  const post=reader.locator('article.forum-post'),like=post.getByRole('button',{name:/^(?:点赞|已赞)\s/});
  await like.waitFor({timeout:30000});assert.equal(await like.getAttribute('aria-pressed'),'false');
  let blocked=false;
  await author.route(url=>url.origin===endpoint.origin&&url.pathname==='/v2/community/growth/accounts/'+d.people[0].accountId,async route=>{if(!blocked&&route.request().method()==='GET'){blocked=true;await route.abort('failed');}else await route.continue();});
  const liked=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v2/community/reactions/command'&&response.request().method()==='POST'&&response.ok());
  await like.click();await liked;await until(async()=>await like.getAttribute('aria-pressed')==='true','like state did not update');
  await author.bringToFront();await until(()=>blocked,'the targeted growth read was not attempted');
  await growth.getByText('成长资料暂时无法读取。',{exact:false}).waitFor({timeout:20000});assert.equal(await experience(),before,'transient failure erased or changed displayed growth');
  await growth.getByRole('button',{name:'重试',exact:true}).click();
  await until(async()=>(await experience())>before,'like did not update author growth');
  await reader.bringToFront();const cancelled=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v2/community/reactions/command'&&response.request().method()==='POST'&&response.ok());await like.click();await cancelled;await until(async()=>await like.getAttribute('aria-pressed')==='false','like cancellation did not update');
  await author.bringToFront();await until(async()=>(await experience())===before,'cancelled like did not restore author growth');
  await reader.goto(website.origin+'/app/accounts/'+d.people[0].accountId,{waitUntil:'domcontentloaded'});
  const follow=reader.locator('.account-follow-control').getByRole('button',{name:'关注',exact:true});await follow.waitFor({timeout:30000});
  const followResponse=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v1/account/follows/command'&&response.ok());await follow.click();const followBody=await (await followResponse).json();assert.equal(followBody.relationship.visibility,'public');
  const visibility=reader.getByLabel('关注可见范围',{exact:true});await until(async()=>await visibility.inputValue()==='public','new follow is not public');
  await author.bringToFront();await until(async()=>(await social.innerText()).includes('网页联检乙'),'public follower did not appear');
  await reader.bringToFront();const privacyResponse=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v1/account/follows/command'&&response.ok());await visibility.selectOption('private');const privacyBody=await (await privacyResponse).json();assert.equal(privacyBody.relationship.visibility,'private');
  await author.bringToFront();await until(async()=>!(await social.innerText()).includes('网页联检乙'),'private follower remained public');
  // A normal visibility transition must not independently refetch these modules.
  await pause(1200);let reads=0;const count=request=>{const url=new URL(request.url());if(url.host===endpoint.host&&(growthPath(url.pathname)||url.pathname==='/v1/account/follows/public-query'))reads++;};author.on('request',count);
  await reader.bringToFront();await author.bringToFront();await pause(1500);author.off('request',count);assert.equal(reads,0,'tab focus caused event-backed reads');
  await reader.bringToFront();const ownGrowth=reader.waitForResponse(response=>new URL(response.url()).pathname==='/v2/community/growth/me'&&response.ok(),{timeout:30000});await reader.goto(website.origin+'/app/account',{waitUntil:'domcontentloaded'});await ownGrowth;
  const manager=await context.newPage();pages.push(manager);watch(manager);await manager.bringToFront();
  await manager.goto(admin.origin+'/admin/operations/community?tab=growth',{waitUntil:'domcontentloaded',timeout:90000});
  await manager.getByRole('heading',{name:'社区成长',exact:true}).waitFor({timeout:60000});
  const saveAdmin=async button=>{const response=manager.waitForResponse(response=>new URL(response.url()).pathname==='/v1/operations/community-growth/command'&&response.request().method()==='POST',{timeout:30000});await button.click();const actual=await response;assert(actual.ok(),'community management command rejected: '+actual.status());};
  const rules=manager.getByRole('button',{name:'成长规则与等级',exact:true});await rules.click();
  await manager.getByLabel('参与类型').selectOption({label:'公开帖子'});
  const rulesPanel=manager.getByRole('heading',{name:'成长规则',exact:true}).locator('..');
  const ruleForm=rulesPanel.locator('form:visible').filter({has:manager.getByRole('button',{name:'保存规则',exact:true})});
  await ruleForm.getByLabel('经验',{exact:true}).fill('6');await saveAdmin(ruleForm.getByRole('button',{name:'保存规则'}));await ruleForm.getByText('规则已保存。',{exact:true}).waitFor({timeout:30000});
  await rulesPanel.getByRole('button',{name:'刷新',exact:true}).click();await until(async()=>await ruleForm.getByLabel('经验',{exact:true}).inputValue()==='6','saved rule was not reread');
  await manager.getByRole('button',{name:'荣誉定义',exact:true}).click();
  const definitions=manager.getByRole('heading',{name:'荣誉定义',exact:true}).locator('..');
  await definitions.getByLabel('名称',{exact:true}).fill('隔离社区荣誉');await definitions.getByLabel('说明',{exact:true}).fill('隔离环境中的真实荣誉定义');await saveAdmin(definitions.getByRole('button',{name:'保存荣誉',exact:true}));await definitions.getByText('荣誉已保存。',{exact:true}).waitFor({timeout:30000});
  await manager.getByRole('button',{name:'认可与活动',exact:true}).click();
  const recognition=manager.getByRole('heading',{name:'内容认可与活动结果',exact:true}).locator('..');
  await recognition.getByLabel('搜索帖子或回复').fill(d.forum.payload.title);await recognition.getByRole('button',{name:'搜索',exact:true}).click();
  const contentRow=recognition.locator('li').filter({hasText:d.forum.payload.title});await contentRow.getByRole('button',{name:'选择内容及作者'}).click();
  const reason=recognition.getByLabel('说明',{exact:true}),save=recognition.getByRole('button',{name:'保存记录',exact:true});
  await reason.fill('隔离社区认可原始记录');await saveAdmin(save);await recognition.getByText('记录已保存。',{exact:true}).waitFor({timeout:30000});
  const choice=recognition.getByLabel('记录',{exact:true});await until(async()=>(await choice.locator('option').allTextContents()).some(text=>text.includes('隔离社区认可原始记录')),'recognition not listed');
  await choice.selectOption({label:'内容认可 · 隔离社区认可原始记录'});await reason.fill('隔离社区认可更正记录');await saveAdmin(save);await recognition.getByText('记录已保存。',{exact:true}).waitFor({timeout:30000});
  await until(async()=>(await choice.locator('option').allTextContents()).some(text=>text.includes('隔离社区认可更正记录')),'recognition correction not listed');
  await recognition.getByLabel('生效',{exact:true}).uncheck();await saveAdmin(save);await recognition.getByText('记录已保存。',{exact:true}).waitFor({timeout:30000});
  await manager.getByRole('button',{name:'账户权重',exact:true}).click();await manager.getByRole('heading',{name:'账户领域权重',exact:true}).waitFor();
  await manager.goto(admin.origin+'/admin/operations/ai-work-accounts?domain=discovery&tab=duty',{waitUntil:'domcontentloaded'});
  await manager.getByRole('heading',{name:'社区权重计算',exact:true}).waitFor({timeout:60000});
  while(pendingInspections.size)await Promise.all([...pendingInspections]);assert.deepEqual(inspectionErrors,[],'public growth response inspection failed');assert(inspected.some(path=>path.includes('/growth/accounts/')),'no public growth response inspected');assert(inspected.includes('/v2/community/growth/me'),'no owner growth response inspected');
 }finally{active=false;}
}
