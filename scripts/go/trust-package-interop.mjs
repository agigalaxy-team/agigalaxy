// Independent contract oracle for canonical trust bytes; no service or database.
import {readFile} from 'node:fs/promises';
import {trustCanonical} from '../../packages/galaxy-contracts/src/trust-package-crypto.mjs';
if(process.argv[2]!=='canonical')throw Error('unknown mode');
const values=JSON.parse(await readFile(process.argv[3],'utf8'));
console.log(JSON.stringify(values.map(value=>{try{return {accepted:true,value:trustCanonical(value)}}catch{return {accepted:false}}})));
