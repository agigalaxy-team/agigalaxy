// The narrow stable Dialog/keymap surface used by Galaxy, not an alternate UI.
export type Action = () => unknown;
export type Routes = Record<string, Action>;
export type MenuOption = { number: string; title: string; description?: string; disabled?: boolean; reading?: boolean };
export type ModuleEntry = { id: string; title?: string };
export type Menu = { title: string; options: MenuOption[]; routes: Routes; onBack: Action; onEscape?: Action };
export type Prompt = { title: string; placeholder: string; value?: string; onConfirm: (value: string) => unknown; onCancel?: Action };
export type HostWorkResult = { title: string; content: string; sourceUrl?: string };
export type HostWorkContext = { query?: string; origin?: { host: string; workRef: string }; caseId?: string; taskId?: string;
  a2a?: { peerId: string; attemptId: string; attemptVersion: number; text: string } };
type Command = { name: string; title: string; run: Action; desc?: string; category?: string; namespace?: string; slashName?: string; slashAliases?: string[] };
export interface StableHostApi {
  lifecycle?: { readonly signal: AbortSignal; onDispose(handler: Action): Action };
  // Public OpenCode TUI SDK. Appending keeps the host's unsent input and does
  // not submit it or select/start a model.
  client?: { tui: { appendPrompt(input: { text: string }): Promise<{ data?: boolean; error?: unknown }> } };
  route?: { readonly current: { name: string; params?: { sessionID?: string } } };
  state?: { session: { messages(sessionId: string): readonly { id: string; role: string }[] };
    part(messageId: string): readonly { type: string; text?: string }[] };
  keymap: { registerLayer(layer: { mode?: string; commands: Command[]; bindings?: { key: string; cmd: string; desc: string }[] }): Action };
  ui: {
    dialog: { setSize(size: 'medium' | 'xlarge'): void; clear(): void; replace(factory: Action, dispose?: Action): void };
    DialogAlert(input: { title: string; message: string; onConfirm: Action }): unknown;
    DialogPrompt(input: { title: string; placeholder: string; value?: string; onConfirm: (value: string) => unknown; onCancel: Action }): unknown;
    DialogSelect(input: { title: string; skipFilter: boolean; options: { title: string; description?: string; value: string; disabled: boolean; onSelect: Action }[] }): unknown;
  };
}
export type ConnectionController = ReturnType<typeof import('../../../packages/galaxy-official/src/host-connection-controller.mjs').createHostConnectionController> & {
  createContextDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['createContextDraft'];
  getContextDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['getContextDraft'];
  previewContextFile?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['previewContextFile'];
  saveContextDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['saveContextDraft'];
  rebaseContextDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['rebaseContextDraft'];
  listContextDrafts?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['listContextDrafts'];
  forgetContextDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['forgetContextDraft'];
  getLocalContextOperation?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['getLocalContextOperation'];
  listBindingReceipts?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['listBindingReceipts'];
  createAssistanceDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['createAssistanceDraft'];
  createAssistanceEventDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['createAssistanceEventDraft'];
  rebaseAssistanceDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['rebaseAssistanceDraft'];
  getAssistanceDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['getAssistanceDraft'];
  saveAssistanceDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['saveAssistanceDraft'];
  listAssistanceDrafts?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['listAssistanceDrafts'];
  forgetAssistanceDraft?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['forgetAssistanceDraft'];
  querySearchFeedback?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['querySearchFeedback'];
  editSearchFeedback?: ReturnType<typeof import('../../../packages/galaxy-official/src/local-host-runtime.mjs').createLocalHostRuntime>['controller']['editSearchFeedback'];
};
export type DiscoverySource = ReturnType<typeof import('./configured-runtime.mjs').createConfiguredRuntime>;
export type BindingReceiptView = { endpoint: string; bindingId: string; subjectId: string; installationId: string; scopes: string[];
  receivedAt: number; bindingExpiresAt: number; verification: string; lifetime: string; configurationMatches: boolean };
export type CaseSubmission = { consentId: string; payloadJson: string };
export type HistoryFilters = { query: string; limit: number; after?: string } & Partial<Record<'subjectId' | 'sourceKind' | 'environment' | 'createdFrom' | 'createdBefore' | 'outcome' | 'capabilityId' | 'verificationStrength', string>>;
export type InitializationView = {
  header: { title: string };
  currentStage: { title: string; prompt: string; note?: string;
    welcome?: { title: string; purpose: string; vision: string };
    options: { title: string; description?: string; disabledReason?: string; selectable?: boolean }[] };
};
export type AdapterCore = Omit<typeof import('../../../packages/galaxy-core/src/integration-modules.mjs'), 'getGalaxyInitializationContract'> & {
  getGalaxyInitializationContract(input: { language: string; stage: number; hostCapabilities?: Record<string, boolean> }): InitializationView;
};
export type PublicationDraft = { localCaseId: string; title: string; status: string };
export type HistoryItem = {
  caseId: string; title: unknown; summary: unknown; state: unknown; matchReasons: unknown[];
  searchExplanation?: {sourceType: string;checkedAt: number;order: string;scope: string;
    textMatches: {term: string;fields: string[]}[];capabilityMatches: {capabilityId: string;assistanceId: string;authority: string}[];
    verification: {strength: string;proofIds: string[];meaning: string};limitations: string[]};
  results: { id?: string; outcome: unknown; summary: unknown; corrected?: boolean; failureReason?: unknown; limitations?: unknown[] }[];
  fieldPolicy?: {id: string;version: number;view: string};
  reportedProgress?: { latestResultId: string | null;
    timeline: {resultId: string;attemptId: string;outcome: string;sourceEventVersion: number;corrected: boolean}[];
    subsequentReports: {previousSuccessId: string;resultId: string;attemptRelation: string;regressionVerified: false}[] };
  corrections?: { summary: unknown }[];
  reviews?: { type: unknown; state: unknown; changes?: { state: unknown; summary: unknown }[] }[];
  moderationContext?: {coverage: string;items: {reportId: string;state: string;paused: boolean;
    revalidation?: {generation: number;state: string} | null;events: {kind: string;summary: string;verdict?: string}[]}[]};
  proofs?: { proofId: unknown; status: unknown; caseContext?: { status: unknown }; provenance?: {
    sourceKey: string; sourceControl: { repositoryOwner: { id: number; login: string; type: string } | null } | null } }[];
  participants?: { subjectId: string; role: string }[];
  attempts?: { id: string; configuration?: { environment: string; version: string; tools: string[] } }[];
  collaborationContext?: { capabilityIds: string[]; items: { assistanceId: string; capabilityId: string | null; requestedScope: string;
    participantLinks: { subjectId: string; role: string; eventId: string; authority: string }[] }[] };
  rebuild?: { rule: { id: string; version: number }; sourceVersion: number; contentHash: string;
    sources: { events: { id: string; kind: string; version: number }[]; proofIds: string[]; capsuleUseIds: string[] } };
  rebuildComparison?: { state: string; reasons: string[] };
};
