"""Only closed, explicit metadata reaches container stdout."""
import json
import logging
import os
import sys


class DiscardLibraryOutput:
    encoding = "utf-8"
    errors = "replace"
    def write(self, text): return len(text)
    def flush(self): pass
    def isatty(self): return False
    def fileno(self): return 2


def restrict_library_output():
    # Native providers can log free-text exceptions even with message redaction.
    # Keep them out of general operations logs; our emitter does not use logging.
    logging.disable(logging.CRITICAL)
    sys.stdout, sys.stderr = DiscardLibraryOutput(), DiscardLibraryOutput()


def emit(row):
    os.write(1, (json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n").encode())
