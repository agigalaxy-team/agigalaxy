import {withPayload} from '@payloadcms/next/withPayload';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const appRoot=path.dirname(fileURLToPath(import.meta.url));

export default withPayload({
  output:'standalone',
  outputFileTracingRoot:appRoot,
  turbopack:{root:appRoot},
  poweredByHeader:false,
  async headers(){return [{source:'/:path*',headers:[
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'same-origin'},
    {key:'X-Frame-Options',value:'SAMEORIGIN'},
  ]}];},
});
