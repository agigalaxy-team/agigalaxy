# Feedback module

The existing Payload server entry stays at `components/FeedbackView.tsx`. Its client editor, attachment viewer and both domain styles live under `components/feedback/`. The shared feedback DTO remains at its public root path; common controls, current-reader hooks, command receipts and draft memory remain shared. This directory move does not change function bodies, source qualification, network requests, styles or the existing list/detail layout.

The business service is already split under `packages/galaxy-official/src/operations/feedback/`. Intake is collection, classification and processing status; it is not a user/operator two-way support system. Selected AI feedback material uses the separate feedback-processing purpose. It does not create discovery/profile events or grant permission.

## AI-agent deployment and maintenance

Select the integration owner's frozen source and normal Linux management build. Keep the existing dynamic client boundary, server session checks and original-operation handling. Verify only the affected current feedback entry after a location-only move, without submitting the same feedback or replaying a completed operation.

Read credentials through the existing protected runtime references; do not export secrets, cookies or feedback bodies in reports. Current person/AI permissions and current source revisions remain authoritative. An unreadable post-commit result is unknown until the exact original operation is recovered; never create a replacement operation merely to obtain a success message.
