import { divider } from './presentation.ts';
import type { Action, Routes, Menu, Prompt } from '../adapter-types.ts';
import { readableDialogSelect } from '../dialog-reading.mjs';
import { hostReadingPages } from '../host-reading-pages.mjs';
import type { GalaxyMenuSession } from './session-context.ts';

export function createHostDialogs(session: GalaxyMenuSession) {
  function installMenuKeys(
    routes: Routes,
    onEscape: Action | null,
    onHelp: Action | null,
    { includeZero = true } = {},
  ) {
    session.clearMenuKeys();
    const commands = [];
    const bindings = [];
    for (const [number, handler] of Object.entries(routes)) {
      if (number === '0') continue;
      const activate = handler as () => void;
      const name = `galaxy.choose.${number}`;
      commands.push({
        name,
        title: `Galaxy 选择 ${number}`,
        run: () => activate(),
      });
      bindings.push({ key: number, cmd: name, desc: `选择 ${number}` });
    }
    commands.push({
      name: 'galaxy.exit',
      title: '退出 Galaxy',
      run: () => onEscape?.(),
    });
    if (onHelp)
      commands.push({
        name: 'galaxy.help',
        title: 'Galaxy 交互规则',
        run: onHelp,
      });
    if (includeZero) {
      commands.push({
        name: 'galaxy.zero',
        title: 'Galaxy 返回或退出',
        run: () => (routes[0] ?? session.closeGalaxy)(),
      });
    }
    bindings.push({
      key: 'escape',
      cmd: 'galaxy.exit',
      desc: '退出 Galaxy',
    });
    // Text prompts must retain every typed character. Only an actual help
    // action owns its literal shortcut; "question" is not a host key name.
    if (onHelp)
      bindings.push({ key: '?', cmd: 'galaxy.help', desc: '交互规则' });
    if (includeZero)
      bindings.push({
        key: '0',
        cmd: 'galaxy.zero',
        desc: '返回或退出 Galaxy',
      });
    const disposeLayer = session.api.keymap.registerLayer({
      mode: 'modal',
      commands,
      bindings,
    });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      disposeLayer();
      if (session.disposeMenuKeys === dispose) session.disposeMenuKeys = null;
    };
    session.disposeMenuKeys = dispose;
    return dispose;
  }

  function pageCleanup(
    page: number,
    disposeKeys: Action,
    isTransition = () => false,
  ) {
    session.visiblePage = page;
    return () => {
      disposeKeys();
      if (session.visiblePage !== page) return;
      session.visiblePage = null;
      // Native Esc/backdrop dismissal need not invoke DialogPrompt.onCancel.
      // Internal page replacement and confirmed native transitions are distinct.
      if (!isTransition()) session.closeGalaxy();
    };
  }

  function showInfo(title: string, message: string, onConfirm: Action) {
    if (session.closed) return;
    const page = session.nextPage();
    let transitioning = false;
    const cleanup = pageCleanup(
      page,
      installMenuKeys({}, session.closeGalaxy, null, { includeZero: false }),
      () => transitioning,
    );
    session.api.ui.dialog.setSize('xlarge');
    session.api.ui.dialog.replace(
      // DialogAlert closes itself after onConfirm returns. Defer the next Galaxy page
      // so the host cannot close the newly opened controller page with the old alert.
      () =>
        session.api.ui.DialogAlert({
          title,
          message,
          onConfirm: () => {
            transitioning = true;
            setTimeout(() => {
              transitioning = false;
              if (!session.closed && page === session.pageGeneration)
                onConfirm?.();
            }, 0);
          },
        }),
      cleanup,
    );
  }

  function showReading(title: string, message: string, onConfirm: Action) {
    const pages = hostReadingPages(message, {
      width: session.api.renderer?.width ?? 80,
      height: session.api.renderer?.height ?? 24,
    });
    const render = (index: number): void =>
      showInfo(
        pages.length > 1 ? `${title} · ${index + 1}/${pages.length}` : title,
        pages[index],
        () => {
          if (index + 1 < pages.length) render(index + 1);
          else onConfirm();
        },
      );
    render(0);
  }

  function showPrompt({
    title,
    placeholder,
    value,
    onConfirm,
    onCancel = session.closeGalaxy,
  }: Prompt) {
    if (session.closed) return;
    const page = session.nextPage();
    let transitioning = false;
    // A prompt collects actual content or a value required by the operation.
    // Authorization comes from the corresponding exact native choice.
    const cleanup = pageCleanup(
      page,
      installMenuKeys({}, session.closeGalaxy, null, { includeZero: false }),
      () => transitioning,
    );
    session.api.ui.dialog.setSize('xlarge');
    session.api.ui.dialog.replace(
      () =>
        session.api.ui.DialogPrompt({
          title,
          placeholder,
          ...(value === undefined ? {} : { value }),
          onConfirm: (value) => {
            transitioning = true;
            setTimeout(() => {
              transitioning = false;
              if (!session.closed && page === session.pageGeneration)
                onConfirm(value);
            }, 0);
          },
          onCancel: () =>
            setTimeout(() => {
              if (!session.closed && page === session.pageGeneration)
                onCancel();
            }, 0),
        }),
      cleanup,
    );
  }

  function showRules(onReturn: Action) {
    showInfo(
      'Galaxy / 交互规则',
      `数字是主入口：输入本屏显示的 [1]–[9] 可直接选择。\n\n[0] 只在 Galaxy 控制台主页退出；在二级页面返回 Galaxy 控制台或上一步。\nEsc 在任何 Galaxy 页面直接退出到聊天；Enter 与方向键可使用 OpenCode 的原生选择器。\n\n${divider()}\n浏览、返回和退出不会写入本机状态。只有确认初始化或未来明确标注的确认操作才会改变本机 Galaxy。`,
      onReturn,
    );
  }

  function showSelect(input: Menu) {
    const prepared: Menu = readableDialogSelect(input);
    const {
      title,
      options,
      routes: inputRoutes,
      onBack,
      onEscape = session.closeGalaxy,
    } = prepared;
    let routes: Routes = inputRoutes;
    if (session.closed) return;
    const page = session.nextPage();
    let transitioning = false;
    routes = { 0: onBack, ...routes };
    const reopen = () =>
      showSelect({ title, options, routes, onBack, onEscape });
    const cleanup = pageCleanup(
      page,
      installMenuKeys(routes, onEscape, () => showRules(reopen)),
      () => transitioning,
    );
    session.api.ui.dialog.setSize('xlarge');
    session.api.ui.dialog.replace(
      () =>
        session.api.ui.DialogSelect({
          title: `${title}\n\n[0] 返回 · Esc 回到原工作`,
          skipFilter: true,
          options: options.map((option) => ({
            title: option.number
              ? `[${option.number}] ${option.title}`
              : option.title,
            description: option.description,
            value: option.number,
            disabled: option.disabled === true,
            // Native Select closes itself after selection. Defer a page transition so
            // its cleanup cannot dismiss the next Galaxy page.
            onSelect: () => {
              transitioning = true;
              setTimeout(() => {
                transitioning = false;
                if (!session.closed && page === session.pageGeneration) {
                  if (option.reading)
                    showInfo(title, option.description ?? '', reopen);
                  else routes[option.number]?.();
                }
              }, 0);
            },
          })),
        }),
      cleanup,
    );
  }
  return {
    installMenuKeys,
    pageCleanup,
    showInfo,
    showReading,
    showPrompt,
    showRules,
    showSelect,
  };
}
