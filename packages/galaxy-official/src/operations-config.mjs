import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createOidcLoginProvider} from './oidc-login.mjs';
import {createOidcTransactionStore} from './oidc-transaction-store.mjs';
import {createKeycloakAdminDirectory} from './keycloak-admin-directory.mjs';
import {createOperationsPortal} from './operations-auth.mjs';
import {ServiceError} from './shared/service-error.mjs';

async function privateJson(path, limit=16384) {
  if (!isAbsolute(path)) throw Error('Absolute operations configuration reference required.');
  const info=await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size>limit || process.platform!=='win32' && (info.mode&0o007))
    throw Error('Invalid protected operations configuration.');
  return JSON.parse(await readFile(path,'utf8'));
}
function origin(value) {
  const url=new URL(value);
  if (url.origin!==value || url.protocol!=='https:' || url.username || url.password) throw Error('Exact HTTPS operations origin required.');
  return value;
}

// Only a stored operator ID selects the upstream identity. Queue payloads
// cannot choose a Keycloak subject or carry the original browser credential.
export function createStoredOperatorAuthorization({db,endpoint,issuer,roles,roleDirectory}){
  return async(actor,{db:connection=db}={})=>{
    if(actor?.kind!=='business-operator'||actor.endpoint!==endpoint||typeof actor.operatorId!=='string')throw new ServiceError('business_admin_denied',403);
    const row=(await connection.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,actor.operatorId])).rows[0];
    if(!row||row.issuer!==issuer)throw new ServiceError('business_admin_denied',403);
    let names;try{names=await roleDirectory.getOperatorRoles({issuer,externalSubject:row.external_subject});}
    catch{throw new ServiceError('identity_directory_unavailable',503);}
    const role=Array.isArray(names)?names.includes(roles.administrator)?'administrator':names.includes(roles.reader)?'reader':null:null;
    if(!role)throw new ServiceError('business_admin_denied',403);
    return role;
  };
}

export async function loadOperationsWorkerAuthorization(path,{db,endpoint}={}){
  if(!path)return null;
  const config=await privateJson(path),{directoryOrigin,accountDirectory,...core}=config;
  if(config.version!==1||Object.keys(core).sort().join(',')!=='adminOrigin,clientId,directoryCredentialFile,issuer,roles,version')throw Error('Invalid operations worker configuration.');
  origin(config.adminOrigin);
  const issuer=new URL(config.issuer);
  if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash||issuer.href!==config.issuer)throw Error('Invalid operations issuer.');
  const roles=config.roles;
  if(!roles||Object.keys(roles).sort().join(',')!=='administrator,reader'||Object.values(roles).some(value=>typeof value!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(value))||roles.administrator===roles.reader)throw Error('Invalid operations roles.');
  const credential=await privateJson(config.directoryCredentialFile);
  if(Object.keys(credential).sort().join(',')!=='clientId,clientSecret,version'||credential.version!==1||!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(credential.clientId??'')||typeof credential.clientSecret!=='string'||!credential.clientSecret||credential.clientSecret.length>4096)throw Error('Invalid operations directory credential.');
  const roleDirectory=createKeycloakAdminDirectory({issuer:config.issuer,adminOrigin:directoryOrigin,clientId:credential.clientId,clientSecret:credential.clientSecret});
  return createStoredOperatorAuthorization({db,endpoint,issuer:config.issuer,roles,roleDirectory});
}

// Paths point to protected deployment configuration, never to CMS fields.
export async function loadOperationsConfiguration(path,{db,endpoint,factory=createOidcLoginProvider}={}) {
  if (!path) return null;
  const config=await privateJson(path);
  const {directoryOrigin,accountDirectory,...core}=config;
  if (config.version!==1 || Object.keys(core).sort().join(',')!=='adminOrigin,clientId,directoryCredentialFile,issuer,roles,version'
    || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(config.clientId??'')) throw Error('Invalid operations configuration.');
  origin(config.adminOrigin);
  const issuer=new URL(config.issuer);
  if (issuer.protocol!=='https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.href!==config.issuer)
    throw Error('Invalid operations issuer.');
  if(!accountDirectory||Object.keys(accountDirectory).sort().join(',')!=='credentialFile,issuer'
    ||typeof accountDirectory.issuer!=='string'||accountDirectory.issuer===config.issuer)throw Error('Independent management and business identity directories required.');
  const businessCredential=await privateJson(accountDirectory.credentialFile);
  if(Object.keys(businessCredential).sort().join(',')!=='clientId,clientSecret,version'||businessCredential.version!==1
    ||!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(businessCredential.clientId??'')||typeof businessCredential.clientSecret!=='string'
    ||!businessCredential.clientSecret||businessCredential.clientSecret.length>4096)throw Error('Invalid business directory credential.');
  const credential=await privateJson(config.directoryCredentialFile);
  if (Object.keys(credential).sort().join(',')!=='clientId,clientSecret,version' || credential.version!==1
    || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(credential.clientId??'') || typeof credential.clientSecret!=='string'
    || !credential.clientSecret || credential.clientSecret.length>4096) throw Error('Invalid operations directory credential.');
  const namespace='operations:'+createHash('sha256').update(JSON.stringify({endpoint,origin:config.adminOrigin,issuer:config.issuer,clientId:config.clientId})).digest('hex');
  const provider=await factory({id:'operations-admin',name:'银河运营管理',issuer:config.issuer,clientId:config.clientId,
    redirectUri:config.adminOrigin+'/v1/operations/callback',includeAccountProfile:true,includeOperatorRoles:true,
    transactionStore:createOidcTransactionStore({db,namespace})});
  const roleDirectory=createKeycloakAdminDirectory({issuer:config.issuer,adminOrigin:directoryOrigin,clientId:credential.clientId,clientSecret:credential.clientSecret});
  const identityDirectory=createKeycloakAdminDirectory({issuer:accountDirectory.issuer,adminOrigin:directoryOrigin,clientId:businessCredential.clientId,clientSecret:businessCredential.clientSecret});
  const portal=createOperationsPortal({provider,db,endpoint,adminOrigin:config.adminOrigin,roleDirectory,roles:config.roles});
  return Object.freeze({portal,identityDirectory,authorizeStoredOperator:createStoredOperatorAuthorization({db,endpoint,issuer:config.issuer,roles:config.roles,roleDirectory}),adminOrigin:config.adminOrigin,configurationId:portal.configurationId});
}
