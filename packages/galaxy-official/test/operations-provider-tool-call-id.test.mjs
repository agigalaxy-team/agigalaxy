import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsToolCallIdSchema} from '../src/shared/operations-tool-call-id.mjs';
import {workbenchActionToolSchema} from "../src/operations/agentos/action-catalog.mjs";
import {agentOsToolSchema} from '../src/shared/operations-agentos-schema.mjs';

test('provider call pairing values preserve punctuation and length across preparation and legacy tool boundaries',()=>{
 const schemas=[operationsToolCallIdSchema,workbenchActionToolSchema.shape.callId,agentOsToolSchema.shape.callId];
 for(const value of ['call_1','functions/current_summary:2+segment=1?x#y','a'.repeat(200)])for(const schema of schemas)assert.equal(schema.parse(value),value);
 for(const value of ['',null,{},'a'.repeat(201),' call','call ','call\n','call\r','call\t','call\0','call\u007f','调用'])for(const schema of schemas)assert.equal(schema.safeParse(value).success,false);
 // An opaque pairing value does not turn into a resource or authority ID.
 assert.equal(workbenchActionToolSchema.shape.conversationId.safeParse('functions/current_summary:2').success,false);
});
