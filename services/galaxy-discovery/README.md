# Discovery service adapters

This directory currently contains the closed Gorse HTTP gateway. Hub adapters for search, analytics and recommendation remain in `packages/galaxy-official/src`; this folder is not an independently implemented recommendation engine or another business database.

`gorse-gateway.mjs` checks the caller key before forwarding to private Gorse. It admits readiness, the existing user/item/feedback writes, item removal and bounded latest/recommendation queries. `n` and `offset` are at most 100; duplicate and unknown parameters fail. Source eligibility, content permissions and business attribution remain Hub responsibilities.

The process requires `GALAXY_GORSE_GATEWAY_KEY` and a distinct `GALAXY_GORSE_NATIVE_KEY`, each at least 32 characters. Inject them through protected process configuration. `GORSE_UPSTREAM` defaults to the private Docker origin `http://gorse:8088`; it accepts no username/password or path. `PORT` defaults to 8080, and the listener binds all interfaces inside its container. Keep the gateway and native engine on the intended private network; the native engine's failed-auth logs can contain submitted API keys, so it must not be exposed to untrusted clients.

From this repository:

```sh
node scripts/components.mjs check --component discovery --output outputs/check-discovery
docker build -f services/galaxy-discovery/Dockerfile.gorse-gateway services/galaxy-discovery
```

The check runs actual loopback HTTP requests against a synthetic upstream and tests pagination and closed routing. Docker builds, engine configuration, derived index recovery and actual recommendation quality require their own observed results. Gateway failures return closed error codes without upstream bodies. Gorse, OpenPanel and search-engine versions, licenses, storage and rebuild procedures remain separate from this adapter.
