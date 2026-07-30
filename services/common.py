"""Shared plumbing for the sync services: stdout capture, query parsing and
schema-version routing.

The generator scripts are CLI-shaped — they ``print`` their SQL rather than
returning it — so every service captures stdout and splits the labelled
sections back apart. That parser used to be copy-pasted into three services;
it lives here once now.

Schema versions
───────────────
``v1`` → ``scripts/<name>.py``      (legacy schema, the default)
``v2`` → ``scripts/v2/<name>.py``   (multi-tenant schema)

Both expose the same class and function names, so a service only has to pick
the module.
"""

import importlib
import io
import sys

V1 = "v1"
V2 = "v2"
VERSIONS = (V1, V2)
DEFAULT_VERSION = V1

# Set client-side by static/js/state/schema-version.js and read back on every
# request. A cookie rather than a request-body field so none of the existing
# fetch call sites had to change.
SCHEMA_VERSION_COOKIE = "schema_version"


def normalize_version(version) -> str:
    """Coerce arbitrary client input to a known version, defaulting to v1.

    The version arrives from a browser cookie, so it is untrusted — anything
    unrecognised falls back to the legacy schema rather than raising.
    """
    candidate = str(version or "").strip().lower()
    return candidate if candidate in VERSIONS else DEFAULT_VERSION


def script_module(name: str, version=DEFAULT_VERSION):
    """Import the v1 or v2 generator module for ``name``.

    ``name`` is a bare module name such as ``"workflow_sync"``; it is checked
    against the known set so a bad cookie can never reach importlib.
    """
    if name not in ("branch_product_sync", "workflow_sync", "feature_flag"):
        raise ValueError(f"Unknown generator module: {name!r}")
    package = "scripts" if normalize_version(version) == V1 else "scripts.v2"
    return importlib.import_module(f"{package}.{name}")


def capture(func, *args) -> str:
    """Run ``func`` and return whatever it printed to stdout."""
    buf = io.StringIO()
    sys.stdout = buf
    try:
        func(*args)
    finally:
        # Restored in a finally block so a raising generator cannot leave the
        # process with stdout pointed at a dead buffer.
        sys.stdout = sys.__stdout__
    return buf.getvalue()


_SECTION_LABELS = ("Source DB query:", "Destination DB query:")


def parse_db_queries(raw: str) -> dict:
    """Split captured stdout into its source and destination query blocks.

    Returns ``{"source_query": ..., "destination_query": ...}`` with an empty
    string for a section the generator did not emit (workflow pull, for
    instance, is source-only).
    """
    queries = {"source_query": "", "destination_query": ""}
    lines = raw.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        label = next((l for l in _SECTION_LABELS if line.startswith(l)), None)
        if label is None:
            index += 1
            continue
        block = line[len(label):].strip()
        index += 1
        while index < len(lines) and not lines[index].startswith(_SECTION_LABELS):
            block += "\n" + lines[index]
            index += 1
        key = "source_query" if label == _SECTION_LABELS[0] else "destination_query"
        queries[key] = block.strip()
    return queries


def split_notes(raw: str):
    """Separate ``Note:`` advisory lines from the generated SQL."""
    notes = [l for l in raw.splitlines() if l.strip().startswith("Note:")]
    sql = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("Note:")).strip()
    return sql, notes
