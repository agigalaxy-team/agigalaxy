// Actual TypeScript SDK -> spawned Go executable -> original local SQLite.
// All files belong to the OS-temporary fixture; never uses host configuration.
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const binary=resolve(process.argv[2]),directory=resolve(process.argv[3]);
if(!directory.startsWith(resolve(tmpdir())+'\\')&&!directory.startsWith(resolve(tmpdir())+'/'))throw Error('fixture_requires_os_temporary_directory');
const expected=JSON.parse(await readFile(join(directory,'expected.json'),'utf8'));
const config=join(directory,'native-config.json');
const fixturePublicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),fixtureNow=Math.floor(Date.now()/1000);
await writeFile(config,JSON.stringify({version:2,endpoint:'https://selected.example.invalid',website:'https://web.example.invalid',dataDirectory:directory,trustedKeys:{fixture:{publicKeyPem:fixturePublicKey,notBefore:fixtureNow-1,notAfter:fixtureNow+3600,revoked:false}}}));
const transport=new StdioClientTransport({command:binary,args:['native','--config',config],stderr:'pipe'});
const client=new Client({name:'go-migration-stdio-fixture',version:'1'}, {capabilities:{elicitation:{form:{}}},versionNegotiation:{mode:{pin:'2026-07-28'}}});
let choices=0;
client.setRequestHandler('elicitation/create',async()=>{choices++;return {action:'accept',content:{confirm:true}};});
try{
 await client.connect(transport);
 const tools=await client.listTools(),names=new Set(tools.tools.map(tool=>tool.name));
 assert.equal(names.size,tools.tools.length);
 for(const name of ["galaxy_native_discovery","galaxy_identity_recovery","galaxy_local_work_list","galaxy_local_work_pending","galaxy_local_work_export","galaxy_local_archive_configure","galaxy_local_archive_settings","galaxy_local_work_get"])assert(names.has(name),"Required current Native tool missing: "+name);
 for(const tool of tools.tools){assert.match(tool.name,/^galaxy_[a-z0-9_]+$/);assert(tool.inputSchema&&typeof tool.inputSchema==="object"&&!Array.isArray(tool.inputSchema));}
 const result=await client.callTool({name:'galaxy_local_work_list',arguments:{}});assert(!result.isError);assert.deepEqual(JSON.parse(result.content[0].text),expected.list);
 const workId=expected.list.items[0].workId,pending=await client.callTool({name:'galaxy_local_work_pending',arguments:{workId}});assert(!pending.isError);assert.deepEqual(JSON.parse(pending.content[0].text),expected.pending);
 const exported=await client.callTool({name:'galaxy_local_work_export',arguments:{workId}});assert(!exported.isError);const data=JSON.parse(exported.content[0].text),original={...expected.export};delete data.exportedAt;delete original.exportedAt;assert.deepEqual(data,original);
 const selected=await client.callTool({name:'galaxy_local_archive_configure',arguments:{enabled:false,sessions:[],autoCleanAfterDays:null}});assert(!selected.isError);assert.equal(choices,1);
 const archive=await client.callTool({name:'galaxy_local_archive_settings',arguments:{}});assert(!archive.isError);const current=JSON.parse(archive.content[0].text);assert.equal(current.settings.enabled,false);assert.deepEqual(current.settings.sessions,[]);
 const unknown=await client.callTool({name:'galaxy_local_work_get',arguments:{workId:'not-recorded'}});assert(!unknown.isError);assert.equal(JSON.parse(unknown.content[0].text),null);
 console.log(JSON.stringify({stdio:true,personChoices:choices,archiveSettingsReadable:true}));
}finally{await client.close();await transport.close();}
