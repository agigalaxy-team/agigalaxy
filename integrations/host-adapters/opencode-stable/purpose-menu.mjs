import { createPurposeSearch } from './purpose/search.mjs';
import { createPurposeMessages } from './purpose/messages.mjs';
import { createPurposeIdentity } from './purpose/identity.mjs';
import { createPurposeContinuation } from './purpose/continuation.mjs';
import { createNativeCapsuleMenu } from './capsule-native-menu.mjs';
import { createNativeA2aMenu } from './a2a-native-menu.mjs';
import { createProjectDiscoveryMenu } from './project-discovery-menu.mjs';
import { nativeConfigurationMessage } from '../../native-v2/presentation/native-configuration-message.mjs';
import { unwrap, fingerprint } from './purpose/presentation.mjs';

// Optional foreground Native bridge, supplied by the host. No service, model,
// identity, account or connection is silently created to populate the menu.
export function createPurposeMenu({
  nativeTools,
  controller,
  select,
  prompt,
  info,
  readInfo = info,
  language = 'zh-CN',
  isCurrent,
  onBack,
  onReturnWork = onBack,
  readWorkContext,
}) {
  const zh = language !== 'en-US',
    label = (cn, en) => (zh ? cn : en);
  let version = 0,
    owner = null,
    navigationId = null,
    capsuleMenu = null,
    a2aMenu = null,
    projectMenu = null,
    taskMenu = null,
    messageTimer = null;
  const stopMessages = () => {
    clearTimeout(messageTimer);
    messageTimer = null;
  };
  const alive = (v) => isCurrent() && (v === undefined || v === version);
  const menu = (title, entries, back = onBack, offset = 0) => {
    if (!alive()) return;
    stopMessages();
    const v = ++version,
      routes = {};
    const options = entries
      .slice(offset, offset + 8)
      .map(([title, fn, description = ''], i) => {
        routes[i + 1] = () => {
          if (alive(v)) fn();
        };
        return { number: String(i + 1), title, description };
      });
    if (offset + 8 < entries.length) {
      options.push({
        number: '9',
        title: label('其他内容', 'More content'),
        description: '',
      });
      routes[9] = () => menu(title, entries, back, offset + 8);
    }
    select({
      title,
      options,
      routes,
      onBack: () => {
        if (alive(v))
          (offset
            ? () => menu(title, entries, back, Math.max(0, offset - 8))
            : back)();
      },
    });
  };
  const message = (title, text, back = onBack) => {
    if (!alive()) return;
    stopMessages();
    const v = ++version;
    info(title, text, () => {
      if (alive(v)) back();
    });
  };
  const readingMessage = (title, text, back = onBack) => {
    if (!alive()) return;
    stopMessages();
    const v = ++version;
    readInfo(title, text, () => {
      if (alive(v)) back();
    });
  };
  async function native(name, args = {}) {
    const before = unwrap(await nativeTools.call('galaxy_native_status', {}));
    if (owner !== null && owner !== fingerprint(before))
      throw Error('current_identity_changed');
    owner ??= fingerprint(before);
    const data = unwrap(await nativeTools.call(name, args));
    const after = unwrap(await nativeTools.call('galaxy_native_status', {}));
    if (owner !== fingerprint(after)) throw Error('current_identity_changed');
    return data;
  }
  async function run(fn, done, back = onBack) {
    stopMessages();
    const v = ++version;
    info(
      'Galaxy',
      label('正在取得当前内容…', 'Reading current content…'),
      () => {
        if (alive(v)) {
          version++;
          controller?.cancel?.();
          back();
        }
      },
    );
    try {
      const result = await fn();
      if (alive(v)) await done(result);
    } catch (error) {
      if (alive(v)) {
        if (error.message === 'native_connection_choice_required')
          return identity(() => void run(fn, done, back), back);
        message(
          'Galaxy',
          String(error.message).startsWith('native_configuration_')
            ? nativeConfigurationMessage(error, language)
            : label(
                '当前内容暂不可用。可以回到原工作继续，或稍后重试。',
                'Current content is unavailable. Continue the original work or retry later.',
              ),
          back,
        );
      }
    }
  }
  function projects(showContacts = false) {
    if (!nativeTools) return onBack();
    stopMessages();
    projectMenu?.close();
    const v = ++version;
    projectMenu = createProjectDiscoveryMenu({
      nativeCall: (name, args) => native(name, args),
      select,
      prompt,
      info,
      language,
      isCurrent: () => alive(v),
      onBack,
      onReturnWork,
      readWorkContext,
      openLink: nativeTools.openLink,
      onOpenRoom: (room) => {
        projectMenu?.close();
        roomView(room, () => projects(true));
      },
    });
    if (showContacts) projectMenu.contacts();
    else projectMenu.open();
  }
  function publish() {
    if (nativeTools) return websiteIdentity({ kind: 'publish' });
    message(
      label('发起求助', 'Ask for help'),
      label(
        '回到原聊天说明目标和需要的帮助，AI 会沿用当前内容准备求助。新的外发内容与范围仍会单独显示供你选择。',
        'Describe the goal and help needed in the original chat. AI can prepare the request from current content; new external content and scope remain your choice.',
      ),
    );
  }
  function methodMenu(back = onBack) {
    capsuleMenu?.close();
    const v = ++version;
    capsuleMenu = createNativeCapsuleMenu({
      call: (name, args) => native(name, args),
      select,
      prompt,
      info,
      language,
      isCurrent: () => alive(v),
      onBack: back,
      onReturnWork,
      readWorkContext,
      openLink: nativeTools?.openLink,
    });
    return capsuleMenu;
  }
  function methods() {
    if (!nativeTools)
      return message(
        label('方法', 'Methods'),
        label(
          '这个入口尚未提供 Native 方法工具。请从原工作使用已配置的银河工具。',
          'This entry has no Native method tools. Use the configured Galaxy tools from the original work.',
        ),
      );
    methodMenu().home();
  }
  function external() {
    if (!nativeTools) return onBack();
    stopMessages();
    a2aMenu?.close();
    const v = ++version;
    a2aMenu = createNativeA2aMenu({
      call: (name, args) => native(name, args),
      select,
      prompt,
      info,
      language,
      isCurrent: () => alive(v),
      onBack,
      onReturnWork,
      onOpenLink: nativeTools.openLink,
      readWorkContext,
    });
    a2aMenu.home();
  }
  const session = {
    get alive() {
      return alive;
    },
    get controller() {
      return controller;
    },
    get info() {
      return info;
    },
    get label() {
      return label;
    },
    get language() {
      return language;
    },
    get menu() {
      return menu;
    },
    get message() {
      return message;
    },
    get messageTimer() {
      return messageTimer;
    },
    set messageTimer(value) {
      messageTimer = value;
    },
    get methodMenu() {
      return methodMenu;
    },
    get native() {
      return native;
    },
    get nativeTools() {
      return nativeTools;
    },
    get navigationId() {
      return navigationId;
    },
    set navigationId(value) {
      navigationId = value;
    },
    get onBack() {
      return onBack;
    },
    get onReturnWork() {
      return onReturnWork;
    },
    get openObject() {
      return openObject;
    },
    get owner() {
      return owner;
    },
    set owner(value) {
      owner = value;
    },
    get projects() {
      return projects;
    },
    get prompt() {
      return prompt;
    },
    get readWorkContext() {
      return readWorkContext;
    },
    get readingMessage() {
      return readingMessage;
    },
    get run() {
      return run;
    },
    get select() {
      return select;
    },
    get stopMessages() {
      return stopMessages;
    },
    get taskMenu() {
      return taskMenu;
    },
    set taskMenu(value) {
      taskMenu = value;
    },
    get version() {
      return version;
    },
    set version(value) {
      version = value;
    },
    get websiteIdentity() {
      return websiteIdentity;
    },
  };
  const { search } = createPurposeSearch(session);
  const { messages, roomView } = createPurposeMessages(session);
  const { identity, websiteIdentity } = createPurposeIdentity(session);
  const { openObject, community, continueWeb } =
    createPurposeContinuation(session);
  return Object.freeze({
    search,
    messages,
    publish,
    identity,
    methods,
    community,
    continueWeb,
    external,
    projects,
    openObject,
    close() {
      version++;
      stopMessages();
      owner = null;
      navigationId = null;
      capsuleMenu?.close();
      a2aMenu?.close();
      projectMenu?.close();
      taskMenu?.close();
    },
  });
}
