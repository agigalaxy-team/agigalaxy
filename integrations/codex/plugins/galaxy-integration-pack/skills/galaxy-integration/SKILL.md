---
name: galaxy-integration
description: Use the local Galaxy tools for identity setup, work records, privacy, and local cases.
---

Use `galaxy_command` for an explicit `/Galaxy` request and follow its returned route. For local setup, read `galaxy_integration_status`. Reuse the existing Galaxy ID. When the user requests setup or a change, preview it with `galaxy_integration_preview_initialization`, then use `galaxy_integration_initialize` with the tool’s confirmation. Read the [command reference](references/galaxy-command-surface.md) or [module choices](references/module-selection.md) only as needed.

For official service access or the current client installation, use the [Galaxy setup guide](https://agigalaxy.org/agent.md).
