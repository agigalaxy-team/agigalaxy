import {createGalaxyPlugin,createGalaxyAdapter} from './galaxy.tui.ts';

// A local test bridge over the existing Native MCP fixture. It does not alter
// the installed plugin, providers or user configuration, and cannot approve a
// Native choice. The original user-choice page remains required for writes.
const endpoint=new URL(process.env.GALAXY_METHOD_FIXTURE_URL);
if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.pathname!=='/')throw Error('isolated_method_fixture_required');
async function read(path,body){const response=await fetch(new URL(path,endpoint),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});if(!response.ok)throw Error('isolated_method_fixture_unavailable');return response.json();}
export default createGalaxyPlugin(()=>createGalaxyAdapter(null,{nativeTools:{call:(name,args)=>read('/tools',{name,args})},readWorkContext:()=>read('/context')}));
