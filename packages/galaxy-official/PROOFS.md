# Remote Proof implementation

Migration 6 adds remote Proof records and monotonic verification-attempt ordering. These records are distinct from Local Proof Drafts.

The only implemented Proof type is ci-execution-observation. It states that the specified public CI run was observed with a particular conclusion. It explicitly retains repository-controlled independence, asserted attribution, unverified task outcome and capabilityVerified:false. A failed completed CI run can also be described accurately; success is not fabricated and is not a competence guarantee.

POST /v1/proof-previews requires the proof scope and returns the exact minimal payload bytes and digest, without publishing. The local client must separately approve and sign a proof.publish consent over those bytes. POST /v1/proofs rechecks the live source, reconstructs the expected projection, compares exact bytes and validates consent before signing. The projection excludes local Case text and internal Result IDs, but contains approved public source references and the subject: users must review that association before public sharing.

GET /v1/proofs/{id} and its /status suffix recheck live source history, current observation, grants, visibility, signing key and expiry. Public access requires a Public/public-profile consent. Private and Proof-only are not implicitly anonymous. Hidden, unknown, revoked and no-longer-authorized records return the same not-found response. POST /v1/proofs/{id}/revoke is subject-owned and audited. A changed source observation invalidates the previous Proof view; it does not silently replace its signed contents.

Reads and writes use source-history and grant checks within their database transaction. API responses are not cached. This prevents serving invalidated objects through these handlers, but does not yet implement invalidation of future Search/Honor/Profile projections. Copies already obtained by third parties cannot be erased; consumers must check current status and expiry instead of relying only on the signature.

Tests use synthetic CI responses and identities and cover preview refusal before observation, exact-payload enforcement, signed strength limits, private/public access, revocation, source-grant invalidation and HTTP read/status responses. Production PostgreSQL concurrency, real source evidence, client confirmation UI, dispute integration, indexes and deployment remain pending. No real capability certification or public production Proof has been issued by these tests.
