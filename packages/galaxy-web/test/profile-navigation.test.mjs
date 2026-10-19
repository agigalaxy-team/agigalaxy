import test from 'node:test';
import assert from 'node:assert/strict';
import {profilePath,profileSubject,profileNavigationState,profileReturn,profileReturnLabel,profileExperiencePath,profileReturnNavigationState,publicAccountReturn} from '../src/profile-navigation.mjs';

const alice='GUID'+'A'.repeat(28),bob='GUID'+'B'.repeat(28),post='/app/community/posts/ee346750-e0b2-43ba-abef-999fd11c8aca?version=2#reply-3';
const account='/app/accounts/8cc1659c-4d6f-46bb-8313-73bb6e461120';
test('account and ID profile detours retain the original search or discussion instead of forcing community home',()=>{
 const search='/app/find?q='+alice;
 const opened=profileNavigationState(search,account),id=profileNavigationState(account,profilePath(alice),opened);
 const returned=profileNavigationState(profilePath(alice),account,id);
 assert.equal(profileReturn(id),search);assert.equal(publicAccountReturn(returned),search);
 assert.equal(publicAccountReturn(profileNavigationState(post,account)),post);
 assert.equal(profileReturnLabel(profilePath(alice)),'返回 ID 资料');
 assert.equal(profileReturnLabel(account),'返回账户资料');
});
test('public account return accepts local reading context and does not follow external or settings targets',()=>{
 assert.equal(publicAccountReturn({from:post}),post);
 assert.equal(publicAccountReturn({browseReturn:profilePath(alice)}),profilePath(alice));
 for(const invalid of ['//other.test/app/find','https://other.test/app/find','/app/settings/privacy'])assert.equal(publicAccountReturn({from:invalid,browseReturn:invalid,profileReturn:invalid}),'/app/community');
});
test('reading a person and their experience retains the original content and exact position locator',()=>{
 const overview=profilePath(alice),experience=profileExperiencePath(alice,'task:aa346750-e0b2-43ba-abef-999fd11c8aca');
 const initial=profileNavigationState(post,overview),deeper=profileNavigationState(overview,experience,initial);
 assert.equal(profileReturn(deeper),post);assert.equal(profileReturnLabel(post),'返回原讨论');
 assert.equal(new URL(experience,'https://example.test').searchParams.get('record'),'task:aa346750-e0b2-43ba-abef-999fd11c8aca');
 assert.equal(profileReturn(profileNavigationState(experience,profilePath(bob),deeper)),post);
 assert.deepEqual(profileReturnNavigationState(deeper),{});
});
test('identity connection detours preserve the original reading context without turning settings into a return target',()=>{
 const person=profilePath(alice),initial=profileNavigationState(post,person);
 const connection=profileNavigationState(person,'/app/settings/identity',initial);
 const account=profileNavigationState('/app/settings/identity','/app/settings/identity?section=account',connection);
 assert.equal(profileReturn(profileNavigationState('/app/settings/identity?section=account',person,account)),post);
 assert.equal(profileReturn(profileNavigationState('/app/settings/identity',person)), '/app/');
});
test('profile locators accept only valid subjects and local content returns',()=>{
 assert.equal(profileSubject(profilePath(alice)),alice);
 for(const value of ['Alice','https://other.test',alice+'/settings',null])assert.equal(profilePath(value),null);
 for(const value of ['//other.test/app/','https://other.test/app/','/app/../settings','/app/\\other.test','/app/settings/privacy',profilePath(alice)]){
  const actual=profileReturn({profileReturn:value});
  assert.ok(actual.startsWith('/app/')&&!actual.startsWith('/app/settings/')&&!profileSubject(new URL(actual,'https://example.test').pathname));
 }
 assert.equal(profileExperiencePath(alice,'invalid'),profilePath(alice)+'?section=experience');
});

test('reading a selected work and returning to its author preserves the original person entry instead of a return loop',()=>{
 const person=profilePath(alice)+'?section=projects',work='/app/projects/9b346750-e0b2-43ba-abef-999fd11c8aca';
 const initial=profileNavigationState(post,person),selected=profileNavigationState(person,work,initial);
 const returned=profileNavigationState(work,person,selected);
 assert.equal(profileReturn(returned),post);
 assert.deepEqual(profileReturnNavigationState(returned),{});
 assert.equal(profileReturn(profileNavigationState(work,profilePath(bob),selected)),work);
 const directory=profileNavigationState(work,'/app/projects',selected);
 assert.deepEqual(directory,{});
 assert.equal(profileReturn(profileNavigationState('/app/projects',person,directory)),'/app/projects');
 const direct=profileNavigationState('/app/settings/identity',person);
 assert.equal(profileReturn(profileNavigationState(work,person,profileNavigationState(person,work,direct))),'/app/');
});

test('returning through a selected work restores its original search parent without making portfolio links abandon the person',()=>{
 const work='/app/projects/9b346750-e0b2-43ba-abef-999fd11c8aca',person=profilePath(alice),portfolio=person+'?section=projects';
 const search='/app/find?q=%E6%89%8B%E6%9C%BA&type=projects';
 const opened=profileNavigationState(work,person,{browseReturn:search});
 const listed=profileNavigationState(person,portfolio,opened);
 const selected=profileNavigationState(portfolio,work,listed);
 const backToPerson=profileNavigationState(work,portfolio,selected);
 assert.equal(profileReturn(backToPerson),work);
 assert.equal(selected.profileSubject,alice);
 assert.deepEqual(profileReturnNavigationState(backToPerson),{browseReturn:search});
 assert.deepEqual(profileReturnNavigationState({profileBrowseReturn:'https://other.test/app/find'}),{});
 assert.deepEqual(profileReturnNavigationState({profileBrowseReturn:'/app/settings/privacy'}),{});
});
