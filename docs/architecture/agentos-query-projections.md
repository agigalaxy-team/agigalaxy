# Administrative AI query projections

`packages/galaxy-official/src/operations/agentos/query/` owns the safe output
projections for the registration directory and system settings. The historical
`operations-agentos-query-extensions-view.mjs` entry is an explicit compatibility
barrel. Query dispatch, current human/AI permission intersections and evidence
leases stay in their existing services; these files do not perform effects.

- `registered-directory.mjs`: registration population, page and business-link DTOs.
- `system-settings.mjs`: published general settings, mail, service and advanced DTOs.
- `safe-values.mjs`: bounded scalar values and the combined read lease.

The registered directory is not the count of business profiles. System general
settings describe the current public publication, never an unread CMS draft.
Mail and service results retain their own target/connection/adopted-version
relationships. Never spread upstream DTOs into a result. Credentials, references,
raw subjects, issuer values, sessions and upstream errors remain excluded.

## AI-agent deployment

Discover the current frozen source and API release manifest before changing these
modules. Preserve the legacy barrel exports and current permission/lease checks.
The release generator recursively includes these `.mjs` modules; verify all new
paths and their hashes in the generated service manifest. No model, runtime
credential, database schema or native AgentOS change is required for this split.

Run the affected existing registration/system query and mail-consumer leaves.
They exercise actual service/projection code with explicit transport/SQL doubles;
do not call them production or PostgreSQL evidence. A successful import alone
does not prove that the release artifact contains the new modules. Do not repeat
provider queries only to prove an unchanged file location.
