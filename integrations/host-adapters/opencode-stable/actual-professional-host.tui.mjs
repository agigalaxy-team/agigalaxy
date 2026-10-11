import {createGalaxyPlugin,createGalaxyAdapter} from './galaxy.tui.ts';

const endpoint=new URL(process.env.GALAXY_PROFESSIONAL_FIXTURE_URL),kind=process.env.GALAXY_PROFESSIONAL_KIND;
if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.pathname!=='/'||!['builder','deletion','capsule','a2a'].includes(kind))throw Error('isolated_professional_fixture_required');
async function read(path,body){const response=await fetch(new URL(path+'?kind='+kind,endpoint),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});if(!response.ok)throw Error('isolated_professional_fixture_unavailable');return response.json();}
// The bridge holds the original controller and frozen prepare object. This
// proxy does not invent capabilities, sign choices, or reprepare an operation.
export default createGalaxyPlugin(async()=>{
 const metadata=await read('/host/config');let tail=Promise.resolve();
 const call=(method,args)=>{const result=tail.then(async()=>{const response=await read('/host/call',{method,args});if(response.error)throw Object.assign(Error(response.error),{code:response.error});return response.value;});tail=result.catch(()=>{});return result;};
 const controller=Object.fromEntries(metadata.methods.map(method=>[method,(...args)=>call(method,args)]));
 // Older live fixture metadata omitted this lifecycle method. The capability
 // is present on the same original controller; calling it only drops this
 // isolated test session. It cannot bind or adopt a different identity.
 if(!controller.disconnect)controller.disconnect=()=>call('disconnect',[]);
 return createGalaxyAdapter(controller,{dataDirectory:process.env.GALAXY_DATA_DIR,readWorkContext:async()=>metadata.context??null});
});
