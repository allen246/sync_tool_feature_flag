"""Full-tenant export service (v2 schema only).

Unlike the older services this one does not capture stdout: the v2 tenant
modules return their SQL, so there is nothing to intercept.

Flow
────
1. ``generate_pull_sql``  → the two queries the operator runs by hand.
2. ``table_metadata``     → the table list the UI renders for select / preview.
3. ``generate_final``     → validation, then the migration script.

Step 3 refuses to emit anything while validation is failing. That is the whole
point of the environment-specific gate: credentials and per-environment
endpoints must be explicitly confirmed and complete first.
"""

import json
import logging

from scripts.v2 import tenant_registry as registry
from scripts.v2.tenant_export_query import build_destination_query, build_export_query
from scripts.v2.tenant_upsert import TenantUpsert

log = logging.getLogger(__name__)


def generate_pull_sql(tenant_code: str) -> dict:
    """The source export query and the destination compare query."""
    tenant_code = (tenant_code or "").strip()
    log.info("Building tenant export queries for %s", tenant_code)
    return {
        "source_query": build_export_query(tenant_code),
        "destination_query": build_destination_query(tenant_code),
    }


def table_metadata() -> dict:
    """Table list, grouped, for the selection checklist and preview."""
    tables = registry.ui_metadata()
    groups = []
    for table in tables:
        if not groups or groups[-1]["group"] != table["group"]:
            groups.append({"group": table["group"], "tables": []})
        groups[-1]["tables"].append(table)
    return {
        "tables": tables,
        "groups": groups,
        "env_tables": registry.env_tables(),
        "deletable": sorted(registry.DELETABLE),
    }


def generate_final(tenant_code: str, source_json: str, destination_json: str,
                   tables=None, confirmed=()) -> dict:
    """Validate, then build the migration script.

    Returns ``{result, notes, stats, errors}``. A non-empty ``errors`` means
    nothing was generated — the caller should surface them and stop.
    """
    tenant_code = (tenant_code or "").strip()
    source = _load(source_json, "source")
    destination = _load(destination_json, "destination")

    selected = _selected_tables(tables)
    upsert = TenantUpsert(tenant_code, source, destination,
                          selected=selected, confirmed=set(confirmed or ()))

    errors = upsert.validate()
    if errors:
        log.info("Tenant export blocked by %d validation error(s)", len(errors))
        return {"result": "", "notes": [], "stats": {}, "errors": errors}

    sql = upsert.generate()
    log.info("Tenant export generated %d chars for %s", len(sql), tenant_code)
    return {
        "result": sql,
        "notes": upsert.notes,
        "stats": upsert.stats,
        "errors": [],
    }


def _selected_tables(tables):
    """Which tables the user ticked.

    ``None`` means "not specified" and selects everything, so the endpoint stays
    usable without the picker. Unknown names are dropped rather than raising —
    the list arrives from the browser.
    """
    if tables is None:
        return set(registry.BY_NAME)
    return {t for t in tables if t in registry.BY_NAME}


def _load(raw, label):
    """Parse a pasted query result, tolerating an empty destination.

    A blank destination is legitimate and common: it means the tenant does not
    exist there yet, so every row is an insert.
    """
    if raw is None or not str(raw).strip():
        return {}
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Could not parse the {label} export as JSON: {exc}") from exc
