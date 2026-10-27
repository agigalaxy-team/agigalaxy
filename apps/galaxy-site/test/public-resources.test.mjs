import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {servePublicResource} from '../src/lib/public-resources.ts';
import {readSitePage} from '../src/lib/site-content.ts';
test('public manifest admits exact files and never publication inputs or path escapes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'galaxy-site-assets-'));
 const old=process.env.GALAXY_SITE_PUBLIC_ROOT;process.env.GALAXY_SITE_PUBLIC_ROOT=root;
 t.after(async()=>{if(old===undefined)delete process.env.GALAXY_SITE_PUBLIC_ROOT;else process.env.GALAXY_SITE_PUBLIC_ROOT=old;assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'assets'));await writeFile(join(root,'assets','site.css'),'body{}');
 await writeFile(join(root,'cms-snapshot.json'),'private fixture');
 await writeFile(join(root,'public-assets.json'),JSON.stringify({version:1,files:[{path:'assets/site.css',contentType:'text/css'},{path:'cms-snapshot.json',contentType:'application/json'}]}));
 const allowed=await servePublicResource(['assets','site.css']);assert.equal(allowed.status,200);assert.equal(await allowed.text(),'body{}');
 for(const path of [['cms-snapshot.json'],['public-assets.json'],['assets','..','cms-snapshot.json'],['assets','missing.css'],['assets','../cms-snapshot.json']])assert.equal((await servePublicResource(path)).status,404);
 try{await symlink(join(root,'cms-snapshot.json'),join(root,'assets','linked.css'),'file');}catch(error){if(['EPERM','EACCES'].includes(error.code))return;throw error;}
 await writeFile(join(root,'public-assets.json'),JSON.stringify({version:1,files:[{path:'assets/linked.css',contentType:'text/css'}]}));
 assert.equal((await servePublicResource(['assets','linked.css'])).status,404);
});
test('an explicitly configured broken publication never falls back to baseline',async()=>{
 const old=process.env.GALAXY_SITE_CONTENT_ROOT;delete process.env.GALAXY_SITE_CONTENT_ROOT;
 try{assert.equal((await readSitePage('/')).mode,'baseline');process.env.GALAXY_SITE_CONTENT_ROOT=join(tmpdir(),'galaxy-nonexistent-content-fixture');await assert.rejects(readSitePage('/'));}
 finally{if(old===undefined)delete process.env.GALAXY_SITE_CONTENT_ROOT;else process.env.GALAXY_SITE_CONTENT_ROOT=old;}
});

test('published pages and media require the activated snapshot selection',async t=>{
 const root=await mkdtemp(join(tmpdir(),'galaxy-site-publication-')),old=process.env.GALAXY_SITE_CONTENT_ROOT;process.env.GALAXY_SITE_CONTENT_ROOT=root;
 t.after(async()=>{if(old===undefined)delete process.env.GALAXY_SITE_CONTENT_ROOT;else process.env.GALAXY_SITE_CONTENT_ROOT=old;assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
 await mkdir(join(root,'media'));await writeFile(join(root,'media','image.png'),'image');
 await writeFile(join(root,'cms-publication.json'),JSON.stringify({version:1,publicationId:'12345678-1234-4234-8234-123456789abc'}));
 await writeFile(join(root,'cms-snapshot.json'),JSON.stringify({version:1,settings:{siteTitle:'Fixture',description:'',footerLinks:[]},pages:[{id:'help',path:'/help/',title:'Published help',description:'',blocks:[{blockType:'image',mediaId:'image',caption:''}],updatedAt:'2026-10-27T00:00:00Z'}],media:[{id:'image',filename:'image.png',url:'/media/cms/image/image.png',alt:'Image',mimeType:'image/png',filesize:5}]}));
 const page=await readSitePage('/help/');assert.equal(page.mode,'published');assert.equal(page.page.title,'Published help');assert.equal((await readSitePage('/other/')).mode,'baseline');
 assert.equal((await servePublicResource(['media','cms','image','image.png'])).status,200);
 assert.equal((await servePublicResource(['media','cms','unselected','image.png'])).status,404);
});

test('only an explicit baseline marker represents an unpublished configured root',async t=>{
 const root=await mkdtemp(join(tmpdir(),'galaxy-site-baseline-')),old=process.env.GALAXY_SITE_CONTENT_ROOT;process.env.GALAXY_SITE_CONTENT_ROOT=root;
 t.after(async()=>{if(old===undefined)delete process.env.GALAXY_SITE_CONTENT_ROOT;else process.env.GALAXY_SITE_CONTENT_ROOT=old;assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
 await writeFile(join(root,'cms-publication.json'),JSON.stringify({version:1,publicationId:null,mode:'baseline'}));assert.equal((await readSitePage('/')).mode,'baseline');
 await writeFile(join(root,'cms-publication.json'),JSON.stringify({version:1,publicationId:null,mode:'unknown'}));await assert.rejects(readSitePage('/'));
});
