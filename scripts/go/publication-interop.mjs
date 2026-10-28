// Interop consumes only caller-provided synthetic files and loopback test DB.
import {readFile,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createFilesystemContentPublisher,loadContentPublisherConfiguration} from '../../packages/galaxy-official/src/publishing/content-publisher-files.mjs';
import {contentSnapshotSchema,publicationView} from '../../packages/galaxy-official/src/publishing/content-publications.mjs';
const action=process.argv[2];
if(action==='validate'){
 const path=resolve(process.argv[3]);if(!path.includes('galaxy-publication-test-'))throw Error('synthetic schema corpus required');
 const values=JSON.parse(await readFile(path,'utf8'));console.log(JSON.stringify(values.map(value=>contentSnapshotSchema.safeParse(value).success)));
}else if(action==='setup'||action==='read'){
 const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
 if(address.protocol!=='postgres:'||address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
 const pool=new pg.Pool({connectionString:address.href,max:3});try{if(action==='setup'){await migrate(pool);console.log('{}');}else{const row=(await pool.query('SELECT * FROM site_publications_v1 WHERE id=$1',[process.argv[3]])).rows[0];console.log(JSON.stringify(publicationView(row)));}}finally{await pool.end();}
}else{
 const path=resolve(process.argv[3]);
 if(!path.includes('galaxy-publication-test-'))throw Error('synthetic temporary publisher root required');
 const config=await loadContentPublisherConfiguration(path),publisher=await createFilesystemContentPublisher(config);
 if(action==='prepare'){const snapshot=contentSnapshotSchema.parse(JSON.parse(await readFile(process.argv[4],'utf8')));console.log(JSON.stringify(await publisher.prepare({publicationId:process.argv[5],snapshot})));}
 else if(action==='read-files'){
  const root=await realpath(process.argv[4]),snapshot=contentSnapshotSchema.parse(JSON.parse(await readFile(join(root,'cms-snapshot.json'),'utf8'))),media={};
  for(const name of await readdir(join(root,'media')))media[name]=(await readFile(join(root,'media',name))).toString('base64');
  console.log(JSON.stringify({snapshot,marker:JSON.parse(await readFile(join(root,'cms-publication.json'),'utf8')),media,current:await publisher.current(),files:await readdir(root)}));
 }else if(action==='activate'){const artifact=JSON.parse(await readFile(process.argv[4],'utf8'));await publisher.activate(artifact);console.log(JSON.stringify(await publisher.current()));}
 else throw Error('fixture action required');
}

