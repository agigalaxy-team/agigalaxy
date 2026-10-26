"""Public documents are generated from the core repository, never edited here."""
raise SystemExit(
    "Maintain docs/public in the core repository, then run: "
    "python tools/sync_public_docs.py --output <public-checkout> --dry-run "
    "(omit --dry-run to write locally). This public mirror cannot publish itself."
)
