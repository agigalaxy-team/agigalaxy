import test from 'node:test';
import assert from 'node:assert/strict';
import {localGalaxyReturnObject} from '../src/local-galaxy-navigation.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',versionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('account handoff preserves exact objects already supported by Native navigation',()=>{
 assert.deepEqual(localGalaxyReturnObject('/app/tasks/'+id),{kind:'task',id});
 assert.deepEqual(localGalaxyReturnObject('/app/rooms/'+id),{kind:'room',id});
 assert.deepEqual(localGalaxyReturnObject('/app/projects/'+id),{kind:'project',id});
 assert.deepEqual(localGalaxyReturnObject('/app/capsules/'+id+'/versions/'+versionId),{kind:'capsule',id,versionId});
 assert.deepEqual(localGalaxyReturnObject('/app/community/posts/'+id),{kind:'post',id});
 assert.deepEqual(localGalaxyReturnObject('/app/bookmarks'),{kind:'bookmarks'});
});

test('unsupported query, section, recursive identity and external URLs are not broadened into a different target',()=>{
 for(const target of ['/app/bookmarks?kind=project','/app/tasks/'+id+'?section=responses','/app/search?q=private-context','/app/settings/identity','/app/settings/identity?section=account','https://other.invalid/app/bookmarks','//other.invalid/app/bookmarks','/app/tasks/not-a-uuid','/app/tasks/'+id+'/../'+id,null])assert.equal(localGalaxyReturnObject(target),null);
});
