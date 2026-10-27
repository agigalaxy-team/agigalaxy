import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
export default {skipTrailingSlashRedirect:true,output:"standalone",outputFileTracingRoot:root,poweredByHeader:false,turbopack:{root},webpack(config){config.resolve.alias={...config.resolve.alias,"@":root};return config;}};
