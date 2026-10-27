import {NextResponse,type NextRequest} from 'next/server';
import {readSiteContent} from './lib/site-content';
export async function proxy(request:NextRequest){
 const path=request.nextUrl.pathname;
 if(/^\/(?:_next|app|auth|api|v1|v2|admin|preview|__public-assets)(?:\/|$)/.test(path))return NextResponse.next();
 if(['/galaxy-web-config.json','/site-publication.json','/cms-routes.json'].includes(path))return NextResponse.next();
 if(!/\.(?:json|txt|xml|html|css|js|mjs|svg|png|jpe?g|gif|webp|avif|ico|md|zip|tgz|gz|exe|dmg|AppImage|deb|rpm|apk|jws|sig|sha256)$/i.test(path)){
  // React may commit a streamed 200 before a server component rejects a broken publication.
  // Resolve configured public content before entering that stream, without touching app/API routes.
  if(process.env.GALAXY_SITE_CONTENT_ROOT)try{await readSiteContent();}catch{return NextResponse.json({error:'site_content_unavailable'},{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
  return NextResponse.next();
 }
 // File dispatch is a relative framework rewrite in next.config. An absolute
 // NextURL normalizes loopback to localhost and can become an external HTTPS
 // request behind a TLS reverse proxy.
 return NextResponse.next();
}
export const config={matcher:['/((?!_next/static|_next/image).*)']};
