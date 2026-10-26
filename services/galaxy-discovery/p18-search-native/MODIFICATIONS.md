# OpenPanel public2: P18 chart series identity

Fixed upstream: Openpanel-dev/openpanel commit
`cd24bb838301df1a9087e2e132b344e5b8a99963`, GNU Affero General Public License v3.
This complete source also retains the previously applied Galaxy account-scope
patch and original upstream notices and dependency lock.

The native `/export/charts` controller's `series` and legacy `events` schemas
previously stripped optional definition IDs, although its native formatter
supports `event.id` and sorts results by their sums. Search and no-result series
both use the event name `search`; stripping their IDs made a nonempty result
ambiguous. This patch preserves optional nonempty IDs of at most100 characters
in those two schemas. Requests without an ID keep their prior behavior. It
adds the fixed corresponding-source Link to successful chart responses.

Project-bound native reader authentication, account scope, data storage,
query/filter algorithms, metrics, date handling and formatter are unchanged.
The build only runs this patch's one schema/controller/formatter leaf; native
query execution and project lookup in that leaf are explicit doubles. Empty
live native reads are separate evidence. No analytics events, models or keys
are created, and no migration is run.

Complete corresponding source, published before activating this image:
https://agigalaxy.org/open-source/openpanel-public2-galaxy-search-20261023/source.tar.gz

## Build and AI-agent deployment

Extract the complete archive, enter `p18-search-native-cd24bb8-r1/`, and run:
`docker build -f Dockerfile.p18-search-native -t galaxy-openpanel-api:2-p18-search-native-20261023-r1 .`
The source retains the native pnpm lock, original build files and all previous
account-scope modifications, plus this patch, focused check and deployment tool.
No runtime env or credentials belong in the archive.

Publish the complete archive and README before activation. Preserve the existing
discovery runtime env, volumes, project/client IDs, ports and image overrides.
Recreate only `op-api`, with its existing `node dist/index.js` command. Never
run upstream migrations just to apply this controller-only change; their logs
can contain DSNs. Do not replace the Gorse gateway override. Check health and
the single new five-series native read; missing/empty series remain unknown,
and do not write analytics events to manufacture a nonempty acceptance result.
