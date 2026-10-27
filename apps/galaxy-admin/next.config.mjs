import {withPayload} from '@payloadcms/next/withPayload';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePayloadUiClientImports} from './scripts/payload-ui-client-imports.mjs';
const appRoot=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(appRoot,'../..');
const payloadUiClient=preparePayloadUiClientImports(appRoot);
// Resolve shared server contracts from this independently installed app.
const sharedContractZodEntry='./node_modules/zod/index.js';

export default withPayload({
  output:'standalone',
  deploymentId:process.env.GALAXY_WEB_DEPLOYMENT_ID,
  outputFileTracingRoot:repositoryRoot,
  turbopack:{root:repositoryRoot,rules:payloadUiClient.turbopackRules,resolveAlias:{zod:sharedContractZodEntry}},
  webpack(config){
    config.resolve??={};
    config.resolve.alias={...config.resolve.alias,'zod$':path.resolve(appRoot,sharedContractZodEntry)};
    config.module??={};
    config.module.rules??=[];
    config.module.rules.push(payloadUiClient.webpackRule);
    return config;
  },
  poweredByHeader:false,
  async headers(){return [{source:'/:path*',headers:[
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'same-origin'},
    {key:'X-Frame-Options',value:'SAMEORIGIN'},
  ]}];},
});
