# Galaxy Integration Pack module selection

## Available profiles

| Profile | Enables | Best for |
|---|---|---|
| `minimal` | Galaxy ID | A user who only wants a local, device-held Galaxy identifier. |
| `coding-case` | Galaxy ID, Coding Case workspace, Disclosure and consent controls | A user who wants to capture a local AI Coding Case safely. |
| `agent-workspace` | All currently available modules, including MCP workspace and AI-guided setup | A user working with a compatible coding agent. |

## Current modules

| Module | Local effect | Does not do |
|---|---|---|
| Galaxy ID | Generates device-held key material and a local Galaxy ID. | Create an account, verify identity, or publish a profile. |
| Coding Case workspace | Stores local Case Drafts and attempted approaches. | Contact a Resolver or publish a Case. |
| Disclosure and consent controls | Stores previews, bounded Consent Grants, revocations, and Local Proof Drafts. | Transfer data, independently verify work, or create Evidence. |
| Galaxy MCP workspace | Exposes enabled local actions to the AI host over stdio. | Run a public network service. |
| AI-guided setup | Guides module choice and confirmation. | Override user confirmation. |

## Planned, not selectable

- OpenClaw adapter
- GitHub / CI verification adapter
- Remote sync

These names are roadmap markers. They are not enabled, configured, or implied by installing the pack.
