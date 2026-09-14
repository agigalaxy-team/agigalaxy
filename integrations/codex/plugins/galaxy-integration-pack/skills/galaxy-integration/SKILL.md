---
name: galaxy-integration
description: Route /Galaxy requests to first-run setup, explicit configuration changes, or normal local Galaxy services. Use when a user asks to set up, open, or use Galaxy features; do not use for remote deployment or public release.
---

# Galaxy Integration

Galaxy is installed as an AI integration package, not as a user-operated npm CLI. Treat the underlying local runtime as an implementation detail. `/Galaxy` is a user-facing entry command; it is not a request to rerun setup.

## `/Galaxy` command routing

When the user writes `/Galaxy`, `/Galaxy help`, `/Galaxy status`, `/Galaxy setup`, `/Galaxy case`, `/Galaxy privacy`, `/Galaxy language`, `/Galaxy website`, `/Galaxy worker`, or `/Galaxy hub`, call `galaxy_command` with the matching command first. Read [the command surface](references/galaxy-command-surface.md) when adapting this behavior to a host.

- If it returns `needs-initialization`, explain that setup happens once on this device and proceed to first-run setup.
- If it returns `ready`, continue with that local service. Do not list paths or request initialization confirmation again.
- If it returns `needs-configuration-change`, explain the missing local service and offer a preview; do not enable it without confirmation.
- If it returns `planned-service`, state that the requested Worker or Hub runtime is not implemented. Do not create a placeholder runtime or imply it is active.
- If it returns `website-entry`, call `galaxy_open_official_website` only when the user explicitly asked for `/Galaxy website` or `/Galaxy 官网`. The MCP tool itself requires a dedicated confirmation, opens only a configured HTTPS address on Windows, and must report an unconfigured site rather than open a local preview or invent a domain.

## First-run or configuration-change workflow

1. Call `galaxy_integration_status`. If no integration is initialized, call `galaxy_integration_list_modules`.
2. First help the user choose an initialization path: **Personal Galaxy**, **Galaxy Worker**, or **Galaxy Hub**. Current Founding Beta can initialize only Personal Galaxy; Worker and Hub are visible architecture paths, not available runtimes.
3. Call `galaxy_integration_preview_initialization` with `initializationPath` and state the selected path, internal capabilities, local data effects, and the fact that no remote effects occur. Read [module selection](references/module-selection.md) only when the user asks to use a legacy profile or an explicit internal capability set.
4. Ask for a clear user confirmation. Do not initialize merely because a user asked a question or expressed interest.
5. Only after confirmation, call `galaxy_integration_initialize` with its required confirmation value. Report the resulting Galaxy ID, initialization path, enabled capabilities, and whether this was first setup or a configuration change.

### Text interaction routing

For any text-only host, display the `interactionGuide` returned by the language selection, current initialization stage, or console **verbatim as user-visible rules**. It is not hidden adapter guidance. Accept only its listed route inputs: language selection accepts `1` / Chinese or `2` / English; stages 1, 3 and 4 accept their sole available numbered option; stage 2 requires `继续` / `continue`; stage 5 requires the exact confirmation phrase. `返回` / `back` follows the guide's listed previous stage, while `取消` / `cancel` exits without a write. Planned options remain unavailable and leave the user on the current stage.

The Adapter may retain the selected language and current stage only in its host conversation/session state so it can ask Core for the next contract. It must never write this transient navigation state into the Galaxy local store. `/Galaxy help` and `/Galaxy status` are safe global routes; render the console's `interactionGuide` as the same kind of explicit text map after initialization.

## Operating constraints

- Say **Galaxy ID**, not “Node,” in user-facing language. A Galaxy ID is not an account, verified identity, capability claim, or public profile.
- New local identities use the strict 32-character `GUID-32 v1` shape. Do not infer a holder type, Hub relationship, trust level, device, binding, or capability from it; use `galaxy_identity_describe_guid` only to explain its limited format metadata.
- Never tell the user to run `npm install`, `npm run mcp`, or the internal Galaxy ID fallback. The plugin or an MCP-capable host owns process startup.
- Personal Galaxy, Galaxy Worker, and Galaxy Hub are deployment paths, not permanent or mutually exclusive subject identities. A personal Galaxy may later control a Worker or connect to a Hub; a Hub cannot own or rewrite a member's Galaxy ID.
- Existing Founding Beta modules are local-only. Do not imply remote sync, public Proof, Hub access, accounts, login, verification, Evidence, or data transfer.
- Tool calls that create Case, Consent, or Proof Drafts require their corresponding initialized modules. If unavailable, return to module preview and obtain confirmation before enabling more modules.
- A successful MCP tool call is not Evidence or independent Verification.
- `/Galaxy language` changes only the current host interaction language. It is not a Galaxy ID property and must never be persisted as identity or initialization state.

## Current scope

Use `personal-galaxy` for the current product-facing setup. `minimal`, `coding-case`, and `agent-workspace` remain compatibility profiles for development and advanced configuration, not the first user-facing choice.

Planned adapters are visible for roadmap clarity but cannot be initialized. Do not offer workarounds that bypass this restriction.
