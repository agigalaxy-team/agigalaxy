# `/Galaxy` command surface

`/Galaxy` is the portable user command. A host-specific plugin, slash-command facility, Skill trigger, or natural-language adapter may recognize it, but the adapter must call the same local `galaxy_command` MCP tool before deciding what to do.

| User input | MCP command | Required behavior |
|---|---|---|
| `/Galaxy` | `open` | First-run setup only when no local integration exists; otherwise open normal Galaxy services. |
| `/Galaxy help` | `help` | Show the portable command directory. This is read-only. |
| `/Galaxy status` | `status` | Show the local initialization path, enabled services, and local-only boundary. |
| `/Galaxy connect` | `connect` | Read the local Connection Profile and Scope state. Never connect, bind, initialize, or transfer data. |
| `/Galaxy setup` | `setup` | Show a configuration-change route. Preview and explicit confirmation are required before writing. |
| `/Galaxy case` | `case` | Enter the local Case workflow when enabled; otherwise offer a configuration preview. |
| `/Galaxy privacy` | `privacy` | Enter consent and disclosure controls when enabled; otherwise offer a configuration preview. |
| `/Galaxy language` | `language` | Reopen the bilingual display-language choice. It changes only the current host interaction. |
| `/Galaxy website` or `/Galaxy 官网` | `website` → `galaxy_open_official_website` | On explicit request only, open the configured official HTTPS site in the Windows default browser. If no URL is configured, report that fact; never substitute a local preview or guessed domain. |
| `/Galaxy worker` | `worker` | Explain the Worker path. In Founding Beta it is planned, not runnable. |
| `/Galaxy hub` | `hub` | Explain the Hub path. In Founding Beta it is planned, not runnable. |

Host adapters must not store their own authoritative Galaxy state, bypass MCP confirmation, invent a Worker/Hub runtime, or treat a slash-command invocation as Evidence. The Galaxy Core state and its audit events remain authoritative.
