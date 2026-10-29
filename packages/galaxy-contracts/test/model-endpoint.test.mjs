import test from 'node:test';
import assert from 'node:assert/strict';
import {modelProtocolBase} from '../src/model-endpoint.mjs';

test('derive protocol base from a site root or full endpoint without changing custom routes',()=>{
 for(const format of ['openai-chat','openai-responses']){
  assert.equal(modelProtocolBase('https://gateway.example/',format),'https://gateway.example/v1');
  assert.equal(modelProtocolBase('https://gateway.example/proxy/v1/responses/',format),'https://gateway.example/proxy/v1');
  assert.equal(modelProtocolBase('https://opencode.ai/inference/openai/v1',format),'https://opencode.ai/inference/openai/v1');
 }
 assert.equal(modelProtocolBase('https://gateway.example/','gemini'),'https://gateway.example/v1beta');
 assert.equal(modelProtocolBase('https://gateway.example/proxy/v1beta/models/m:generateContent','gemini'),'https://gateway.example/proxy/v1beta');
 assert.equal(modelProtocolBase('https://gateway.example/v1/messages','anthropic'),'https://gateway.example/v1');
});
