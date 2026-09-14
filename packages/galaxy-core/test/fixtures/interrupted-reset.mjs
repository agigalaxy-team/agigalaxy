import { withLocalWrite } from '../../src/storage/write-lock.mjs';
import { resetLocalFiles } from '../../src/storage/reset.mjs';
import { localPaths } from '../../src/storage/files.mjs';
const [directory, stopAt] = process.argv.slice(2);
await withLocalWrite(directory, () => resetLocalFiles(localPaths(directory), async phase => {
  if (phase === stopAt) {
    process.send({ phase });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
}));
