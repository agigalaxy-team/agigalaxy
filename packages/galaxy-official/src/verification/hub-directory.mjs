import { builderDeclarationSchema } from '../shared/builders-schema.mjs';
import { HUB_MANIFEST_PROFILE,verifyHubManifest } from './manifest.mjs';

// Pins come from the host's independent trust configuration, never from the
// directory declaration, a Manifest hint, or a key fetched from that Manifest.
export async function verifyHubDirectoryManifest(document,{declaration,trustedKeys,now}){
  const declared=builderDeclarationSchema.parse(declaration);
  if(declared.type!=='hub'||declared.manifest.specVersion!==HUB_MANIFEST_PROFILE||declared.manifest.url!==declared.endpoint+'/.well-known/galaxy-network.json')
    throw new Error('Unsupported Hub directory Manifest profile.');
  const verified=await verifyHubManifest(document,{endpoint:declared.endpoint,trustedKeys,now}),data=verified.data;
  const fields={name:data.displayName,operator:data.operator,region:data.region,scope:data.hub.scope,charter:data.hub.charter,
    policy:data.policy.url,exit:data.hub.exit,export:data.hub.export};
  const differences=Object.keys(fields).filter(key=>declared[key]!==fields[key]);
  if(declared.release.version!==data.serviceVersion)differences.push('release.version');
  if(declared.manifest.sha256!==verified.manifestSha256)differences.push('manifest.sha256');
  return {...verified,directoryState:differences.length?'mismatch':'matched',differences,
    scope:'current-signed-manifest-and-directory-metadata',directoryOwnerVerified:false,capabilityVerified:false,connected:false,authorized:false};
}
