# Galaxy client SDK

Shared clients used by the Next.js website, administration UI, host adapters and Node tools. This package does not run a Hub or a Native persistence service.

- `src/browser-client.mjs` and adjacent modules implement existing HTTP, signed request and verification contracts.
- `src/browser-identity/` and browser summary modules retain browser-owned device keys and IndexedDB; they are loaded only in the browser.
- `src/node/` contains Node-only public fetch, connection, logging and offline governance helpers. It is not part of browser initialization and does not write Native private stores.
- Schemas, canonical bytes and permission definitions come from `../galaxy-contracts`; Go owns server transactions and Native persistence.

Source imports are consumed by the existing application builds. Install the locked dependencies with `npm ci --ignore-scripts` here or the root `npm run setup`; select affected regressions under `test/` through the root test command. Deployment credentials and actual host configuration stay outside this package.
