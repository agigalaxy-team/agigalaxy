import test from 'node:test';
import assert from 'node:assert/strict';
import {hostDiagnostics} from './native-diagnostics.mjs';

test('TUI diagnostics use the host log API and keep private content out of records',async()=>{
 const calls=[],api={client:{app:{log:async(input)=>{calls.push(input);return {data:true};}}}};
 const reporter=hostDiagnostics(api);assert.equal(hostDiagnostics(api),reporter);
 reporter.emit({event:'host_recording',stage:'recording',outcome:'started',host:'opencode',text:'private draft',token:'secret'});
 assert.equal(calls.length,1);assert.equal(calls[0].service,'galaxy');assert.equal(calls[0].message,'host_recording');
 assert.equal(JSON.stringify(calls).includes('private draft'),false);assert.equal(JSON.stringify(calls).includes('secret'),false);
 assert.equal(reporter.status().mode,'host');assert.equal(reporter.status().ready,true);
});

test('an unavailable host logger does not break business work or fall back to the terminal',async()=>{
 const reporter=hostDiagnostics({});assert.equal(await reporter.run('recording',()=>42,{event:'host_recording'}),42);
 assert.equal(reporter.status().ready,false);assert.ok(reporter.status().writeFailures>0);
 const failing=hostDiagnostics({client:{app:{log(){throw Error('unavailable');}}}});
 assert.equal(await failing.run('summary',()=>7,{event:'host_summary'}),7);assert.ok(failing.status().writeFailures>0);
});
