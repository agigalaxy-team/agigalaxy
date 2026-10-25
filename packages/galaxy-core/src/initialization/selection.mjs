import {normalizeUploadPrivacy,selectUploadPrivacy} from '../upload-privacy.mjs';
import {resolveModuleSelection,INITIALIZATION_PATH_BY_ID,cloneInitializationPath} from './catalog.mjs';

export function resolveGalaxyInitialization({ initializationPath, modules, profile, allowPlanned = false, subjectType, uploadPrivacy } = {}) {
  if (subjectType !== undefined && !['person', 'organization'].includes(subjectType)) throw Object.assign(new Error('local_identity_subject_type_invalid'), {code: 'local_identity_subject_type_invalid'});
  const localSelection = {subjectType: subjectType ?? 'person', uploadPrivacy: uploadPrivacy === undefined ? normalizeUploadPrivacy() : selectUploadPrivacy(undefined, uploadPrivacy)};
  if (!initializationPath && modules === undefined && profile === undefined) {
    return resolveGalaxyInitialization({ initializationPath: 'personal-galaxy', subjectType, uploadPrivacy });
  }
  if (!initializationPath) {
    return {
      ...resolveModuleSelection({ modules, profile }),
      initializationPath: null,
      operation: 'module-change',
      ...localSelection,
    };
  }
  if (profile || (Array.isArray(modules) && modules.length > 0)) {
    throw new Error('Choose either an initialization path or a legacy profile/module list, not both.');
  }

  const path = INITIALIZATION_PATH_BY_ID.get(String(initializationPath).trim());
  if (!path) throw new Error(`Unknown Galaxy initialization path: ${initializationPath}.`);
  if (path.availability !== 'available' && !allowPlanned) {
    throw new Error(`${path.title} is planned and cannot be initialized in Founding Beta.`);
  }

  if (path.availability !== 'available') {
    return {
      profile: null,
      requestedModuleIds: [],
      modules: [],
      localOnly: true,
      remoteEffects: 'none',
      notes: [
        'This is a read-only architecture preview. No runtime, local configuration, or Galaxy ID will be created.',
        `${path.title} is planned and cannot be initialized in Founding Beta.`,
      ],
      initializationPath: cloneInitializationPath(path),
      operation: 'future-path-preview',
      canInitialize: false,
    };
  }

  return {
    ...resolveModuleSelection({ modules: path.moduleIds }),
    capabilityProfile: 'l3-foundation',
    initializationPath: cloneInitializationPath(path),
    operation: 'first-run-or-path-change',
    canInitialize: true,
    ...localSelection,
  };
}
