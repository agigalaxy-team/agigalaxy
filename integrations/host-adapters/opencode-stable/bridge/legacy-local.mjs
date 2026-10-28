// The installed JavaScript backend loads its existing storage only when a
// legacy operation is actually called. Go supplies hostPersistence instead.
let implementation;
const load=()=>implementation??=import('./legacy-local-implementation.mjs');
const method=(namespace,name)=>(...args)=>load().then(module=>module[namespace][name](...args));
export const store=Object.freeze({getLocalSnapshot:method('store','getLocalSnapshot'),getGalaxyIntegrationStatus:method('store','getGalaxyIntegrationStatus'),resetGalaxyIntegration:method('store','resetGalaxyIntegration')});
export const connection=Object.freeze({getGalaxyConnectionStatus:method('connection','getGalaxyConnectionStatus')});
const direct=name=>(...args)=>load().then(module=>module[name](...args));
export const legacyHostConfiguration=direct('legacyHostConfiguration');
export const prepareOpenCodeLocalWork=direct('prepareOpenCodeLocalWork'),isOpenCodePreparationDeferred=direct('isOpenCodePreparationDeferred'),deferOpenCodePreparation=direct('deferOpenCodePreparation');
function client(factory,options,names){
 let value;
 const get=()=>value??=load().then(module=>module[factory](options));
 return Object.freeze(Object.fromEntries(names.map(name=>[name,(...args)=>get().then(target=>target[name](...args))])));
}
export const createLegacyHistory=options=>client('createLegacyHistory',options,['identity','beginCapture','observeEnvironment','observe','list','get','pending','setSummaryState','submitSummary']);
export const createLegacyArchive=options=>client('createLegacyArchive',options,['settings','captureMessage','configure']);
export const createLocalDeletionRecords=options=>client('createLocalDeletionRecords',options,['rememberPreview','observe','list']);
