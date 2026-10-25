import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertGalaxyModulesEnabled,
  getGalaxyCommandSurface,
  getGalaxyIntegrationStatus,
  initializeGalaxyIntegration,
  previewGalaxyIntegration,
} from '../src/local-store.mjs';
import {
  getGalaxyInitializationContract,
  getGalaxyInitializationPresentation,
  renderGalaxyNumberedList,
  resolveGalaxyInteractionMode,
} from '../src/integration-modules.mjs';

test('initialization presentation preserves the host-native Galaxy first-screen contract', () => {
  const presentation = getGalaxyInitializationPresentation();

  assert.equal(presentation.hostOwnership, 'native-host-adapter');
  assert.equal(presentation.standaloneSurface, false);
  assert.equal(presentation.characterLogo, false);
  assert.equal(presentation.header.title, 'Galaxy / 初始化');
  assert.equal(presentation.header.placement, 'top-center');
  assert.equal(presentation.footer.placement, 'bottom-center');
  assert.equal(presentation.footer.navigationPlacement, 'footer-sides');
  assert.equal(presentation.footer.progressText, '阶段 1 / 5　Enter 确认　Esc 返回');
  assert.equal(presentation.firstScreen.title, '欢迎加入银河');
  assert.match(presentation.firstScreen.functionalVision, /记录难点/);
  assert.deepEqual(
    presentation.firstScreen.initializationPaths.map((path) => path.id),
    ['personal-galaxy', 'galaxy-worker', 'galaxy-hub'],
  );

  const english = getGalaxyInitializationPresentation({ language: 'en-US' });
  assert.equal(english.header.title, 'Galaxy / Setup');
  assert.equal(english.firstScreen.title, 'Welcome to Galaxy');
});

test('portable initialization contract selects a host renderer without changing product semantics', () => {
  assert.equal(resolveGalaxyInteractionMode().id, 'numbered-list');
  assert.equal(resolveGalaxyInteractionMode({ nativeSingleSelect: true, nativeConfirm: true }).id, 'native-select');
  assert.equal(resolveGalaxyInteractionMode({ richDialog: true, nativeSingleSelect: true, nativeConfirm: true }).id, 'rich-dialog');

  const languageSelection = getGalaxyInitializationContract();
  assert.equal(languageSelection.phase, 'language-selection');
  assert.deepEqual(languageSelection.languageSelection.options.map((option) => option.id), ['zh-CN', 'en-US']);
  assert.deepEqual(languageSelection.languageSelection.interactionGuide.routes[0], {
    input: ['1', '中文', '简体中文'],
    action: 'set-language',
    language: 'zh-CN',
    nextStage: 1,
  });
  assert.match(renderGalaxyNumberedList(languageSelection), /选择语言 \/ Choose language/);

  const fallback = getGalaxyInitializationContract({ language: 'zh-CN' });
  assert.equal(fallback.standaloneSurface, false);
  assert.equal(fallback.interaction.id, 'numbered-list');
  assert.equal(fallback.currentStage.id, 'shape');
  assert.equal(fallback.currentStage.welcome.title, '欢迎加入银河');
  assert.match(fallback.currentStage.welcome.purpose, /记录难点/);
  assert.deepEqual(fallback.currentStage.interactionGuide.routes.select, ['1', '个人银河']);
  assert.equal(fallback.currentStage.interactionGuide.routes.nextStage, 2);
  assert.equal(fallback.stages.length, 5);
  assert.equal(fallback.stages[1].selection, 'summary');
  assert.equal(fallback.stages[1].options.find((option) => option.id === 'agent-mcp').required, true);
  assert.equal(fallback.stages[2].options.find((option) => option.id === 'local-only').availability, 'available');
  assert.deepEqual(fallback.stages[2].options.map(option => option.id), ['local-only', 'history-overview', 'work-content', 'conversation-archive']);
  assert.equal(fallback.stages[2].options.find((option) => option.id === 'history-overview').selected, true);
  assert.equal(fallback.stages[2].uploadPrivacy.includeFullConversations, false);
  assert.equal(fallback.stages[3].options.find((option) => option.id === 'bind-existing-id').selectable, false);
  assert.match(renderGalaxyNumberedList(fallback), /\[1\] ● 个人银河/);

  const rich = getGalaxyInitializationContract({
    stage: 3,
    language: 'en-US',
    hostCapabilities: { richDialog: true, nativeSingleSelect: true, nativeConfirm: true },
  });
  assert.equal(rich.interaction.id, 'rich-dialog');
  assert.equal(rich.currentStage.id, 'upload-privacy');
  assert.equal(rich.language, 'en-US');
  assert.equal(rich.currentStage.title, 'Allowed upload data types');
  assert.equal(rich.richLayoutHint.characterLogo, false);

  const confirmation = getGalaxyInitializationContract({ stage: 5, language: 'zh-CN' });
  assert.deepEqual(confirmation.currentStage.interactionGuide.routes.confirm, ['确认初始化']);
  assert.match(renderGalaxyNumberedList(confirmation), /收到这句明确确认前/);
  assert.match(renderGalaxyNumberedList(confirmation), /请输入精确的“确认初始化”/);
  assert.doesNotMatch(renderGalaxyNumberedList(confirmation), /\[1\] 确认初始化/);
});

test('Galaxy Integration Pack previews, resolves dependencies, and initializes only selected local modules', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'galaxy-integration-test-'));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));

  const before = await getGalaxyIntegrationStatus(dataDir);
  assert.equal(before.initialized, false);
  assert.equal(before.galaxyId, null);

  const firstCommand = await getGalaxyCommandSurface(dataDir, 'open');
  assert.equal(firstCommand.state, 'needs-initialization');
  assert.equal(firstCommand.route, 'galaxy-initialization');
  assert.deepEqual(
    firstCommand.initializationPaths.map((path) => path.id),
    ['personal-galaxy', 'galaxy-worker', 'galaxy-hub'],
  );
  assert.equal(firstCommand.initializationPresentation.header.title, 'Galaxy / 初始化');
  assert.equal(firstCommand.initializationPresentation.footer.progressText, '阶段 1 / 5　Enter 确认　Esc 返回');
  assert.equal(firstCommand.initializationContract.phase, 'language-selection');

  const uninitializedStatus = await getGalaxyCommandSurface(dataDir, 'status');
  assert.equal(uninitializedStatus.state, 'not-initialized');
  assert.equal(uninitializedStatus.route, 'galaxy-status');

  const commandHelp = await getGalaxyCommandSurface(dataDir, 'help');
  assert.equal(commandHelp.route, 'galaxy-command-help');
  assert.equal(commandHelp.commands.find((entry) => entry.action === 'website').command, '/Galaxy website');

  const languageCommand = await getGalaxyCommandSurface(dataDir, 'language');
  assert.equal(languageCommand.initializationContract.phase, 'language-selection');

  const websiteCommand = await getGalaxyCommandSurface(dataDir, 'website');
  assert.equal(websiteCommand.route, 'galaxy-website-entry');
  assert.deepEqual(websiteCommand.nextTools, ['galaxy_open_official_website']);

  const chineseCommand = await getGalaxyCommandSurface(dataDir, 'open', { language: 'zh-CN', stage: 1 });
  assert.equal(chineseCommand.initializationContract.interaction.id, 'numbered-list');
  assert.equal(chineseCommand.initializationContract.currentStage.id, 'shape');

  const preview = previewGalaxyIntegration({ initializationPath: 'personal-galaxy' });
  assert.equal(preview.initializationPath.id, 'personal-galaxy');
  assert.deepEqual(
    preview.modules.map((module) => module.id),
    ['galaxy-id', 'case-workspace', 'consent-controls', 'agent-mcp', 'agent-guidance'],
  );
  assert.equal(preview.remoteEffects, 'none');

  const initialized = await initializeGalaxyIntegration(dataDir, {
    initializationPath: 'personal-galaxy',
    source: 'test',
  });
  assert.match(initialized.galaxyId.id, /^GUID[0-9A-HJKMNPQRSTVWXYZ]{28}$/);
  assert.deepEqual(
    initialized.integration.modules.map((module) => module.id),
    ['galaxy-id', 'case-workspace', 'consent-controls', 'agent-mcp', 'agent-guidance'],
  );
  assert.equal(initialized.localOnly, true);
  assert.equal(initialized.integration.initializationPath.id, 'personal-galaxy');
  assert.equal(initialized.change.kind, 'first-initialization');

  const activeCaseCommand = await getGalaxyCommandSurface(dataDir, 'case');
  assert.equal(activeCaseCommand.state, 'ready');
  assert.equal(activeCaseCommand.route, 'galaxy-case-workspace');

  const consoleCommand = await getGalaxyCommandSurface(dataDir, 'open', { language: 'zh-CN' });
  assert.equal(consoleCommand.route, 'galaxy-service-home');
  assert.equal(consoleCommand.console.type, 'galaxy-console');
  assert.equal(consoleCommand.console.welcome.title, '欢迎回到银河');
  assert.equal(consoleCommand.console.localStatus.localOnly, true);
  assert.deepEqual(consoleCommand.console.sections[0].actions.map((action) => action.command), ['status', 'connect', 'history', 'case', 'privacy', 'worker']);
  assert.deepEqual(consoleCommand.console.interactionGuide.routes.map((route) => route.command), [
    'status', 'history', 'case', 'privacy', 'setup', 'language', 'website', 'help', 'connect',
  ]);

  const workerCommand = await getGalaxyCommandSurface(dataDir, 'worker');
  assert.equal(workerCommand.state, 'identity-setup-available');
  assert.equal(workerCommand.route, 'galaxy-worker-identity');
  assert.equal(workerCommand.runtimeStarted, false);
  assert.deepEqual(workerCommand.nextTools, ['galaxy_local_worker_identity_create']);
  assert.equal((await getGalaxyIntegrationStatus(dataDir)).galaxyId.id, initialized.galaxyId.id);

  const after = await assertGalaxyModulesEnabled(dataDir, ['case-workspace', 'consent-controls']);
  assert.equal(after.initialized, true);
  assert.equal(after.integration.remoteEffects, 'none');

  const repeated = await initializeGalaxyIntegration(dataDir, {
    profile: 'coding-case',
    source: 'test',
  });
  assert.deepEqual(repeated.addedModuleIds, []);

  assert.throws(
    () => previewGalaxyIntegration({ modules: ['remote-sync'] }),
    /planned and cannot be initialized/,
  );
  const hubPreview = previewGalaxyIntegration({ initializationPath: 'galaxy-hub' });
  assert.equal(hubPreview.operation, 'future-path-preview');
  assert.equal(hubPreview.canInitialize, false);
  assert.equal(hubPreview.initializationPath.id, 'galaxy-hub');
  await assert.rejects(
    () => initializeGalaxyIntegration(dataDir, { initializationPath: 'galaxy-hub' }),
    /planned and cannot be initialized/,
  );
});
