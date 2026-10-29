// Synthetic historical bytes captured from the retired Node implementation.
import {constants} from 'node:fs';
import {copyFile, mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../../../../go/internal/native/testdata/legacy-native/',import.meta.url));
const files=['galaxy-id.json','public-key.txt','galaxy-local-state.json','expected.json','work-history/history.sqlite','conversation-archive/private.sqlite'];
export async function copyLegacyNativeFixture(destination){
 for(const name of files){
  const target=join(destination,name==='public-key.txt'?'galaxy-id-public-key.pem':name);
  await mkdir(dirname(target),{recursive:true});
  await copyFile(join(source,name),target,constants.COPYFILE_EXCL);
 }
}
