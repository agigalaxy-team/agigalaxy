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
export type HostWorkEvent = {type: string; id?: string; properties: Record<string, unknown>};
export type HostObservedMessage = {id:string;role:string;sessionID?:string;time?:{created:number;completed?:number};
  providerID?:string;modelID?:string;model?:{providerID:string;modelID:string};agent?:string;error?:{name:string};finish?:string};
type Command = { name: string; title: string; run: Action; desc?: string; category?: string; namespace?: string; slashName?: string; slashAliases?: string[] };
export interface StableHostApi {
  app?: {readonly version: string};
  event?: {on(type: string, handler: (event: HostWorkEvent) => void): Action};
  renderer?: { readonly width: number; readonly height: number };
  lifecycle?: { readonly signal: AbortSignal; onDispose(handler: Action): Action };
  // Public OpenCode TUI SDK. Appending keeps the host's unsent input and does
  // not submit it or select/start a model.
  client?: { tui: { appendPrompt(input: { text: string }): Promise<{ data?: boolean; error?: unknown }> };
    session?: {create(input: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<unknown>;
      prompt(input: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<unknown>;
      messages?(input: {sessionID: string}, options?: {signal?: AbortSignal}): Promise<unknown>;
      message?(input: {sessionID: string; messageID: string}): Promise<unknown>;
      abort?(input: {sessionID: string}): Promise<unknown>; update?(input: Record<string, unknown>): Promise<unknown>} };
  route?: { readonly current: { name: string; params?: { sessionID?: string } }; navigate?(name: string, params?: Record<string, unknown>): void };
  state?: {config?: {model?: string}; mcp?: () => readonly {name: string; status: string}[];
    session: { get?(sessionId:string):{id:string;title:string;directory?:string;workspaceID?:string;time?:{updated:number}}|undefined;messages(sessionId: string): readonly HostObservedMessage[];status?(sessionId:string):{type:string}|undefined };
    part(messageId: string): readonly { type: string; text?: string }[] };
  keymap: { registerLayer(layer: { mode?: string; commands: Command[]; bindings?: { key: string; cmd: string; desc: string }[] }): Action };
  ui: {
    toast?(input: {variant: string; title: string; message: string}): void;
    dialog: { setSize(size: 'medium' | 'xlarge'): void; clear(): void; replace(factory: Action, dispose?: Action): void };
    DialogAlert(input: { title: string; message: string; onConfirm: Action }): unknown;
    DialogPrompt(input: { title: string; placeholder: string; value?: string; onConfirm: (value: string) => unknown; onCancel: Action }): unknown;
    DialogSelect(input: { title: string; skipFilter: boolean; options: { title: string; description?: string; value: string; disabled: boolean; onSelect: Action }[] }): unknown;
  };
}
// Optional legacy-host controller interface consumed by the UI; the installed
// Native path obtains its operations from the Go bridge.
export type ConnectionController = {
  [name: string]: ((...args: any[]) => any) | undefined;
  prepare: (...args: any[]) => Promise<any>;
  execute: (...args: any[]) => Promise<any>;
  cancel: (...args: any[]) => any;
  disconnect: (...args: any[]) => any;
  status: (...args: any[]) => Promise<any>;
  checkRemote?: (...args: any[]) => Promise<any>;
  queryHistory?: (...args: any[]) => Promise<any>;
  querySearch?: (...args: any[]) => Promise<any>;
  recordSearchFeedback?: (...args: any[]) => Promise<any>;
  prepareCase?: (...args: any[]) => Promise<any>;
  executeCase?: (...args: any[]) => Promise<any>;
  preparePublication?: (...args: any[]) => Promise<any>;
  executePublication?: (...args: any[]) => Promise<any>;
  reconcilePublication?: (...args: any[]) => Promise<any>;
  createContextDraft?: (...args: any[]) => Promise<any>;
  getContextDraft?: (...args: any[]) => Promise<any>;
  previewContextFile?: (...args: any[]) => Promise<any>;
  saveContextDraft?: (...args: any[]) => Promise<any>;
  rebaseContextDraft?: (...args: any[]) => Promise<any>;
  listContextDrafts?: (...args: any[]) => Promise<any>;
  forgetContextDraft?: (...args: any[]) => Promise<any>;
  getLocalContextOperation?: (...args: any[]) => Promise<any>;
  listBindingReceipts?: (...args: any[]) => Promise<any>;
  createAssistanceDraft?: (...args: any[]) => Promise<any>;
  createAssistanceEventDraft?: (...args: any[]) => Promise<any>;
  rebaseAssistanceDraft?: (...args: any[]) => Promise<any>;
  getAssistanceDraft?: (...args: any[]) => Promise<any>;
  saveAssistanceDraft?: (...args: any[]) => Promise<any>;
  listAssistanceDrafts?: (...args: any[]) => Promise<any>;
  forgetAssistanceDraft?: (...args: any[]) => Promise<any>;
  querySearchFeedback?: (...args: any[]) => Promise<any>;
  editSearchFeedback?: (...args: any[]) => Promise<any>;
};
// Shape consumed by the optional host discovery UI; the normal installed
// Native host supplies its Go tool bridge and does not instantiate a JS core.
export type DiscoverySource = Pick<ConnectionController,
  'querySearchFeedback' | 'editSearchFeedback' | 'listBindingReceipts' |
  'createContextDraft' | 'getContextDraft' | 'previewContextFile' | 'saveContextDraft' | 'rebaseContextDraft' |
  'listContextDrafts' | 'forgetContextDraft' | 'getLocalContextOperation' |
  'createAssistanceDraft' | 'createAssistanceEventDraft' | 'rebaseAssistanceDraft' | 'getAssistanceDraft' |
  'saveAssistanceDraft' | 'listAssistanceDrafts' | 'forgetAssistanceDraft'> & {
    endpoint: string;
    scopes: readonly string[];
    status(): {state: string};
    read(signal: AbortSignal): Promise<{controller: ConnectionController; networkType: string; displayName: string; operator: string; checkedAt: number}>;
    close(): void;
  };
export type BindingReceiptView = { endpoint: string; bindingId: string; subjectId: string; installationId: string; scopes: string[];
  receivedAt: number; bindingExpiresAt: number; verification: string; lifetime: string; configurationMatches: boolean };
export type CaseSubmission = { consentId: string; payloadJson: string };
export type HistoryFilters = { query: string; limit: number; after?: string } & Partial<Record<'subjectId' | 'sourceKind' | 'environment' | 'createdFrom' | 'createdBefore' | 'outcome' | 'capabilityId' | 'verificationStrength', string>>;
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
