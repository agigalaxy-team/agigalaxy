import test from 'node:test';
import assert from 'node:assert/strict';
import {outcomeLifecycleFixture} from './outcome-material-lifecycle-continuity-workflow.mjs';
import {outcomeMaterialToolDefinitions} from '../src/personal-mcp-outcome-materials-v2.mjs';

test('diagnostic: pre-retention source preview returns exact metadata without raw attachment bytes to HTTP or ordinary MCP',{timeout:60000},async t=>{
 const x=await outcomeLifecycleFixture();try{
  const selection={kind:'attachment',id:x.attachmentId,version:1};
  const http=await x.post('/v2/outcome-materials/source',selection);
  const definitions=outcomeMaterialToolDefinitions({outcomeMaterials:x.materials},x.f.actor);
  const mcp=await definitions.galaxy_outcome_material_source.run(selection);
  const count=Number((await x.f.db.query('SELECT count(*) AS n FROM outcome_materials_v2')).rows[0].n);
  t.diagnostic('outcome_source_projection_observed '+JSON.stringify({status:http.status,
   httpReturnedBinaryLength:http.body.bytes?.data?.length??0,mcpFactoryReturnedBinaryLength:mcp.bytes?.length??0,
   sourceId:http.body.source?.id,sourceHash:http.body.source?.sha256,independentRetentionGranted:http.body.independentRetentionGranted,
   copiesCreated:count,actualHttp:true,ordinaryMcp:'actual tool definition run; no SDK/host claim',database:'PGlite',objectStore:'contract double'}));
  assert.equal(http.status,200);assert.equal(count,0);assert.deepEqual(http.body.source,{kind:'attachment',id:x.attachmentId,version:1,sha256:x.sha256,roomId:x.roomId});
  assert.equal(http.body.independentRetentionGranted,false);
  assert.equal(http.body.bytes,undefined,'source preview uses the same metadata-only projection as selected messages');
  assert.equal(mcp.bytes,undefined,'ordinary MCP preview must not silently serialize the entire attachment');
 }finally{await x.close();}
});
