import {createGalaxyPlugin,createGalaxyAdapter} from './galaxy.tui.ts';

const endpoint=new URL(process.env.GALAXY_CONTACT_FIXTURE_URL);
if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.pathname!=='/')throw Error('isolated_contact_fixture_required');
async function read(path,body){const response=await fetch(new URL(path,endpoint),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});if(!response.ok)throw Error('isolated_contact_fixture_unavailable');return response.json();}
// The adapter uses only the already initialized synthetic Native bridge. The
// installed configuration, providers and original input remain host-owned.
export default createGalaxyPlugin(()=>createGalaxyAdapter(null,{nativeTools:{call:(name,args)=>read('/tools',{name,args})},readWorkContext:()=>read('/context')}));
