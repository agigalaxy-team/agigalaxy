import test from 'node:test';
import assert from 'node:assert/strict';
import {profilePath,profileSubject,profileNavigationState,profileReturn,profileReturnLabel,profileExperiencePath} from '../src/profile-navigation.mjs';

const alice='GUID'+'A'.repeat(28),bob='GUID'+'B'.repeat(28),post='/app/community/posts/ee346750-e0b2-43ba-abef-999fd11c8aca?version=2#reply-3';
test('reading a person and their experience retains the original content and exact position locator',()=>{
 const overview=profilePath(alice),experience=profileExperiencePath(alice,'task:aa346750-e0b2-43ba-abef-999fd11c8aca');
 const initial=profileNavigationState(post,overview),deeper=profileNavigationState(overview,experience,initial);
 assert.equal(profileReturn(deeper),post);assert.equal(profileReturnLabel(post),'返回原讨论');
 assert.equal(new URL(experience,'https://example.test').searchParams.get('record'),'task:aa346750-e0b2-43ba-abef-999fd11c8aca');
 assert.equal(profileReturn(profileNavigationState(experience,profilePath(bob),deeper)),post);
 assert.deepEqual(profileNavigationState(experience,post,deeper),{});
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
