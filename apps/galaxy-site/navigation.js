// All navigation stays visible. Only a slow document navigation gets a loader.
(() => {
  "use strict";
  const progress = document.querySelector(".navigation-progress");
  if (!progress) return;
  let pending;
  function clearProgress() {
    clearTimeout(pending);
    progress.hidden = true;
  }
  document.addEventListener("click", event => {
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
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") clearProgress();
  });
})();
