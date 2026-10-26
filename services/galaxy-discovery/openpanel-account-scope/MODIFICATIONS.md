# OpenPanel public2: Galaxy account analytics scope

Upstream: https://github.com/Openpanel-dev/openpanel

Fixed commit: `cd24bb838301df1a9087e2e132b344e5b8a99963`.

Modification date: 2026-10-23. License: preserve upstream `LICENSE.md`
(GNU Affero General Public License v3) and all upstream notices. The full
modified corresponding source, dependency lock, native Dockerfile, this build
Dockerfile, adaptations and checks are supplied together. The server operator must
make that full artifact available to network users before activation. Planned
source URL, published by the root operator only:
https://agigalaxy.org/open-source/openpanel-public2-galaxy-accounts-20261023/source.tar.gz

## Narrow change

Only Insights `/:projectId/retention/cohort` and `/:projectId/user_flow` accept
`scope=accounts` and optional UUID `accountId`. The latter requires the former.
The request cannot supply filters/SQL/prefixes. The handler builds the native
`profile_id` prefix or exact account-ID filter, preserving the authenticated
project-bound read client and native result JSON. Scope, exact account (when
present), and actual flow query timezone are acknowledged in response headers.
The fixed source URL is also exposed as `Link; rel="source"`. Cohort cannot
claim a project timezone: it retains native ClickHouse defaults.

The native retention engine applies the same generated filter to entry and
return events. It retains the rolling 12-week window, weekly grouping,
window-local first qualifying activity and `on_or_after` cumulative semantics.
`toStartOfWeek` has no explicit mode/timezone in this fixed upstream version;
the adaptation does not change that or relabel it as registration retention.

In account scope only, native Sankey anchors and ordered events use the same
filter, and the source key becomes `(profile_id, session_id)` before native
deduplication, slicing and Top-entry aggregation. No anonymous attribution,
alias merge or same-device A/B stitching is performed. Default valid requests
without scope retain native data/SQL semantics; both new route schemas reject
unknown query keys instead of silently accepting a general filter channel.

## Build and verification

`Dockerfile.account-scope` derives from the fixed upstream API Dockerfile.
It retains the native pnpm lock and API build, adds only two concentrated
handler/SQL-building checks, and never runs migrations. The dummy build DSN
cannot connect; no runtime configuration, model, secret or real analytics is
loaded. Those checks double database execution, not SQL construction. They do
not establish real ClickHouse behavior, native current data, sample quality or
production activation. The literal-row SQL in
`/opt/galaxy-account-scope/checks/real-data-check.sql` is available for the root's
single read-only native acceptance step at activation. It checks key/filter
semantics; the root also verifies both actual scoped API responses.

No database schema, background worker, client identity, native project,
credential, source history, volume, or running service is changed by the build.
The build tool only prepares its unique build directory and new image tag.

## AI agent deployment

Use the existing protected discovery configuration and project-bound read
client; never print it. Build from the complete source package, frozen lock
and Dockerfile. Publish this exact modified corresponding source before
activating the new API image. Retain runtime env/ports/volumes/project IDs;
there is no new configuration or migration for this adaptation. A successful image
build is not a service activation. Check health, project binding, rejected
scope/UUID/filter requests, scope acknowledgement, and both scoped native
cohort/path responses when the root activates. Do not capture upstream
`migrate.ts` stdout: it can print database/ClickHouse URLs. Do not introduce a
new analytics stack or write real account events as test fixtures.
