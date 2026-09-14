import assert from 'node:assert/strict';
import {searchV2ReferenceSchema} from '../src/shared/search-v2-schema.mjs';
export async function checkChoiceSource(f,actor,search,id){
 const page=await f.search.v2.query(actor,search),item=page.items.find(v=>v.id===id);assert.ok(item,'actual source readable');
 return f.access.runAuthorized(actor,'binding',async db=>{
  const dependency=await f.choices.sourceReader.witnessWithin(db,actor,searchV2ReferenceSchema.parse({search,ref:item.ref}));
  assert.equal((await f.choices.sourceReader.statusWithin(db,actor,dependency)).state,'current');
  assert.equal(JSON.stringify(dependency).includes('"query"'),false);return dependency;
 });
}
