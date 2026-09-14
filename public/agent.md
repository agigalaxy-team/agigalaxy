# Galaxy Founding Beta — Agent Guide

## Product status

Galaxy Founding Beta is a local-development prototype for difficult AI Coding Cases. It is not a deployed public network, verified identity service, Hub, marketplace, production Evidence registry, or a public plugin installation channel.

## Primary integration path

Galaxy is presented to users as **Galaxy Integration Pack**, not as a user-operated npm CLI. The package combines an MCP server with an AI Skill so an MCP-capable host can guide module selection.

Use this sequence:

1. Call `galaxy_integration_status`.
2. Call `galaxy_integration_list_modules` if no integration has been initialized.
3. Ask the user to choose a profile or explicit modules, then call `galaxy_integration_preview_initialization`.
4. Explain selected modules, implied dependencies, local data effects, and the absence of remote effects.
5. Obtain explicit human confirmation in the conversation.
6. Only then call `galaxy_integration_initialize` with its required confirmation value.

Never tell an end user to run `npm install`, `npm run mcp`, or the internal Galaxy ID fallback. The installed Integration Pack and AI host own process startup. Do not guide remote deployment or public release: neither is authorized in Founding Beta.

## `/Galaxy` routing

Treat `/Galaxy` as a state-aware user entry. Call `galaxy_command` first rather than restarting setup:

- `needs-initialization`: present Personal Galaxy, Galaxy Worker, and Galaxy Hub. Only Personal Galaxy is currently initializable.
- `ready`: continue with the requested local service without another initialization confirmation.
- `needs-configuration-change`: preview the change and obtain confirmation before enabling anything.
- `planned-service`: explain that Worker/Hub is not implemented; do not create a placeholder runtime.

`/Galaxy setup` explicitly enters the configuration-change route. `/Galaxy case`, `/Galaxy privacy`, `/Galaxy worker`, and `/Galaxy hub` map to their matching `galaxy_command` values. A host may recognize the literal slash command, a plugin command, or the plain-language equivalent, but must not keep its own authoritative Galaxy state.

## Profiles and modules

| Profile | Enabled local scope |
|---|---|
| `minimal` | Galaxy ID |
| `coding-case` | Galaxy ID, Coding Case workspace, disclosure and consent controls |
| `agent-workspace` | All current modules, including MCP workspace and AI-guided setup |

`openclaw-adapter`, `github-ci-verification`, and `remote-sync` are planned only. Reject requests to initialize them rather than implying they are active.

## Critical facts and consent rules

- A Galaxy ID is local device-held key material and an identifier. New local identities use a strict 32-character `GUID-32 v1`; its fields are limited to format version, immutable issuance context, creation time, and an opaque Genesis Commitment. It is not a verified person, account, capability claim, Hub relationship, device identity, or public profile.
- Do not infer holder type, binding, capability, trust, verification, Hub membership, or personal data from a GUID-32. Existing IDs may be legacy and must not be silently rewritten.
- A Consent Grant is purpose-, recipient-, scope-, and expiry-limited.
- Never infer permission to send raw source, `.env`, Secret, token, credential, browser data, or unselected files.
- A successful MCP call is not Evidence, independent Verification, or a Track Record entry.
- The user must review a Disclosure Plan before confirming a Local Proof Draft.
- Current modules do not upload Case content, publish Proof, create remote accounts, or enable remote sync.

## Local MCP tools

| Tool | Meaning |
|---|---|
| `galaxy_integration_list_modules` | List available modules, profiles, dependencies, and planned modules. |
| `galaxy_integration_preview_initialization` | Resolve a requested local module plan without writing state. |
| `galaxy_integration_initialize` | Initialize selected local modules only after explicit confirmation. |
| `galaxy_integration_status` | Read local integration state without creating a Galaxy ID. |
| `galaxy_command` | Route `/Galaxy` to one-time setup, normal service, explicit configuration change, or an honest planned-service response. |
| `galaxy_identity_status` | Read the initialized local Galaxy ID and draft counts. |
| `galaxy_identity_describe_guid` | Explain the limited GUID-32 format of the initialized ID, or report that an older ID is legacy. |
| `galaxy_case_create_escalation_draft` | Create a local Coding Case Draft when `case-workspace` is enabled. |
| `galaxy_case_preview_disclosure` | Generate a local disclosure preview when `consent-controls` is enabled. |
| `galaxy_case_confirm_local_proof_draft` | Create a local Consent Grant and Local Proof Draft after review. |
| `galaxy_consent_revoke` | Revoke a local Consent Grant. |
| `galaxy_history_list_local_drafts` | Read local drafts and receipts when `case-workspace` is enabled. |

## Related documents

- `/llms.txt`
- Repository `README.md`
- `integrations/codex/plugins/galaxy-integration-pack/skills/galaxy-integration/SKILL.md`
- `docs/GALAXY_DATA_AND_CAPABILITY_CONSENT_v0.1.md`
- `docs/OPENCLAW_ADAPTER_BOUNDARY.md`
