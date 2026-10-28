// Generates only embedded existing business schema SQL; never connects to a DB.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {migrations} from '../../../packages/galaxy-official/src/infrastructure/migrations.mjs';
const root=new URL('./',import.meta.url);
await mkdir(new URL('sql/',root),{recursive:true});
for(const {version,sql} of migrations) await writeFile(new URL(`sql/${version}.sql`,root),sql,'utf8');
const roles=['api','worker','deletion-review','content-publisher'];
for(const role of roles) await writeFile(new URL(`sql/${role}-role.sql`,root),await readFile(new URL(`../../../packages/galaxy-official/src/infrastructure/${role}-role.sql`,root)));
await writeFile(new URL('catalog.gen.go',root),'// Code generated from infrastructure/migrations.mjs assembled SQL; DO NOT EDIT.\npackage databaseschema\n\nvar migrationVersions = [...]int{'+migrations.map(x=>x.version).join(',')+'}\n','utf8');
process.stdout.write(`Generated ${migrations.length} original migrations and ${roles.length} original role scripts.\n`);
