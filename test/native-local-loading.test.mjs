import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {registerLocalWorkPanelTools} from '../integrations/native-v2/compact-app/local-work-server.mjs';

const sdk=createRequire(new URL('../integrations/native-v2/compact-app/package.json',import.meta.url));
const {Client,InMemoryTransport}=await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/client')).href);
const {McpServer}=await import(pathToFileURL(sdk.resolve('@modelcontextprotocol/server')).href);

test('device settings remain readable while a separate account lookup is waiting', {timeout:10000}, async()=>{
  let fetched=0,release,started;
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const galaxyId='synthetic-local-owner',target={accountId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',displayName:'本人账户'};
  const local={privacyGet:async()=>({galaxyId,settings:{level:'history-overview'}}),
    work:{list:async()=>({items:[],nextAfter:null})},archive:{list:async()=>({items:[],nextAfter:null}),settings:async()=>({settings:{sessions:[]}})},
    cloud:{settings:async()=>({choice:{}})},workCloud:{settings:async()=>({choice:{}})},
    availableAccounts:async()=>{fetched++;started();await gate;return {accounts:[target],connected:true};}};
  const server=new McpServer({name:'local-independent-loads',version:'1'}),client=new Client({name:'synthetic-panel-user',version:'1'});
  registerLocalWorkPanelTools(server,{resourceUri:'ui://galaxy/local-load-test',local,reviewAction:async()=>{throw Error('read_must_not_request_a_choice');}});
  const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(left);await client.connect(right);
  const call=(name,args)=>client.callTool({name,arguments:args});
  try{
    const first=await call('galaxy_local_panel',{view:'privacy'});
    assert.equal(first._meta.galaxyLocalWork.privacy.settings.level,'history-overview');assert.equal(fetched,0);
    const accounts=call('galaxy_local_panel_sync_accounts',{galaxyId});await ready;
    const reading=await call('galaxy_local_panel_read',{view:'privacy',galaxyId});
    assert.equal(reading._meta.galaxyLocalWork.accountsPending,true);assert.equal(fetched,1);
    release();const updated=(await accounts)._meta.galaxyLocalWork;
    assert.equal(updated.accountUpdate,true);assert.deepEqual(updated.accounts,[target]);assert.equal(updated.accountsPending,false);
    assert.equal('sessionChoices' in updated,false,'remote completion is a field update, not another page');
  }finally{release();await client.close();await server.close();}
});
