import {NextResponse,type NextRequest} from 'next/server';
import {operatorLoginTarget} from './lib/operator-login-target.mjs';

export function proxy(request:NextRequest){
 // A completed rejection must remain a recovery page, never an SSO loop.
 if(['denied','stale'].includes(request.nextUrl.searchParams.get('reason')??''))return NextResponse.next();
 // A React navigation must render the login bridge, not fetch an OIDC redirect
 // with Next's private _rsc query attached to the authentication endpoint.
 if(request.headers.get('rsc')==='1'||request.headers.get('sec-fetch-dest')==='empty')return NextResponse.next();
 const origin=process.env.GALAXY_ADMIN_PUBLIC_ORIGIN??request.nextUrl.origin;
 const target=new URL('/v1/operations/login',origin);
 target.searchParams.set('returnTo',operatorLoginTarget(request.nextUrl.searchParams.get('redirect')));
 return NextResponse.redirect(target,307);
}
export const config={matcher:['/admin/login']};
