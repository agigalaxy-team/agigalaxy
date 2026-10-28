// Go candidates have no JavaScript storage fallback. These names satisfy the
// shared host UI's legacy-only branches; Go always supplies hostPersistence.
const unavailable=()=>{throw Object.assign(Error('native_go_candidate_legacy_backend_unavailable'),{code:'native_go_candidate_legacy_backend_unavailable'});};
export const store=Object.freeze({getLocalSnapshot:unavailable,getGalaxyIntegrationStatus:unavailable,resetGalaxyIntegration:unavailable});
export const connection=Object.freeze({getGalaxyConnectionStatus:unavailable});
export const createLegacyHistory=unavailable,createLegacyArchive=unavailable,legacyHostConfiguration=unavailable;
export const prepareOpenCodeLocalWork=unavailable,isOpenCodePreparationDeferred=unavailable,deferOpenCodePreparation=unavailable;

export const createLocalDeletionRecords=unavailable;
