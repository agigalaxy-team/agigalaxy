import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { spawn } from 'node:child_process';
import * as z from 'zod/v4';

import {
  assertGalaxyModulesEnabled,
  createCaseDraft,
  createDisclosurePlan,
  createLocalProofDraft,
  getGalaxyCommandSurface,
  getGalaxyIntegrationStatus,
  getLocalSnapshot,
  initializeGalaxyIntegration,
  issueConsentGrant,
  listGalaxyIntegrationModules,
  listLocalHistory,
  previewGalaxyIntegration,
  revokeConsentGrant,
} from '../../galaxy-core/src/local-store.mjs';
import { isGalaxyGuid, parseGalaxyGuid } from '../../galaxy-core/src/galaxy-guid.mjs';
import { registerConnectionTools } from './connection-tools.mjs';
import {resolveDataDir,localPaths,readJson} from '../../galaxy-core/src/storage/files.mjs';
import {registerNativeLocalWorkTools,nativeUploadPrivacyInputSchema} from './native-v2/work/local-tools.mjs';
import {createNativeChoice,nativeResult} from './native-v2/interaction/choice.mjs';
import {createNativeStore} from './native-v2/store.mjs';
import {nativeDiagnostics} from './native-v2/diagnostics.mjs';
import {installRuntimeFailureHandlers} from '../../galaxy-official/src/operations/runtime-log.mjs';

const dataDir = process.env.GALAXY_DATA_DIR;
const INITIALIZATION_CONFIRMATION = 'I_CONFIRM_LOCAL_GALAXY_INITIALIZATION';
const OFFICIAL_WEBSITE_CONFIRMATION = 'I_CONFIRM_OPEN_GALAXY_OFFICIAL_WEBSITE';

function getConfiguredOfficialWebsite() {
  const value = process.env.GALAXY_OFFICIAL_SITE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getOfficialWebsiteAvailability() {
  const url = getConfiguredOfficialWebsite();
  return {
    platform: process.platform,
    supported: process.platform === 'win32',
    configured: url !== null,
    url,
    reason: url
      ? null
      : 'GALAXY_OFFICIAL_SITE_URL is not configured as a valid HTTPS URL. A local preview is never presented as the official website.',
  };
}

function openConfiguredOfficialWebsite() {
  const availability = getOfficialWebsiteAvailability();
  if (!availability.supported) {
    return { ...availability, state: 'unsupported-platform', opened: false };
  }
  if (!availability.configured) {
    return { ...availability, state: 'website-not-configured', opened: false };
  }
  const browser = spawn('explorer.exe', [availability.url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.unref();
  return { ...availability, state: 'opened', opened: true };
}

function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function createServer() {
  const directory=resolveDataDir(dataDir),localStore=createNativeStore(directory);
  let localSubject='';
  const localChoice=createNativeChoice({identity:()=>localSubject,website:getConfiguredOfficialWebsite()??'local',store:localStore});
  const server = new McpServer(
    {
      name: 'galaxy-integration-mcp',
      version: '0.4.0',
    },
    {
      requestState:{verify:localChoice.verify},
      instructions: [
        'Galaxy Integration Pack is local-only in Founding Beta.',
        'Treat /Galaxy as a state-aware entry: initialize only on first use or after the user explicitly requests a configuration change.',
        'Start by listing initialization paths and previewing the requested plan.',
        'Do not call galaxy_integration_initialize until the user has reviewed the plan and explicitly confirmed the local module selection.',
        'No current module uploads Case content, publishes Proof, creates a remote account, or claims independent verification.',
        'Open a browser only when the user explicitly requests the configured official website and confirms the dedicated website-opening action.',
      ].join(' '),
    },
  );

  server.registerTool(
    'galaxy_integration_list_modules',
    {
      title: 'List Galaxy initialization paths and capabilities',
      description: 'Lists product-facing initialization paths, current local capabilities, dependencies, legacy profiles, and planned paths that cannot yet be initialized.',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(listGalaxyIntegrationModules()),
  );

  server.registerTool(
    'galaxy_integration_preview_initialization',
    {
      title: 'Preview Galaxy initialization or configuration change',
      description: 'Resolves a product-facing initialization path or legacy module plan and shows exactly what a local write would enable. This is read-only and sends no data.',
      inputSchema: z.object({
        initializationPath: z.enum(['personal-galaxy', 'galaxy-worker', 'galaxy-hub']).optional(),
        profile: z.enum(['minimal', 'coding-case', 'agent-workspace']).optional(),
        modules: z.array(z.string().trim().min(2).max(80)).max(8).optional(),
        subjectType: z.enum(['person','organization']).optional(),
        uploadPrivacy: nativeUploadPrivacyInputSchema.omit({galaxyId:true}).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => textResult(previewGalaxyIntegration(input)),
  );

  server.registerTool(
    'galaxy_integration_initialize',
    {
      title: 'Confirm Galaxy initialization or configuration change',
      description: 'Writes the confirmed local initialization path or configuration change and creates a GUID-32 Galaxy ID when required. Call only after the user reviewed the preview and explicitly confirmed it.',
      inputSchema: z.object({
        initializationPath: z.enum(['personal-galaxy', 'galaxy-worker', 'galaxy-hub']).optional(),
        profile: z.enum(['minimal', 'coding-case', 'agent-workspace']).optional(),
        modules: z.array(z.string().trim().min(2).max(80)).max(8).optional(),
        subjectType: z.enum(['person','organization']).optional(),
        uploadPrivacy: nativeUploadPrivacyInputSchema.omit({galaxyId:true}).optional(),
        confirmation: z.literal(INITIALIZATION_CONFIRMATION),
      }),
    },
    async ({ initializationPath, profile, modules, subjectType, uploadPrivacy }) => textResult(await initializeGalaxyIntegration(dataDir, {
      initializationPath,
      profile,
      modules,
      subjectType,
      uploadPrivacy,
      source: 'mcp',
    })),
  );

  server.registerTool(
    'galaxy_integration_status',
    {
      title: 'Read Galaxy Integration Pack status',
      description: 'Reads local module status without creating a Galaxy ID or changing local state.',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(await getGalaxyIntegrationStatus(dataDir)),
  );

  server.registerTool(
    'galaxy_command',
    {
      title: 'Route /Galaxy to initialization or an active service',
      description: 'A read-only command surface for Agent adapters. It returns first-run initialization guidance only when Galaxy is not initialized; otherwise it routes normal /Galaxy service requests without rerunning setup.',
      inputSchema: z.object({
        command: z.enum(['open', 'help', 'language', 'status', 'connect', 'setup', 'history', 'work', 'case', 'privacy', 'worker', 'hub', 'website']).default('open'),
        language: z.enum(['zh-CN', 'en-US']).optional(),
        stage: z.number().int().min(1).max(5).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ command, language, stage }) => textResult(await getGalaxyCommandSurface(dataDir, command, { language, stage })),
  );

  server.registerTool(
    'galaxy_open_official_website',
    {
      title: 'Open configured Galaxy official website on Windows',
      description: 'On Windows only, opens the HTTPS URL configured by GALAXY_OFFICIAL_SITE_URL in the default browser. It never starts a local preview, guesses a domain, or opens a URL without explicit user confirmation.',
      inputSchema: z.object({
        confirmation: z.literal(OFFICIAL_WEBSITE_CONFIRMATION),
      }),
    },
    async () => textResult(openConfiguredOfficialWebsite()),
  );

  server.registerTool(
    'galaxy_identity_status',
    {
      title: 'Read local Galaxy ID status',
      description: 'Returns the local Galaxy ID and draft counts after initialization. A Galaxy ID is not a registered account, verified identity, or public profile.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const status = await assertGalaxyModulesEnabled(dataDir, ['galaxy-id']);
      const history = await listLocalHistory(dataDir, 1);
      return textResult({
        dataDir: status.dataDir,
        galaxyId: status.galaxyId,
        modules: status.integration.modules,
        counts: {
          cases: history.cases.length,
          disclosurePlans: history.disclosurePlans.length,
          consentGrants: history.consentGrants.length,
          localProofDrafts: history.localProofDrafts.length,
        },
      });
    },
  );

  server.registerTool(
    'galaxy_identity_describe_guid',
    {
      title: 'Describe the local Galaxy ID format',
      description: 'Describes the local Galaxy ID format without treating identifier fields as identity, capability, Hub membership, or trust claims.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const status = await assertGalaxyModulesEnabled(dataDir, ['galaxy-id']);
      const identity = status.galaxyId;
      return textResult({
        galaxyId: identity,
        description: identity && isGalaxyGuid(identity.id)
          ? {
              ...parseGalaxyGuid(identity.id),
              fieldLimits: [
                'The origin is only an immutable issuance context, not a trust or Hub claim.',
                'The timestamp is creation metadata, not activity or verification time.',
                'The Genesis Commitment is opaque and must not be decoded as personal data or a capability claim.',
              ],
            }
          : {
              format: 'legacy',
              note: 'This existing local Galaxy ID predates GUID-32 v1 and is preserved without silent rewriting.',
            },
      });
    },
  );

  server.registerTool(
    'galaxy_case_create_escalation_draft',
    {
      title: 'Create a local Coding Case Draft',
      description: 'Records a minimal local Coding Case Draft. It does not contact a Resolver, Hub, or public network.',
      inputSchema: z.object({
        title: z.string().trim().min(3).max(120),
        failureSummary: z.string().trim().min(8).max(1200),
        attemptedApproaches: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
      }),
    },
    async (input) => {
      await assertGalaxyModulesEnabled(dataDir, ['case-workspace']);
      return textResult(await createCaseDraft(dataDir, input));
    },
  );

  server.registerTool(
    'galaxy_case_preview_disclosure',
    {
      title: 'Preview a Case Disclosure Plan',
      description: 'Creates a local disclosure preview. Secrets, environment variables, tokens, credentials, and unselected source are always excluded.',
      inputSchema: z.object({
        caseId: z.string().min(8),
        recipient: z.string().trim().min(2).max(100).optional(),
        purpose: z.string().trim().min(3).max(160).optional(),
        include: z.array(z.enum(['failure_summary', 'attempt_metadata', 'verification_note'])).min(1).max(3).optional(),
        expiresInHours: z.number().int().min(1).max(720).optional(),
      }),
    },
    async (input) => {
      await assertGalaxyModulesEnabled(dataDir, ['consent-controls']);
      return textResult(await createDisclosurePlan(dataDir, input));
    },
  );

  server.registerTool(
    'galaxy_case_confirm_local_proof_draft',
    {
      title: 'Confirm a local Consent Grant and create a Local Proof Draft',
      description: 'Requires a human-reviewed Disclosure Plan. It creates a local-only Consent receipt and Local Proof Draft; it does not publish or transfer data.',
      inputSchema: z.object({
        caseId: z.string().min(8),
        disclosurePlanId: z.string().min(8),
        verificationNote: z.string().trim().min(8).max(800),
      }),
    },
    async ({ caseId, disclosurePlanId, verificationNote }) => {
      await assertGalaxyModulesEnabled(dataDir, ['consent-controls']);
      const consentGrant = await issueConsentGrant(dataDir, disclosurePlanId);
      const localProofDraft = await createLocalProofDraft(dataDir, {
        caseId,
        consentGrantId: consentGrant.id,
        verificationNote,
      });
      return textResult({ consentGrant, localProofDraft });
    },
  );

  server.registerTool(
    'galaxy_consent_revoke',
    {
      title: 'Revoke a local Consent Grant',
      description: 'Revokes a local consent receipt and blocks future local shareable-proof drafting under that grant.',
      inputSchema: z.object({ consentGrantId: z.string().min(8) }),
    },
    async ({ consentGrantId }) => {
      await assertGalaxyModulesEnabled(dataDir, ['consent-controls']);
      return textResult(await revokeConsentGrant(dataDir, consentGrantId));
    },
  );

  server.registerTool(
    'galaxy_history_list_local_drafts',
    {
      title: 'List local Galaxy history',
      description: 'Lists recent local Case Drafts, disclosure previews, consent receipts, and Local Proof Drafts.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      await assertGalaxyModulesEnabled(dataDir, ['case-workspace']);
      return textResult(await listLocalHistory(dataDir, limit));
    },
  );

  const registerLocal=(name,inputSchema,description,run,{write=false,needsChoice=false}={})=>server.registerTool(name,{inputSchema,description,annotations:{readOnlyHint:!write}},async(input,context)=>{
    try {
      localSubject=(await getLocalSnapshot(directory)).identity?.id??'';
      if(needsChoice) {
        const reviewedOwner=localSubject;
        return await localChoice.run(server,name,input,context,async()=>{
          if((await getLocalSnapshot(directory)).identity?.id!==reviewedOwner)throw new Error('local_identity_changed');
          return run(input);
        });
      }
      return nativeResult(await run(input));
    } catch(error) {return {isError:true,...nativeResult({error:/^[a-z0-9_]{1,100}$/.test(error.code??error.message)?error.code??error.message:'local_operation_failed'})};}
  });
  const localWork=registerNativeLocalWorkTools(registerLocal,{store:localStore,localIdentityWithin:async directory=>{
    const paths=localPaths(directory);return await readJson(paths.identity,null)??await readJson(paths.legacyIdentity,null);
  }});
  localWork.startMaintenance();
  const close=server.close.bind(server);
  server.close=async()=>{await localWork.close();await Promise.resolve(localChoice.close());await close();};
  const onclose=server.server.onclose;
  server.server.onclose=()=>{void localWork.close(); localChoice.close();onclose?.();};
  registerConnectionTools(server, dataDir);
  return server;
}

const diagnostics=nativeDiagnostics();
let handle;
const uninstall=installRuntimeFailureHandlers({
  logger:input=>diagnostics.emit({event:'native_runtime',stage:'shutdown',outcome:'failed',error:input.error}),
  onFatal:async()=>{try{await handle?.close();}finally{uninstall();}},
});
try{
  handle=serveStdio(createServer,{
    onerror:error=>diagnostics.emit({event:'native_transport',stage:'transport',outcome:'failed',error}),
  });
  diagnostics.emit({event:'native_runtime',stage:'runtime',outcome:'succeeded'});
}catch(error){
  diagnostics.emit({event:'native_runtime',stage:'runtime',outcome:'failed',error});
  process.exitCode=1;uninstall();
}
