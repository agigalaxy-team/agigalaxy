import {attachCopyTarget,copyStatusText} from './interaction-copy.mjs';

// All navigation stays visible. Only a slow document navigation gets a loader.
(() => {
  "use strict";
  // Keep the readable, no-App guide useful when the workspace cannot start.
  // The workspace renders its own copy controls after replacing this tree.
  const copies=[];
  document.querySelectorAll('.selected-public-shell .public-page-content pre').forEach((pre,index) => {
    const code = pre.querySelector('code');
    if (!code || pre.closest('.guide-code-block')) return;
    const block = document.createElement('div'); block.className = 'guide-code-block';
    const actions = document.createElement('div'); actions.className = 'guide-code-actions';
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'guide-code-copy'; button.textContent = '复制内容';
    const status = document.createElement('span'); status.className = 'guide-code-status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    actions.append(button, status); pre.before(block); block.append(actions, pre);
    const copy=attachCopyTarget({scope:location.pathname,instanceId:'body:'+index,trigger:button,content:code,onStatus:value=>{status.textContent=copyStatusText[value];}});
    copies.push(copy);button.addEventListener('click',()=>void copy.copy());
  });
  window.addEventListener('galaxy:app-ready',()=>{for(const copy of copies)copy.dispose({handoff:true});copies.length=0;},{once:true});
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
