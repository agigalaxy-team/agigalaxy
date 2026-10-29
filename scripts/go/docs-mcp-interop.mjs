import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import bundle from '../../packages/galaxy-official/public-docs.json' with {type:'json'};
const endpoint=new URL(process.env.GALAXY_GO_TEST_DOCS_ORIGIN??'');
if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1')throw Error('isolated loopback required');
const client=new Client({name:'original-docs-client',version:'0.1.0'});
try{
 await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/docs',endpoint)));
 const topics=['overview','installation','compatibility','privacy'];
 const resources=(await client.listResources()).resources;
 assert.equal(resources.length,(Object.keys(bundle.versions).length+1)*4);
 assert.equal((await client.listResourceTemplates()).resourceTemplates.length,1);
 const tools=(await client.listTools()).tools;assert.deepEqual(tools.map(t=>t.name).sort(),['docs_get','docs_search']);
 for(const tool of tools){assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);assert.equal(tool.annotations.openWorldHint,false)}
 for(const [version,documents] of Object.entries(bundle.versions))for(const topic of topics){
  assert.equal((await client.readResource({uri:`galaxy-docs://${version}/${topic}`})).contents[0].text,documents[topic]);
  assert.equal((await client.callTool({name:'docs_get',arguments:{version,topic}})).content[0].text,documents[topic]);
 }
 for(const topic of topics){
  assert.equal((await client.readResource({uri:`galaxy-docs://current/${topic}`})).contents[0].text,bundle.documents[topic]);
  assert.equal((await client.callTool({name:'docs_get',arguments:{topic}})).content[0].text,bundle.documents[topic]);
 }
 for(const version of ['current',...Object.keys(bundle.versions)])for(const query of ['Galaxy','  Galaxy  ','\ufeffGalaxy\ufeff','不存在的独立字符串']){
  const selected=version==='current'?bundle.version:version;
  const expected={version:selected,results:topics.filter(t=>bundle.versions[selected][t].toLowerCase().includes(query.trim().toLowerCase())).map(topic=>({topic,uri:`galaxy-docs://${selected}/${topic}`}))};
  assert.deepEqual(JSON.parse((await client.callTool({name:'docs_search',arguments:{version,query}})).content[0].text),expected);
 }
 for(const args of [{topic:'privacy',internalPath:'../private'},{version:'v9',topic:'overview'},{topic:'../private-key'},{version:null,topic:'privacy'}])assert.equal((await client.callTool({name:'docs_get',arguments:args})).isError,true);
 for(const query of ['','   ','x'.repeat(129)])assert.equal((await client.callTool({name:'docs_search',arguments:{query}})).isError,true);
 await assert.rejects(client.readResource({uri:'galaxy-docs://v9/private'}));
 await assert.rejects(client.readResource({uri:'file:///originals/private.md'}));
 assert.deepEqual((await client.listPrompts()).prompts.map(p=>p.name).sort(),['explain-installation','explain-privacy']);
 for(const name of ['installation','privacy'])assert.equal((await client.getPrompt({name:`explain-${name}`})).messages[0].content.text,`请解释以下公开文档，并明确当前限制。仅作说明，不执行初始化、连接或发布。\n\n${bundle.documents[name]}`);
 console.log(JSON.stringify({versions:Object.keys(bundle.versions).length,resources:resources.length,tools:tools.length,prompts:2}));
}finally{await client.close()}
