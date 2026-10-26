import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createOidcLoginProvider} from './oidc-login.mjs';
import {createOidcTransactionStore} from './oidc-transaction-store.mjs';
import {createKeycloakAdminDirectory} from './keycloak-admin-directory.mjs';
import {createOperationsPortal} from './operations-auth.mjs';
import {loadOperationsRootPrincipal,rootOperationsRole,isOperationsRootPrincipal} from './operations-root-principal.mjs';
import {createOperationsManagementSessions} from './operations-management-sessions.mjs';
import {createKeycloakManagementAccounts} from './keycloak-management-accounts.mjs';
import {createManagementEmailChanges} from './management-email-changes.mjs';
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
function validBusinessDirectoryReference(value){
  return value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.hasOwn(value,'issuer')&&Object.hasOwn(value,'credentialFile')
    &&Object.keys(value).every(key=>['issuer','credentialFile','writerCredentialFile'].includes(key))
    &&(!Object.hasOwn(value,'writerCredentialFile')||typeof value.writerCredentialFile==='string'
      &&isAbsolute(value.writerCredentialFile)&&value.writerCredentialFile!==value.credentialFile);
}
function validManagementAccountsReference(value){
  return value===undefined||value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).sort().join(',')==='writerCredentialFile'
    &&typeof value.writerCredentialFile==='string'&&isAbsolute(value.writerCredentialFile);
}

// Only a stored operator ID selects the upstream identity. Queue payloads
// cannot choose a Keycloak subject or carry the original browser credential.
export function createStoredOperatorAuthorization({db,endpoint,issuer,roles,roleDirectory,rootPrincipal=null,managementSessions=null}){
  return async(actor,{db:connection=db}={})=>{
    if(actor?.kind!=='business-operator'||actor.endpoint!==endpoint||typeof actor.operatorId!=='string')throw new ServiceError('business_admin_denied',403);
    const row=(await connection.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,actor.operatorId])).rows[0];
    if(!row||row.issuer!==issuer)throw new ServiceError('business_admin_denied',403);
    const principal={issuer,externalSubject:row.external_subject,operatorId:actor.operatorId};
    if(managementSessions)await managementSessions.assertActive(principal,{db:connection});
    let names;try{names=await roleDirectory.getOperatorRoles({issuer,externalSubject:row.external_subject});}
    catch{throw new ServiceError('identity_directory_unavailable',503);}
    const role=rootOperationsRole(rootPrincipal,principal,names,roles);
    if(!role)throw new ServiceError('business_admin_denied',403);
    return role;
  };
}

// Admission to the management surface and permission to maintain its people
// are separate. A role code alone must not turn an ordinary account into a
// manager. Native administrator admission is read afresh for this boundary.
export function createStoredManagementMaintainerAuthorization({db,endpoint,issuer,rootPrincipal,managementDirectory,managementSessions=null}){
  return async(actor,{db:connection=db}={})=>{
    if(actor?.kind!=='business-operator'||actor.endpoint!==endpoint||typeof actor.operatorId!=='string')throw new ServiceError('business_admin_denied',403);
    const row=(await connection.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,actor.operatorId])).rows[0];
    if(!row||row.issuer!==issuer||createHash('sha256').update(row.issuer+'\0'+row.external_subject).digest('hex')!==actor.operatorId)
      throw new ServiceError('business_admin_denied',403);
    const principal={issuer,externalSubject:row.external_subject,operatorId:actor.operatorId};
    if(managementSessions)await managementSessions.assertActive(principal,{db:connection});
    if(isOperationsRootPrincipal(rootPrincipal,principal))return true;
    if(typeof managementDirectory?.get!=='function')throw new ServiceError('operations_authorization_unavailable',503);
    const user=await managementDirectory.get(principal);
    return !!user&&user.issuer===issuer&&user.externalSubject===principal.externalSubject&&user.enabled===true&&user.admission==='administrator';
  };
}

export async function loadOperationsWorkerAuthorization(path,{db,endpoint}={}){
  if(!path)return null;
  const config=await privateJson(path),{directoryOrigin,accountDirectory:_accountDirectory,rootOperatorFile,managementAccounts,...core}=config;
  if(config.version!==1||Object.keys(core).sort().join(',')!=='adminOrigin,clientId,directoryCredentialFile,issuer,roles,version'
    ||!validManagementAccountsReference(managementAccounts))throw Error('Invalid operations worker configuration.');
  origin(config.adminOrigin);
  const issuer=new URL(config.issuer);
  if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash||issuer.href!==config.issuer)throw Error('Invalid operations issuer.');
  const roles=config.roles;
  if(!roles||Object.keys(roles).sort().join(',')!=='administrator,reader'||Object.values(roles).some(value=>typeof value!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(value))||roles.administrator===roles.reader)throw Error('Invalid operations roles.');
  const credential=await privateJson(config.directoryCredentialFile);
  if(Object.keys(credential).sort().join(',')!=='clientId,clientSecret,version'||credential.version!==1||!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(credential.clientId??'')||typeof credential.clientSecret!=='string'||!credential.clientSecret||credential.clientSecret.length>4096)throw Error('Invalid operations directory credential.');
  const roleDirectory=createKeycloakAdminDirectory({issuer:config.issuer,adminOrigin:directoryOrigin,clientId:credential.clientId,clientSecret:credential.clientSecret});
  const rootPrincipal=await loadOperationsRootPrincipal(rootOperatorFile,{endpoint,issuer:config.issuer});
  const managementSessions=createOperationsManagementSessions({db,endpoint,issuer:config.issuer,roleDirectory});
  return createStoredOperatorAuthorization({db,endpoint,issuer:config.issuer,roles,roleDirectory,rootPrincipal,managementSessions});
}

// Messaging workers need only the existing read-only business directory, not a
// browser session or an account-management write credential.
export async function loadOperationsAccountDirectory(path){
  if(!path)return null;
  const config=await privateJson(path),directory=config.accountDirectory;
  if(config.version!==1||!validBusinessDirectoryReference(directory)||directory.issuer===config.issuer)throw Error('Invalid business directory reference.');
  const credential=await privateJson(directory.credentialFile);
  if(Object.keys(credential).sort().join(',')!=='clientId,clientSecret,version'||credential.version!==1
    ||!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(credential.clientId??'')||typeof credential.clientSecret!=='string'||!credential.clientSecret||credential.clientSecret.length>4096)throw Error('Invalid business directory credential.');
  return createKeycloakAdminDirectory({issuer:directory.issuer,adminOrigin:config.directoryOrigin,clientId:credential.clientId,clientSecret:credential.clientSecret});
}

// Paths point to protected deployment configuration, never to CMS fields.
export async function loadOperationsConfiguration(path,{db,endpoint,permissions=null,factory=createOidcLoginProvider}={}) {
  if (!path) return null;
  const config=await privateJson(path);
  const {directoryOrigin,accountDirectory,rootOperatorFile,managementAccounts,...core}=config;
  if (config.version!==1 || Object.keys(core).sort().join(',')!=='adminOrigin,clientId,directoryCredentialFile,issuer,roles,version'
    || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(config.clientId??'')||!validManagementAccountsReference(managementAccounts)) throw Error('Invalid operations configuration.');
  origin(config.adminOrigin);
  const issuer=new URL(config.issuer);
  if (issuer.protocol!=='https:' || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.href!==config.issuer)
    throw Error('Invalid operations issuer.');
  if(!validBusinessDirectoryReference(accountDirectory)
    ||typeof accountDirectory.issuer!=='string'||accountDirectory.issuer===config.issuer)throw Error('Independent management and business identity directories required.');
  const businessCredential=await privateJson(accountDirectory.credentialFile);
  if(Object.keys(businessCredential).sort().join(',')!=='clientId,clientSecret,version'||businessCredential.version!==1
    ||!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(businessCredential.clientId??'')||typeof businessCredential.clientSecret!=='string'
    ||!businessCredential.clientSecret||businessCredential.clientSecret.length>4096)throw Error('Invalid business directory credential.');
  const credential=await privateJson(config.directoryCredentialFile);
  if (Object.keys(credential).sort().join(',')!=='clientId,clientSecret,version' || credential.version!==1
    || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(credential.clientId??'') || typeof credential.clientSecret!=='string'
    || !credential.clientSecret || credential.clientSecret.length>4096) throw Error('Invalid operations directory credential.');
  let managementWriter=null;
  if(managementAccounts){
    if(managementAccounts.writerCredentialFile===config.directoryCredentialFile||managementAccounts.writerCredentialFile===accountDirectory.credentialFile
      ||managementAccounts.writerCredentialFile===accountDirectory.writerCredentialFile)throw Error('Independent management writer required.');
    managementWriter=await privateJson(managementAccounts.writerCredentialFile);
    if(Object.keys(managementWriter).sort().join(',')!=='clientId,clientSecret,version'||managementWriter.version!==1
      ||!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(managementWriter.clientId??'')||typeof managementWriter.clientSecret!=='string'
      ||!managementWriter.clientSecret||managementWriter.clientSecret.length>4096||[credential.clientId,businessCredential.clientId].includes(managementWriter.clientId))
      throw Error('Invalid protected management writer.');
  }
  const namespace='operations:'+createHash('sha256').update(JSON.stringify({endpoint,origin:config.adminOrigin,issuer:config.issuer,clientId:config.clientId})).digest('hex');
  const provider=await factory({id:'operations-admin',name:'银河运营管理',issuer:config.issuer,clientId:config.clientId,
    redirectUri:config.adminOrigin+'/v1/operations/callback',includeAccountProfile:true,includeOperatorRoles:true,
    transactionStore:createOidcTransactionStore({db,namespace})});
  const roleDirectory=createKeycloakAdminDirectory({issuer:config.issuer,adminOrigin:directoryOrigin,clientId:credential.clientId,clientSecret:credential.clientSecret});
  const identityDirectory=createKeycloakAdminDirectory({issuer:accountDirectory.issuer,adminOrigin:directoryOrigin,clientId:businessCredential.clientId,clientSecret:businessCredential.clientSecret});
  const rootPrincipal=await loadOperationsRootPrincipal(rootOperatorFile,{endpoint,issuer:config.issuer});
  const managementSessions=createOperationsManagementSessions({db,endpoint,issuer:config.issuer,roleDirectory});
  const managementEmailChanges=managementWriter?createManagementEmailChanges({issuer:config.issuer,
    privateOrigin:directoryOrigin??new URL(config.issuer).origin,writer:managementWriter}):null;
  const managementDirectory=createKeycloakManagementAccounts({issuer:config.issuer,adminOrigin:directoryOrigin,
    reader:credential,writer:managementWriter,roleNames:config.roles,emailChanges:managementEmailChanges});
  const portal=createOperationsPortal({provider,db,endpoint,adminOrigin:config.adminOrigin,roleDirectory,roles:config.roles,permissions,rootPrincipal,managementSessions});
  return Object.freeze({portal,identityDirectory,rootPrincipal,managementSessions,managementDirectory,roleDirectory,
    authorizeStoredOperator:createStoredOperatorAuthorization({db,endpoint,issuer:config.issuer,roles:config.roles,roleDirectory,rootPrincipal,managementSessions}),
    authorizeManagementMaintainer:createStoredManagementMaintainerAuthorization({db,endpoint,issuer:config.issuer,rootPrincipal,managementDirectory,managementSessions}),
    adminOrigin:config.adminOrigin,configurationId:portal.configurationId});
}
