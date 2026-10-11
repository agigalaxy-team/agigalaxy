import test from 'node:test';
import assert from 'node:assert/strict';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {nativeIdentityScopeGroups} from '../src/native-v2/identity-scope-presentation.mjs';

test('Native device approval groups every selected permission without changing the exact scope set',()=>{
 const scopes=[...browserScopes],before=structuredClone(scopes),groups=nativeIdentityScopeGroups(scopes),items=groups.flatMap(group=>group.items);
 assert.deepEqual(items.map(item=>item.key).sort(),[...scopes].sort());assert.deepEqual(scopes,before);
 for(const key of ['evidence','proof','notifications']){const item=items.find(item=>item.key===key);assert.ok(item,key);assert.notEqual(item.label,key);}
 assert.equal(nativeIdentityScopeGroups(['binding']).flatMap(group=>group.items).length,1);
 const unknown=nativeIdentityScopeGroups(['binding','future-scoped-action']);assert.deepEqual(unknown.at(-1),{title:'其他范围',items:[{key:'future-scoped-action',label:'其他权限：future-scoped-action'}]});
});
