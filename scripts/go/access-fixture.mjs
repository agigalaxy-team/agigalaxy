// Original portal constructors define the current persisted scope hashes.
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createOfficialAccountPortal} from '../../packages/galaxy-official/src/accounts/official-account.mjs';
import {createOperationsPortal} from '../../packages/galaxy-official/src/operations/permissions/auth.mjs';
const directory=resolve(process.argv[2]);
if(!directory.startsWith(resolve(tmpdir())+'\\')&&!directory.startsWith(resolve(tmpdir())+'/'))throw Error('fixture_requires_os_temporary_directory');
await mkdir(directory,{recursive:true});
const endpoint='https://api.example.invalid',websiteOrigin='https://web.example.invalid',adminOrigin='https://admin.example.invalid',issuer='https://login.example.invalid/realms/management',business='https://login.example.invalid/realms/community';
const operatorId=createHash('sha256').update(issuer+'\0fixture-root').digest('hex'),root={version:1,endpoint,issuer,externalSubject:'fixture-root',operatorId};
const rootFile=join(directory,'root.json'),accountFile=join(directory,'account.json'),operationsFile=join(directory,'operations.json'),identityFile=join(directory,'identity.json'),credentialFile=join(directory,'directory.json');
// Reader first is deliberate: changing JSON key order would orphan old sessions.
const roles={reader:'galaxy-reader',administrator:'galaxy-administrator'};
const accountProvider={describe:()=>({issuer:business,clientId:'website-account',redirectUri:endpoint+'/v1/account/callback'})},associations=['z-last','a-first'].map(clientId=>({describe:()=>({issuer:business,clientId})}));
const account=createOfficialAccountPortal({provider:accountProvider,db:null,endpoint,websiteOrigin,associationProviders:associations});
const operations=createOperationsPortal({provider:{describe:()=>({issuer,clientId:'management',redirectUri:adminOrigin+'/v1/operations/callback'})},db:null,endpoint,adminOrigin,roles,rootPrincipal:root,roleDirectory:{getOperatorRoles:async()=>[]}});
for(const [file,value]of [[rootFile,root],[credentialFile,{version:1,clientId:'directory-reader',clientSecret:'temporary-fixture-only'}],
 [accountFile,{version:1,clientId:'website-account',issuer:business,websiteOrigin}],
 [operationsFile,{version:1,adminOrigin,issuer,clientId:'management',roles,directoryCredentialFile:credentialFile,rootOperatorFile:rootFile,accountDirectory:{issuer:business,credentialFile}}],
 [identityFile,{version:1,providers:associations.map((provider,index)=>({id:'provider-'+index,name:'Fixture association',...provider.describe()}))}]])await writeFile(file,JSON.stringify(value),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({endpoint,accountFile,operationsFile,identityFile,accountScope:account.configurationHash,operatorConfiguration:operations.configurationId,rootID:operatorId}));
