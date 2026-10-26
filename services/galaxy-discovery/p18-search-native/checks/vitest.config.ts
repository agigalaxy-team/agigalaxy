import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('../../apps/api/src',import.meta.url))}},test:{include:['galaxy-p18-search-native/checks/chart-series-id.test.ts'],fileParallelism:false,maxWorkers:1,env:{SELF_HOSTED:'true'}}});
