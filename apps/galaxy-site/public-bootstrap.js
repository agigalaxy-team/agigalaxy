// Progressive startup of the same workspace App on current public pages.
// Page content is a checked tree. No document HTML or inline scripts are run.
(() => {
  'use strict';
  if (!document.body.classList.contains('selected-public-shell') || !document.getElementById('root')) return;
  const originalClasses = document.body.className;
  const addedStyles = [];
  const publicPath = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  const assetUrl = value => typeof value === 'string' && /^\/app\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(value);
  async function json(url) {
    const response = await fetch(url, {headers: {accept: 'application/json'}});
    if (!response.ok) throw new Error('The selected workspace files are unavailable');
    return response.json();
  }
  async function start() {
    try {
      const [assets, page] = await Promise.all([
        json('/assets/workspace-entry.json'),
        json('/assets/public-pages' + publicPath + 'index.json'),
      ]);
      if (assets.version !== 1 || !assetUrl(assets.entry) || !assets.entry.endsWith('.js')
        || !Array.isArray(assets.styles) || !assets.styles.length
        || !assets.styles.every(value => assetUrl(value) && value.endsWith('.css'))
        || page.path !== publicPath || page.version !== 1) throw new Error('The selected workspace files do not match');
      await Promise.all(assets.styles.map(href => new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = href;
        link.dataset.galaxyWebAsset = '';
        link.onload = resolve; link.onerror = reject;
        addedStyles.push(link); document.head.append(link);
      })));
      globalThis.__GALAXY_PUBLIC_PAGE__ = page;
      document.body.classList.remove('galaxy-site', 'selected-shell', 'selected-public-shell');
      await import(assets.entry);
      requestAnimationFrame(() => {
        document.querySelectorAll('[data-galaxy-static-style]').forEach(link => link.remove());
        window.dispatchEvent(new Event('galaxy:app-ready'));
      });
    } catch {
      // The original URL and fully readable page remain the fallback.
      document.body.className = originalClasses;
      addedStyles.forEach(link => link.remove());
      delete globalThis.__GALAXY_PUBLIC_PAGE__;
    }
  }
  void start();
})();
