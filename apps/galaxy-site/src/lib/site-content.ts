import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';

export type SiteBlock={blockType:string;[key:string]:unknown};
export type SitePage={id:string;path:string;title:string;description:string;blocks:SiteBlock[];updatedAt:string};
export type SiteMedia={id:string;filename:string;url:string;alt:string;mimeType:string;filesize:number;width?:number|null;height?:number|null;credit?:string};
export type SiteSnapshot={version:1;settings:{siteTitle:string;description:string;footerLinks:{label:string;href:string}[]};pages:SitePage[];media:SiteMedia[]};
export type SiteContent={mode:'baseline';snapshot:null;publicationId:null}|{mode:'published';snapshot:SiteSnapshot;publicationId:string};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function safePublicFile(root:string,segments:string[],max=32*1024*1024){
 if(!segments.length||segments.some(part=>!part||part==='.'||part==='..'||/[\\/:]/.test(part)||Array.from(part).some(char=>char.charCodeAt(0)<32)))throw Error('Invalid public asset path');
 const base=await realpath(root),target=join(base,...segments),actual=await realpath(target),part=relative(base,actual);
 if(!part||isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw Error('Public asset escaped root');
 // Reject links even when they resolve within the tree; public files are build outputs.
 let current=base;for(const segment of segments){current=join(current,segment);if((await lstat(current)).isSymbolicLink())throw Error('Public asset link rejected');}
 const info=await lstat(actual);if(!info.isFile()||info.size>max)throw Error('Invalid public asset file');
 return {path:actual,size:info.size};
}
async function json(root:string,name:string,max:number){return JSON.parse(await readFile((await safePublicFile(root,[name],max)).path,'utf8'));}
/** A configured publication root is authoritative. Broken publications never become a stale baseline. */
export async function readSiteContent():Promise<SiteContent>{
 const configured=process.env.GALAXY_SITE_CONTENT_ROOT;
 if(!configured)return {mode:'baseline',snapshot:null,publicationId:null};
 const root=await realpath(resolve(configured)),marker=await json(root,'cms-publication.json',4096);
 if(marker.version===1&&marker.mode==='baseline'&&marker.publicationId===null)return {mode:'baseline',snapshot:null,publicationId:null};
 if(marker.mode!==undefined&&marker.mode!=='published')throw Error('Unknown active site publication mode');
 const snapshot=await json(root,'cms-snapshot.json',1048576);
 if(marker.version!==1||typeof marker.publicationId!=='string'||!uuid.test(marker.publicationId))throw Error('Invalid active site publication');
 if(snapshot.version!==1||!snapshot.settings||!Array.isArray(snapshot.pages)||!Array.isArray(snapshot.media))throw Error('Invalid active site snapshot');
 // Dynamically use the same domain validator as publication, including URL/block validation.
 const {contentSnapshotSchema}=await import('../../../../packages/galaxy-contracts/src/content-snapshot.mjs');
 const parsed=contentSnapshotSchema.parse(snapshot) as SiteSnapshot;
 return {mode:'published',snapshot:parsed,publicationId:marker.publicationId};
}
export async function readSitePage(path:string){
 const content=await readSiteContent(),page=content.snapshot?.pages.find(item=>item.path===path)??null;
 if(!page)return {mode:'baseline' as const,publicationId:null,page:null,settings:null,media:[] as SiteMedia[]};
 return {mode:'published' as const,publicationId:content.publicationId,page,settings:content.snapshot!.settings,media:content.snapshot!.media};
}
