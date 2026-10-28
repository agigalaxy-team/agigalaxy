import type {
  Action,
  CaseSubmission,
  ConnectionController,
  DiscoverySource,
  HostWorkContext,
  HostWorkResult,
  Menu,
  Prompt,
} from '../adapter-types.ts';
import type { StableHostApi } from '../adapter-types.ts';
import type { createOpenCodeWorkRecorder } from '../work-recorder.mjs';
import type { createPurposeMenu } from '../purpose-menu.mjs';
import type { createReadTaskController } from '../../../shared/read-task.mjs';

// Each page factory belongs to one attached adapter. Accessors retain the live
// language, navigation generation and connection instead of capturing a stale
// value when a different page changes the session.
export interface GalaxyMenuSession {
  readonly api: StableHostApi;
  readonly closed: boolean;
  readonly store: Pick<typeof import('../../../../packages/galaxy-core/src/local-store.mjs'), 'getLocalSnapshot' | 'getGalaxyIntegrationStatus' | 'resetGalaxyIntegration'>;
  readonly connection: Pick<typeof import('../../../../packages/galaxy-core/src/connection-profile.mjs'), 'getGalaxyConnectionStatus'>;
  readonly createDeletionRecords: ReturnType<typeof import('../bridge/host-local-client.mjs').createHostLocalClient>['deletionRecords'];
  readonly dataDirectory: string | undefined;
  connectionController: ConnectionController | null;
  readonly discovery: DiscoverySource | null;
  readonly workRecorder: ReturnType<typeof createOpenCodeWorkRecorder> | null;
  readonly localPageReads: ReturnType<typeof createReadTaskController>;
  readonly nativeTools: {
    call(
      this: void,
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown>;
    openLink?(url: string): Promise<unknown>;
  } | null;
  readonly readCaseSubmission: (() => Promise<CaseSubmission | null>) | null;
  readonly readWorkContext: (() => Promise<HostWorkContext | null>) | null;
  readonly pageGeneration: number;
  disposeMenuKeys: Action | null;
  visiblePage: number | null;
  activeLanguage: string;
  connectionGeneration: number;
  discoveryAbort: AbortController | null;
  pendingConnection: object | null;
  purposeMenu: ReturnType<typeof createPurposeMenu> | null;
  requiredController(this: void): ConnectionController;
  controllerMethod<K extends keyof ConnectionController>(
    this: void,
    key: K,
  ): NonNullable<ConnectionController[K]>;
  clearConnectionController(this: void): void;
  clearMenuKeys(this: void): void;
  nextPage(this: void): number;
  closeGalaxy(this: void): void;
  currentWorkContext(this: void): Promise<HostWorkContext | null>;
  returnToWork(this: void, result?: HostWorkResult): Promise<void>;
  showSelect(this: void, input: Menu): void;
  showPrompt(this: void, input: Prompt): void;
  showInfo(this: void, title: string, message: string, onConfirm: Action): void;
  showReading(
    this: void,
    title: string,
    message: string,
    onConfirm: Action,
  ): void;
  showConsole(
    this: void,
    initialized?: Awaited<
      ReturnType<GalaxyMenuSession['store']['getGalaxyIntegrationStatus']>
    >,
  ): Promise<void>;
  showQuickInitialize(
    this: void,
    onReturn: Action,
    firstStart?: boolean,
  ): Promise<unknown>;
  showConnection(this: void, onBack: Action): Promise<unknown>;
  showManagedConnection(this: void, onBack: Action): Promise<unknown>;
  showDiscovery(this: void, onBack: Action): void;
  showLocalSearchFeedback(this: void, onBack: Action): void;
  showBindingReceipts(
    this: void,
    onBack: Action,
    offset?: number,
  ): Promise<void>;
  checkRemoteBinding(this: void, onBack: Action): Promise<void>;
  previewConnection(this: void, onBack: Action): Promise<void>;
  showStatus(this: void, onBack: Action): Promise<void>;
  promptHistory(this: void, onBack: Action): Promise<unknown>;
  previewCaseSubmission(
    this: void,
    onBack: Action,
    localDraftId?: string | null,
    visibility?: string,
  ): Promise<unknown>;
  showPublicationDrafts(this: void, onBack: Action): Promise<unknown>;
}
