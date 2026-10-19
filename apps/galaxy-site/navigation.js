// All navigation stays visible. Only a slow document navigation gets a loader.
(() => {
  "use strict";
  // Keep the readable, no-App guide useful when the workspace cannot start.
  // The workspace renders its own copy controls after replacing this tree.
  document.querySelectorAll('.selected-public-shell .guide-body pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (!code || pre.closest('.guide-code-block')) return;
    const block = document.createElement('div'); block.className = 'guide-code-block';
    const actions = document.createElement('div'); actions.className = 'guide-code-actions';
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'guide-code-copy'; button.textContent = '复制内容';
    const status = document.createElement('span'); status.className = 'guide-code-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    actions.append(button, status); pre.before(block); block.append(actions, pre);
    button.addEventListener('focusout', event => {
      const current = globalThis.__GALAXY_GUIDE_COPY__;
      if (event.relatedTarget instanceof Element && event.relatedTarget !== button
        && current?.path === location.pathname && current.exactText === (code.textContent || '')) current.focused = false;
    });
    button.addEventListener('click', async () => {
      const copyState = {path: location.pathname, exactText: code.textContent || '', status: '', focused: document.activeElement === button};
      globalThis.__GALAXY_GUIDE_COPY__ = copyState;
      window.dispatchEvent(new Event('galaxy:guide-copy'));
      const feedback = value => {
        if (globalThis.__GALAXY_GUIDE_COPY__ !== copyState) return false;
        copyState.status = value;
        copyState.focused = document.activeElement === button
          || (!button.isConnected && (document.activeElement === document.body || document.activeElement?.classList.contains('guide-code-copy')));
        status.textContent = value;
        window.dispatchEvent(new Event('galaxy:guide-copy'));
        return true;
      };
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(copyState.exactText);
        feedback('已复制');
      } catch {
        if (globalThis.__GALAXY_GUIDE_COPY__ !== copyState) return;
        const range = document.createRange(); range.selectNodeContents(code);
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges(); selection.addRange(range);
          feedback('已选中，请复制');
        } else feedback('请选中文字复制');
      }
    });
  });
  const progress = document.querySelector(".navigation-progress");
  if (!progress) return;
  let pending;
  let appReady = false;
  function clearProgress() {
    clearTimeout(pending);
    progress.hidden = true;
  }
  document.addEventListener("click", event => {
    if (appReady) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const destination = new URL(anchor.href, location.href);
    if (destination.origin !== location.origin || /\.[^/]+$/.test(destination.pathname)) return;
    if (destination.pathname === location.pathname && destination.search === location.search) return;
    clearProgress();
    pending = setTimeout(() => { progress.hidden = false; }, 160);
  });
  window.addEventListener("pageshow", clearProgress);
  window.addEventListener("pagehide", clearProgress);
  window.addEventListener('galaxy:app-ready', () => { appReady = true; clearProgress(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") clearProgress();
  });
})();
