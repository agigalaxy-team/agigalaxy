const MODULES = [
  {
    id: 'galaxy-id',
    title: 'Galaxy ID',
    category: 'foundation',
    availability: 'available',
    defaultSelected: true,
    requires: [],
    createsLocalData: true,
    description: 'Creates a local Galaxy ID and device-held key material. It is not an account, verified identity, or public profile.',
  },
  {
    id: 'case-workspace',
    title: 'Coding Case workspace',
    category: 'local-workflow',
    availability: 'available',
    defaultSelected: true,
    requires: ['galaxy-id'],
    createsLocalData: true,
    description: 'Lets an AI host create local Coding Case Drafts and preserve attempted approaches.',
  },
  {
    id: 'consent-controls',
    title: 'Disclosure and consent controls',
    category: 'local-workflow',
    availability: 'available',
    defaultSelected: true,
    requires: ['case-workspace'],
    createsLocalData: true,
    description: 'Adds local disclosure previews, expiry-limited consent receipts, revocation, and Local Proof Drafts.',
  },
  {
    id: 'agent-mcp',
    title: 'Galaxy MCP workspace',
    category: 'agent-integration',
    availability: 'available',
    defaultSelected: true,
    requires: ['galaxy-id', 'case-workspace', 'consent-controls'],
    createsLocalData: false,
    description: 'Makes the selected local workflow available to an MCP-capable AI host over stdio.',
  },
  {
    id: 'agent-guidance',
    title: 'AI-guided setup',
    category: 'agent-integration',
    availability: 'available',
    defaultSelected: true,
    requires: ['agent-mcp'],
    createsLocalData: false,
    description: 'Provides a Skill that guides module selection and requires an explicit user confirmation before initialization.',
  },
  {
    id: 'openclaw-adapter',
    title: 'OpenClaw adapter',
    category: 'adapter',
    availability: 'planned',
    defaultSelected: false,
    requires: ['galaxy-id', 'agent-mcp'],
    createsLocalData: false,
    description: 'Reserved for a future local adapter. It is not implemented and cannot be initialized in Founding Beta.',
  },
  {
    id: 'github-ci-verification',
    title: 'GitHub / CI verification adapter',
    category: 'verification',
    availability: 'planned',
    defaultSelected: false,
    requires: ['galaxy-id', 'case-workspace'],
    createsLocalData: false,
    description: 'Reserved for future Result and Verification ingestion. It is not implemented and must not be presented as Evidence.',
  },
  {
    id: 'remote-sync',
    title: 'Remote sync',
    category: 'network',
    availability: 'planned',
    defaultSelected: false,
    requires: ['galaxy-id', 'consent-controls'],
    createsLocalData: false,
    description: 'Reserved for a future separately authorized remote service. Founding Beta has no remote sync.',
  },
];

const MODULE_BY_ID = new Map(MODULES.map((module) => [module.id, module]));

// An initialization path is a product-facing starting topology, not an
// identity type. Normal clients create person/organization IDs; Agent subjects
// use an isolated Worker identity path instead of retyping an existing ID.
// Worker and Hub remain visible as architecture paths but are intentionally
// non-selectable until their runtimes and safety contracts exist.
const INITIALIZATION_PATHS = [
  {
    id: 'personal-galaxy',
    title: 'Personal Galaxy',
    category: 'personal-edge',
    availability: 'available',
    defaultSelected: true,
    moduleIds: ['galaxy-id', 'case-workspace', 'consent-controls', 'agent-mcp', 'agent-guidance'],
    serviceCommands: ['open', 'status', 'setup', 'history', 'case', 'privacy'],
    privacyDefault: 'history-overview',
    requiresContinuousRuntime: false,
    description: 'Start a normal local client with a person or organization identity, ordinary work recording, own-Agent summaries and optional network access.',
    doesNotMean: 'A remote account, public profile, Worker, Hub membership, verified capability, or automatic sharing.',
  },
  {
    id: 'galaxy-worker',
    title: 'Galaxy Worker',
    category: 'agent-runtime',
    availability: 'planned',
    defaultSelected: false,
    moduleIds: [],
    futureCapabilityIds: ['worker-runtime', 'worker-pack', 'worker-policy', 'worker-health'],
    serviceCommands: ['open', 'status', 'setup', 'worker'],
    privacyDefault: 'policy-controlled',
    requiresContinuousRuntime: true,
    description: 'Run a specialized Agent continuously under a Worker policy, with versioned configuration and human-authorized context.',
    doesNotMean: 'Automatic task acceptance, access to raw Case context, automatic settlement, or proof of capability.',
  },
  {
    id: 'galaxy-hub',
    title: 'Galaxy Hub',
    category: 'organization-network',
    availability: 'planned',
    defaultSelected: false,
    moduleIds: [],
    futureCapabilityIds: ['hub-core', 'hub-policy', 'hub-evidence-network', 'hub-administration'],
    serviceCommands: ['open', 'status', 'setup', 'hub'],
    privacyDefault: 'hub-policy-controlled',
    requiresContinuousRuntime: true,
    description: 'Operate a community or organization Galaxy with its own local policy, evidence network, data boundary, and optional Workers.',
    doesNotMean: 'Ownership of member Galaxy IDs, permission to rewrite facts, or authority to fabricate external Evidence.',
  },
];

const INITIALIZATION_PATH_BY_ID = new Map(INITIALIZATION_PATHS.map((path) => [path.id, path]));

export const DEFAULT_MODULE_IDS = MODULES
  .filter((module) => module.defaultSelected)
  .map((module) => module.id);

export const MODULE_PROFILES = Object.freeze({
  minimal: ['galaxy-id'],
  'coding-case': ['galaxy-id', 'case-workspace', 'consent-controls'],
  'agent-workspace': DEFAULT_MODULE_IDS,
});

function cloneModule(module) {
  return { ...module, requires: [...module.requires] };
}

function cloneInitializationPath(path) {
  return {
    ...path,
    moduleIds: [...path.moduleIds],
    futureCapabilityIds: [...(path.futureCapabilityIds ?? [])],
    serviceCommands: [...path.serviceCommands],
  };
}

function uniqueIds(moduleIds) {
  if (moduleIds === undefined || moduleIds === null) {
    return [];
  }
  if (!Array.isArray(moduleIds)) {
    throw new Error('modules must be an array of module identifiers.');
  }
  return [...new Set(moduleIds.map((moduleId) => String(moduleId).trim()).filter(Boolean))];
}

export function listIntegrationModules() {
  return {
    modules: MODULES.map(cloneModule),
    initializationPaths: INITIALIZATION_PATHS.map(cloneInitializationPath),
    profiles: Object.fromEntries(
      Object.entries(MODULE_PROFILES).map(([name, moduleIds]) => [name, [...moduleIds]]),
    ),
  };
}

export function listGalaxyInitializationPaths() {
  return INITIALIZATION_PATHS.map(cloneInitializationPath);
}

export function resolveModuleSelection({ modules, profile } = {}) {
  if (profile && !MODULE_PROFILES[profile]) {
    throw new Error(`Unknown Galaxy Integration profile: ${profile}.`);
  }
  if (profile && modules && modules.length > 0) {
    throw new Error('Choose either a profile or an explicit module list, not both.');
  }

  const explicitModuleIds = profile
    ? [...MODULE_PROFILES[profile]]
    : uniqueIds(modules);
  const requestedModuleIds = explicitModuleIds.length > 0 ? explicitModuleIds : [...DEFAULT_MODULE_IDS];
  const resolvedIds = [];
  const impliedBy = new Map();

  function add(moduleId, requiredBy = null) {
    const definition = MODULE_BY_ID.get(moduleId);
    if (!definition) {
      throw new Error(`Unknown Galaxy Integration module: ${moduleId}.`);
    }
    if (definition.availability !== 'available') {
      throw new Error(`${definition.title} is ${definition.availability} and cannot be initialized in Founding Beta.`);
    }
    for (const dependencyId of definition.requires) {
      add(dependencyId, moduleId);
    }
    if (!resolvedIds.includes(moduleId)) {
      resolvedIds.push(moduleId);
    }
    if (requiredBy && !explicitModuleIds.includes(moduleId)) {
      const dependencies = impliedBy.get(moduleId) ?? [];
      impliedBy.set(moduleId, [...new Set([...dependencies, requiredBy])]);
    }
  }

  for (const moduleId of requestedModuleIds) {
    add(moduleId);
  }

  return {
    profile: profile ?? null,
    requestedModuleIds,
    modules: resolvedIds.map((moduleId) => ({
      ...cloneModule(MODULE_BY_ID.get(moduleId)),
      impliedBy: impliedBy.get(moduleId) ?? [],
    })),
    localOnly: true,
    remoteEffects: 'none',
    notes: [
      'Initialization writes only local configuration and, when Galaxy ID is selected, local key material.',
      'No selected module uploads Case content, publishes Proof, creates a remote account, or enables remote sync.',
    ],
  };
}

export {INITIALIZATION_PATH_BY_ID,cloneInitializationPath};
