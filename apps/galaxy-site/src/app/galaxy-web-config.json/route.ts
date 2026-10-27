import {publicConfiguration} from '../../../../../packages/galaxy-web/server/public-configuration.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
export async function GET(){try{return Response.json(await publicConfiguration(),{headers});}catch{return Response.json({error:'website_configuration_required'},{status:503,headers});}}
