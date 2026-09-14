# Evidence implementation status

Migration 5 adds evidence submissions, append-only verification attempts and leased jobs. POST /v1/evidence-submissions returns acceptance; GET /v1/verifications/{evidenceId} returns owned observations only while the associated Case, Attempt, Result and evidence authorizations remain active. The evidence credential scope is requested independently.

The source adapter reads a public GitHub Actions run attempt, pinned to repository, commit, run ID and attempt number. It checks the returned reference, repository identity/public status and timestamps. Results are labelled ci-execution-fact, repository-controlled and submitter-asserted attribution, with capabilitiesVerified:false. This does not establish individual contribution or task quality.

The adapter follows the [GitHub run attempt API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt), reviewed during implementation, with API version 2026-03-10. It does not rerun workflows, accept webhooks, download log archives or execute uploaded code.

The separate worker entrypoint is src/worker.mjs. It uses DATABASE_URL and GALAXY_ENDPOINT and does not load a signing key. Deployment must still enforce and test its network and database permissions; a separate process alone is not a sandbox. Claims use 30-second leases, at most five attempts and bounded backoff. These are initial implementation bounds, not measured public quotas. Source observations become stale after one hour.

Authorization is checked before collection and again before committing. Revocation during collection prevents accepting the result. Canonical per-subject source keys prevent duplicate imports. Observations retain the collection time, source references, verifier version, response digest and limitations without storing the whole API response.

Local tests use explicitly synthetic API-shaped responses. They cover source mismatch, duplicate submission, revocation before collection and revocation during collection; they are not real CI evidence. Production isolation, multi-worker crash recovery, periodic revalidation, real-source validation and downstream Proof/Search propagation remain pending. The complete C08 module is not yet accepted.
