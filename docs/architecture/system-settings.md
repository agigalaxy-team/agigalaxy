# System settings implementation boundaries

The public Payload entry remains `components/SystemSettingsView.tsx`. It reads the current management identity and initial data, then uses the existing `BusinessViewClients` dynamic boundary.

The actual client editor, its section/phase panels, mail operation controls and domain CSS live together under `components/system-settings/`. This move changes import locations only. The shared `system-settings-types.ts` DTOs and `lib/system-settings-*` adapters stay at their existing public paths because the audit links, BFF handlers and draft/receipt hooks consume them too. No forwarding components or second navigation layer were added.

The four fixed tabs remain general, mail, service connections and advanced. Saving a draft does not mean applying it. Original-operation results bind the exact owner, operation, kind, revision and version; current consumer adoption is a separate read. The editor continues to use the existing draft boundary, login-scoped memory and current read leases.

## AI-agent deployment and maintenance

Use the frozen release manifest selected by the integration owner; the full canonical working tree may contain unrelated unpublished work. Build the actual management application with its Linux Next/TypeScript entry, preserve old static assets during the existing activation workflow, and inspect only the affected real settings entry after a pure module move. Moving this directory does not authorize configuration changes or test mail.

Discover settings from the existing typed services and protected runtime references. Never copy credentials, cookies, raw SMTP passwords or service keys into source, browser evidence or operation logs. A failed read of an original result cannot be presented as proof that the original business operation failed. Do not repeat an operation merely because its terminal result is temporarily unavailable.

The root administrator, manual model configuration, deferred external-agent API, held migration120 and disabled production restore retain their separately approved boundaries. Use the normal management identity and current function/action permissions; source paths and remembered UI state do not grant authority.
