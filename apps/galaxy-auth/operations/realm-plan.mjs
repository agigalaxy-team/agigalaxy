export const operationsRealm='galaxy-operations';
export const operationsLoginTheme='galaxy-operations';
export const operationsRoleNames=Object.freeze({administrator:'galaxy-operations-administrator',reader:'galaxy-operations-reader'});
export const operationsClientIds=Object.freeze({web:'galaxy-operations-web',directory:'galaxy-operations-directory',grafana:'galaxy-operations-grafana',businessDirectory:'galaxy-business-directory'});
const roleScopeName='galaxy-operations-roles';
const realmRoles=Object.values(operationsRoleNames);
function exactOrigin(value,name,allowLoopbackHttp){
  let url;try{url=new URL(value);}catch{throw Error(name+' must be an absolute origin');}
  if(value!==url.origin||url.username||url.password||url.protocol!=='https:'&&!(allowLoopbackHttp&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw Error(name+' requires HTTPS or explicit literal-loopback HTTP');
  return url.origin;
}
function clientName(value){if(typeof value!=='string'||!/^[a-z][a-z0-9-]{2,79}$/.test(value))throw Error('Invalid dedicated client name');return value;}
function clientBase(clientId,name){return {clientId,name,enabled:true,protocol:'openid-connect',publicClient:false,standardFlowEnabled:false,implicitFlowEnabled:false,directAccessGrantsEnabled:false,serviceAccountsEnabled:false,fullScopeAllowed:false,consentRequired:false,redirectUris:[],webOrigins:[],optionalClientScopes:[]};}

/** Native role mapper: emits actual scoped user roles, never hardcoded grants. */
export function createOperationsRoleScope(){return {
  name:roleScopeName,description:'运营身份的实际角色',protocol:'openid-connect',
  attributes:{'include.in.token.scope':'true','display.on.consent.screen':'false'},
  protocolMappers:[{name:'operations realm roles',protocol:'openid-connect',protocolMapper:'oidc-usermodel-realm-role-mapper',consentRequired:false,
    config:{'usermodel.realmRoleMapping.rolePrefix':'',multivalued:'true','claim.name':'realm_access.roles','jsonType.label':'String','id.token.claim':'true','access.token.claim':'true','userinfo.token.claim':'true','introspection.token.claim':'true'}}],
};}

/** No HTTP, credentials, user provisioning, or ordinary-realm mutation occurs. */
export function createOperationsRealmPlan({adminOrigin='https://admin.agigalaxy.org',authOrigin=adminOrigin,allowLoopbackHttp=false}={}){
  adminOrigin=exactOrigin(adminOrigin,'adminOrigin',allowLoopbackHttp);authOrigin=exactOrigin(authOrigin,'authOrigin',allowLoopbackHttp);
  const issuer=authOrigin+'/realms/'+operationsRealm,callback=adminOrigin+'/v1/operations/callback';
  const web={...clientBase(operationsClientIds.web,'银河运营后台'),publicClient:true,standardFlowEnabled:true,rootUrl:adminOrigin,baseUrl:adminOrigin+'/admin',
    redirectUris:[callback],webOrigins:[adminOrigin],defaultClientScopes:['profile','email',roleScopeName],
    attributes:{'pkce.code.challenge.method':'S256','post.logout.redirect.uris':adminOrigin+'/admin/login'}};
  const grafana={...clientBase(operationsClientIds.grafana,'银河运行监控'),clientAuthenticatorType:'client-secret',standardFlowEnabled:true,
    rootUrl:adminOrigin,baseUrl:adminOrigin+'/monitoring/',redirectUris:[adminOrigin+'/monitoring/login/generic_oauth'],webOrigins:[],
    defaultClientScopes:['profile','email',roleScopeName],attributes:{'pkce.code.challenge.method':'S256','post.logout.redirect.uris':adminOrigin+'/admin'}};
  const directory=createReadOnlyDirectoryPlan({realm:operationsRealm});
  return {
    version:1,
    // Create this small realm first. Keycloak supplies its native browser,
    // password-reset flows and built-in profile/email/roles client scopes.
    realm:{realm:operationsRealm,enabled:true,displayName:'银河运营管理',loginTheme:operationsLoginTheme,emailTheme:'galaxy-mail-editorial',
      registrationAllowed:false,registrationEmailAsUsername:false,duplicateEmailsAllowed:false,loginWithEmailAllowed:true,
      editUsernameAllowed:false,resetPasswordAllowed:false,verifyEmail:false,rememberMe:false,
      sslRequired:allowLoopbackHttp?'external':'all',bruteForceProtected:true,
      internationalizationEnabled:true,supportedLocales:['zh-CN','en'],defaultLocale:'zh-CN',
      browserFlow:'browser',resetCredentialsFlow:'reset credentials'},
    roles:[{name:operationsRoleNames.administrator,description:'银河业务与内容管理',composite:false},{name:operationsRoleNames.reader,description:'银河运营只读查阅',composite:false}],
    clientScope:createOperationsRoleScope(),
    clients:[web,grafana,directory.client],
    realmScopeMappings:[{client:web.clientId,roles:[...realmRoles]},{client:grafana.clientId,roles:[...realmRoles]}],
    directoryRolePlans:[directory.roles],
    oidc:{issuer,clientId:web.clientId,redirectUri:callback,scopes:['openid','profile','email'],roles:{...operationsRoleNames}},
    grafana:{secretEnvironment:'GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET',environment:{
      GF_SERVER_ROOT_URL:adminOrigin+'/monitoring/',GF_SERVER_SERVE_FROM_SUB_PATH:'true',
      GF_AUTH_DISABLE_LOGIN_FORM:'true',GF_AUTH_BASIC_ENABLED:'false',GF_AUTH_ANONYMOUS_ENABLED:'false',GF_USERS_ALLOW_SIGN_UP:'false',
      GF_AUTH_OAUTH_ALLOW_INSECURE_EMAIL_LOOKUP:'false',GF_AUTH_GENERIC_OAUTH_ENABLED:'true',GF_AUTH_GENERIC_OAUTH_NAME:'银河运营登录',
      GF_AUTH_GENERIC_OAUTH_CLIENT_ID:grafana.clientId,GF_AUTH_GENERIC_OAUTH_SCOPES:'openid profile email',
      GF_AUTH_GENERIC_OAUTH_AUTH_URL:issuer+'/protocol/openid-connect/auth',GF_AUTH_GENERIC_OAUTH_TOKEN_URL:issuer+'/protocol/openid-connect/token',GF_AUTH_GENERIC_OAUTH_API_URL:issuer+'/protocol/openid-connect/userinfo',
      GF_AUTH_GENERIC_OAUTH_LOGIN_ATTRIBUTE_PATH:'preferred_username',GF_AUTH_GENERIC_OAUTH_NAME_ATTRIBUTE_PATH:'preferred_username',GF_AUTH_GENERIC_OAUTH_EMAIL_ATTRIBUTE_PATH:'email',
      GF_AUTH_GENERIC_OAUTH_USE_PKCE:'true',GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP:'true',GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT:'true',GF_AUTH_GENERIC_OAUTH_ALLOW_ASSIGN_GRAFANA_ADMIN:'false',GF_AUTH_GENERIC_OAUTH_SKIP_ORG_ROLE_SYNC:'false',
      GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH:"contains(realm_access.roles || `[]`, 'galaxy-operations-administrator') && 'Admin' || contains(realm_access.roles || `[]`, 'galaxy-operations-reader') && 'Viewer'",
    }},
    ordinaryRealmChanges:[],
  };
}

/** A dedicated service account receives only this realm's user-read roles. */
export function createReadOnlyDirectoryPlan({realm=operationsRealm,clientId=realm===operationsRealm?operationsClientIds.directory:operationsClientIds.businessDirectory}={}){
  if(![operationsRealm,'galaxy'].includes(realm))throw Error('Directory realm must be explicitly supported');clientName(clientId);
  return {realm,client:{...clientBase(clientId,realm===operationsRealm?'管理身份只读目录':'银河业务账户只读目录'),clientAuthenticatorType:'client-secret',serviceAccountsEnabled:true,defaultClientScopes:['roles']},
    roles:{realm,clientId,roleClientId:'realm-management',names:['view-users','query-users'],serviceAccountAssignments:true,clientScopeAssignments:true}};
}

/** Separate opt-in plan; it is never included in the management realm plan. */
export function createBusinessDirectoryPlan({clientId=operationsClientIds.businessDirectory}={}){return createReadOnlyDirectoryPlan({realm:'galaxy',clientId});}

/** Keep the native profile model; names are not an operations-login task. */
export function planOperationsUserProfile(current){
  if(!current||!Array.isArray(current.attributes))throw Error('Provide the current management-realm user profile');
  const profile=structuredClone(current);
  for(const attribute of profile.attributes)if(['firstName','lastName'].includes(attribute.name))delete attribute.required;
  return profile;
}
