import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {parseComponentRelease} from './release-identifiers.mjs';

export function nativeArtifactFilename(metadata){
 if(metadata?.name!=='@galaxy/native-client'||!parseComponentRelease(metadata.version)
  ||metadata.filename!==`galaxy-native-client-${metadata.version}.tgz`)
  throw new Error('Unexpected native package filename');
 return metadata.filename;
}

export async function downloadedLocal(directory,name,limit){
 if(typeof name!=='string'||!/^[a-zA-Z0-9._-]+$/.test(name)||name==='.'||name==='..')throw new Error('Unexpected downloaded member');
 const path=join(directory,name),info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>limit||await realpath(path)!==resolve(path))throw new Error('Unexpected downloaded file');
 return readFile(path);
}
