# Current-read renewal fixture

This finite headless check bundles the actual current Admin read hook and compares it with the three exact F13 files under `fixtures/f13`. It observes real React/DOM and the actual lifecycle helpers. The request/authority/backend and poll, stream-resync, command-progress triggers are explicit local doubles; Playwright clock advances the delay and expiry. It does not replace the real server concurrency or post-deployment acceptance.

From the repository root, first install the normal repository/Admin Node dependencies, then run:

```sh
npm install --ignore-scripts --no-audit --no-fund --prefix tools/qa/operations-read-renewal
npx --prefix tools/qa/operations-read-renewal playwright install chromium
node tools/qa/operations-read-renewal/check.cjs --output outputs/qa-read-renewal-review
```

Select a fresh output directory. The seven phases reproduce the old slow-read expiry, verify quiet early renewal and deduplication while preserving DOM/draft/focus/caret/scroll, enforce true expiry, retain explicit refresh, reject late results after source/role change, clean up unmount, and preserve other consumers’ default renewal lead. `validation.json` distinguishes the expected old failure from the current phases. Every browser uses a fresh context, headless mode and closed local routes; no personal browser profile is used.

`GALAXY_QA_PLAYWRIGHT_MODULE` and `GALAXY_QA_CHROMIUM_EXECUTABLE` may explicitly select an already installed test toolchain. They never select product source. The default product root and all before-fixtures are inside this checkout. The observed toolchain for this local record is Playwright 1.62.1; a fresh network dependency installation is separate from using the supplied dependencies. Provenance is in `SOURCE.json`.
