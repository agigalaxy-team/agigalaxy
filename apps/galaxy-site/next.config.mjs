import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const publicFile='/:file((?!_next/|app/|auth/|api/|v1/|v2/|admin/|preview/|__public-assets/|galaxy-web-config[.]json$|site-publication[.]json$|cms-routes[.]json$).+[.](?:json|txt|xml|html|css|js|mjs|svg|png|jpe?g|gif|webp|avif|ico|md|zip|tgz|gz|exe|dmg|AppImage|deb|rpm|apk|jws|sig|sha256))';
const config={deploymentId:process.env.GALAXY_WEB_DEPLOYMENT_ID,skipTrailingSlashRedirect:true,output:"standalone",outputFileTracingRoot:root,poweredByHeader:false,turbopack:{root},async rewrites(){return {beforeFiles:[{source:publicFile,destination:'/__public-assets/:file'}]};},webpack(config){config.resolve.alias={...config.resolve.alias,"@":root};return config;}};
export default config;
