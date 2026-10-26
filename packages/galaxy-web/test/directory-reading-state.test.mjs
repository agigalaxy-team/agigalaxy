import test from 'node:test';
import assert from 'node:assert/strict';
import {directoryReadingState,rememberDirectoryReading} from "../src/shared/reading/directory-reading-state.mjs";

test('visible return recovers navigation depth and selected object while preserving shell state and isolating route, binding and owner',()=>{
  const old={history:globalThis.history,location:globalThis.location,sessionStorage:globalThis.sessionStorage};
  const values=new Map(),scope=JSON.stringify(['projects','https://official.example.org','owner-a','binding-a','tables']);
  try{
    globalThis.location={pathname:'/app/projects',search:'?q=tables',href:'https://local.example/app/projects?q=tables'};
    globalThis.sessionStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
    globalThis.history={state:{scrollY:1200,browseReturn:'/app/bookmarks',profileReturn:'/app/people/example'},replaceState(value){this.state=value;}};
    rememberDirectoryReading(scope,3,'directory-projects-target');
    assert.equal(history.state.scrollY,1200);assert.equal(history.state.browseReturn,'/app/bookmarks');assert.equal(history.state.profileReturn,'/app/people/example');
    assert.deepEqual(directoryReadingState(scope),{depth:3,anchorId:'directory-projects-target'});
    history.state={from:'/app/projects/target'}; // Normal visible return's new entry.
    assert.deepEqual(directoryReadingState(scope),{depth:3,anchorId:'directory-projects-target'});
    assert.deepEqual(directoryReadingState(scope.replace('binding-a','binding-b')),{depth:1,anchorId:null});
    assert.deepEqual(directoryReadingState(scope.replace('owner-a','owner-b')),{depth:1,anchorId:null});
    location.search='?q=other';assert.deepEqual(directoryReadingState(scope),{depth:1,anchorId:null});
    assert.ok([...values.values()].every(value=>Object.keys(JSON.parse(value)).sort().join(',')==='anchorId,depth,scope'));
    location.search='?q=tables';sessionStorage.setItem=()=>{throw Error('isolated storage quota failure');};
    rememberDirectoryReading(scope,4,'directory-projects-new');assert.deepEqual(directoryReadingState(scope),{depth:4,anchorId:'directory-projects-new'});
  }finally{for(const [name,value]of Object.entries(old))if(value===undefined)delete globalThis[name];else globalThis[name]=value;}
});
