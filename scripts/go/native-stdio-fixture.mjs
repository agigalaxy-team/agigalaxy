// Actual TypeScript SDK -> spawned Go executable -> original local SQLite.
// All files belong to the OS-temporary fixture; never uses host configuration.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createLocalConversationArchive} from '../../packages/galaxy-core/src/conversation-archive/index.mjs';
const require=createRequire(new URL('../../packages/galaxy-official/package.json',import.meta.url));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href);
const binary=resolve(process.argv[2]),directory=resolve(process.argv[3]);
if(!directory.startsWith(resolve(tmpdir())+'\\')&&!directory.startsWith(resolve(tmpdir())+'/'))throw Error('fixture_requires_os_temporary_directory');
const expected=JSON.parse(await readFile(join(directory,'expected.json'),'utf8'));
const config=join(directory,'native-config.json');
await writeFile(config,JSON.stringify({version:2,endpoint:'https://selected.example.invalid',website:'https://web.example.invalid',dataDirectory:directory,trustedKeys:{}}));
const transport=new StdioClientTransport({command:binary,args:['native','--config',config],stderr:'pipe'});
const client=new Client({name:'go-migration-stdio-fixture',version:'1'}, {capabilities:{elicitation:{form:{}}},versionNegotiation:{mode:{pin:'2026-07-28'}}});
let choices=0;
client.setRequestHandler('elicitation/create',async()=>{choices++;return {action:'accept',content:{confirm:true}};});
try{
 await client.connect(transport);
 const tools=await client.listTools();assert.deepEqual(tools.tools.map(x=>x.name).sort(),['galaxy_local_archive_configure','galaxy_local_archive_settings','galaxy_local_work_get','galaxy_local_work_list'].sort());
 const result=await client.callTool({name:'galaxy_local_work_list',arguments:{}});assert(!result.isError);assert.deepEqual(JSON.parse(result.content[0].text),expected.list);
 const selected=await client.callTool({name:'galaxy_local_archive_configure',arguments:{enabled:false,sessions:[],autoCleanAfterDays:null}});assert(!selected.isError);assert.equal(choices,1);
 const archive=createLocalConversationArchive({dataDirectory:directory}),current=await archive.settings();assert.equal(current.settings.enabled,false);assert.deepEqual(current.settings.sessions,[]);
 const unknown=await client.callTool({name:'galaxy_local_work_get',arguments:{workId:'not-recorded'}});assert(!unknown.isError);assert.equal(JSON.parse(unknown.content[0].text),null);
 console.log(JSON.stringify({stdio:true,personChoices:choices,originalArchiveReadable:true}));
}finally{await client.close();await transport.close();}
