import {readSiteContent} from '../../lib/site-content';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){try{const content=await readSiteContent();return Response.json({version:1,routes:content.snapshot?.pages.map(page=>page.path).filter(path=>path!=='/')??[]},{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch{return Response.json({error:'site_content_unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});}}
