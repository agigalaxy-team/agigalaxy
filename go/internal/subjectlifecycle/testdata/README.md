# Isolated lifecycle compatibility fixtures

These fixtures were captured once from the superseded Node lifecycle implementation on 2026-10-29, using synthetic identities and a disposable PostgreSQL cluster. `synthetic-execution.json` holds the public scenario inputs; `synthetic-execution-data.json` holds its 19 nonempty tables, including public signature evidence and synthetic credential hashes. It contains no private-key PEM or bearer credential.

The `original-*.json` files contain the original implementation's inventory or result projections. The tests replace only newly generated command/recovery identifiers and their derived hashes where necessary, and compare the remaining fields with current Go results. The capture metadata is checked against the newly captured payload and its independently computed SHA-256 digest.

`loadSyntheticExecution` applies the current Go schema and restricted roles to a new test cluster, restores only these synthetic rows with triggers temporarily disabled inside that transaction, and re-enables normal behavior on commit. Actual review, execution, retention, minimization, ledger verification and recovery calls run through their current Go authorities; no production database or service is used.
