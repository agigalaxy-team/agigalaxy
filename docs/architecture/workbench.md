# Workbench UI domain

The Payload server entry remains `components/Welcome.tsx`. Its current management check and initial summary read are unchanged. `BusinessViewClients` loads the existing implementation from `components/workbench/OperationsDashboard.tsx` with the same SSR setting.

## Ownership and shared contracts

The dashboard, communication, reply rendering, action cards, authorized preparation, log, sidebar and chart implementations live together with their two stylesheets. This change moves existing files and adjusts module specifiers only. It does not add a second conversation state, draft store, navigation guard, polling protocol or model client. Shared DTOs, read and command hooks, chart surfaces, account pickers and common controls remain in their existing locations.

Source qualification, current human and AI permissions, original-operation recovery and human confirmation remain in the original code. Collapsing the communication panel does not remove its existing state. The charts retain their existing lazy plot import. Directory organization alone is not a first-load performance improvement claim.

## AI-agent deployment and verification

Use the selected frozen deployment candidate and its CAPTURE manifest, not the entire working tree. The move requires a coherent admin build containing the updated dynamic entry and server type import; API, Native, gateway, models, database and service connections do not change for this directory move. Retain old immutable browser assets during activation.

Check the real Linux Next/TypeScript build once with the related selected changes. Then inspect only the affected workbench entry, chart, and communication expansion/draft preservation in an independent headless session. Do not send a new model turn to test imports, copy credentials, or rerun previously completed business mutations. Restore old bytes and consumer imports together if rollback is needed.
