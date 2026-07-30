"""Self-check for the v1/v2 schema switch.

Run from the project root:  python test_schema_versions.py

Guards the three things that would silently break the switch:
  1. v1 output is untouched — the home page must behave exactly as before.
  2. v2 output targets the new tables and never the removed ones.
  3. Version routing is safe — unknown / absent versions fall back to v1.
  4. The pull payload keys stay identical across versions, because the
     frontend rebuilds rows from a fixed key set (see branch.js
     unflattenBranchRow) and would drop anything new.
"""

import re

from services.common import (
    capture, normalize_version, parse_db_queries, script_module, split_notes,
)

# Tables the multi-tenant schema removed. If any of these appears in v2 output
# the generated migration will fail against the new database.
REMOVED_TABLES = (
    "branch_product_module",
    "tenant_product_feature",
    "branch_product_transaction_type",
)


def references(sql: str, table: str) -> bool:
    """True when `sql` names `table` as a whole identifier.

    A plain substring test would false-positive: the v2 table
    ``tenant_branch_product_transaction_type`` *contains* the removed
    ``branch_product_transaction_type``.
    """
    return re.search(rf"(?<![A-Za-z0-9_]){re.escape(table)}(?![A-Za-z0-9_])", sql) is not None

FEATURE_SOURCE = {
    "features": ["ALPHA", "BETA", "GAMMA"],
    "enabled_tenant_features": ["ALPHA", "BETA"],
    "disabled_tenant_features": ["GAMMA"],
    "enabled_product_features": ["ALPHA---Payments"],
    "disabled_product_features": ["BETA---Payments"],
}
FEATURE_DEST = {
    "features": ["ALPHA", "BETA", "GAMMA"],
    "enabled_tenant_features": ["GAMMA"],
    "disabled_tenant_features": [],
    "enabled_product_features": [],
    "disabled_product_features": ["ALPHA---Payments"],
}

WORKFLOW_ROWS = [
    {
        "branch": "BR1", "product_name": "Payments", "product": "PAY",
        "module": "MOD1", "transition_id": 10, "from_group": "MAKER",
        "to_groups": ["CHECKER"], "condition": {"amount": 100},
        "trigger": "SUBMIT", "priority": 1, "workflow_id": 5,
    },
    {
        # Tenant-wide workflow: no branch. v1 could not represent this; in v2
        # every scope column except tenant_id is nullable.
        "branch": None, "product_name": "Payments", "product": "PAY",
        "module": "MOD1", "transition_id": 11, "from_group": "CHECKER",
        "to_groups": ["DONE"], "condition": None, "trigger": "APPROVE",
        "priority": 2, "workflow_id": 6,
        "transaction_type": "INWARD", "trigger_code": "APPROVE",
        "action_label": "Approve", "reassign_to_previous_user": 1,
    },
]

BRANCH_ROWS = [{
    "product_configurations": {
        "product_id": 3, "name": "Payments", "code": "PAY",
        "description": "Payments product", "tag": "PAY_TAG",
        "created_by": "SYSTEM", "created_at": "2026-01-01", "sequence": 1,
        "parent_product_id": None, "is_inbound": 1, "product_module_sequence": 10,
        "product_tag_configurations": {
            "product_tag_id": 2, "name": "Payments", "code": "PAY_TAG", "sequence": 1,
        },
        "supported_file_formats": "csv",
        "tenant_product_is_active": 1, "tenant_product_default_on": 0,
        "tenant_product_display_name": "Payments",
        "tenant_branch_product_is_active": 1,
        "tenant_branch_product_display_name": None,
    },
    "module_missing_product_configurations": None,
    "module_configurations": {
        "module_id": 4, "name": "Recon", "description": "Recon module",
        "code": "MOD1", "dependent_modules": None,
        "tenant_module_dependent_modules": None,
        "tenant_module_display_name": "Recon",
        "tenant_module_binding_sequence": 30, "tenant_module_binding_is_active": 1,
    },
    "transaction_type_configuration": {
        "transaction_type_display_name": "Inward", "transaction_type_id": 7,
        "code": "INWARD", "name": "Inward", "description": "Inward txn",
        "transaction_type_master_sequence": 1,
        "product_transaction_type_sequence": 2,
        "created_by": "SYSTEM",
        "product_transaction_type_module_sequence": 2,
        "tenant_product_transaction_type_is_active": 1,
        "tenant_product_transaction_type_default_on": 1,
        "tenant_branch_product_transaction_type_is_active": 1,
    },
    "branch_configuration": {
        "name": "Branch One", "description": "First", "status": "Active",
        "created_by": "SYSTEM", "code": "BR1", "country_id": None,
    },
}]

BRANCH_DEST = {
    "product_codes": [], "module_codes": [], "transaction_type_configuration": [],
    "product_tag_codes": [], "branch_codes": [],
}


def feature_sql(version):
    module = script_module("feature_flag", version)
    flags = module.FeatureFlags("ACME")
    flags.SOURCE_QUERY_RESULT = FEATURE_SOURCE
    flags.EXISTING_CONFIG = FEATURE_DEST
    return capture(flags.read_features_backup)


def workflow_sql(version):
    module = script_module("workflow_sync", version)
    sync = module.WorkflowSync("ACME", ["BR1"])
    # Deep-ish copy: the generators mutate rows in place (json.dumps on
    # to_groups / condition), so v1 and v2 must each get their own.
    sync.SOURCE_QUERY_RESULT = [dict(r) for r in WORKFLOW_ROWS]
    return capture(sync.read_workflow_backup)


def branch_sql(version):
    module = script_module("branch_product_sync", version)
    sync = module.BranchProductSync("ACME")
    sync.SOURCE_QUERY_RESULT = [dict(r) for r in BRANCH_ROWS]
    sync.EXISTING_CONFIG = dict(BRANCH_DEST)
    return split_notes(capture(sync.read_branch_product_backup_csv))[0]


def pull_queries(module_name, version, *args):
    module = script_module(module_name, version)
    generator = (module.generate_source_destination_initial_data_query
                 if module_name == "branch_product_sync"
                 else module.generate_source_data_query)
    return parse_db_queries(capture(generator, *args))


def test_version_routing():
    assert normalize_version(None) == "v1"
    assert normalize_version("") == "v1"
    assert normalize_version("v3") == "v1", "unknown versions must fall back, not raise"
    assert normalize_version("V2") == "v2", "version match is case-insensitive"
    assert normalize_version("v2") == "v2"

    assert script_module("feature_flag", "v1").__name__ == "scripts.feature_flag"
    assert script_module("feature_flag", "v2").__name__ == "scripts.v2.feature_flag"
    # A bad cookie value must never reach importlib.
    try:
        script_module("../evil", "v1")
        raise AssertionError("script_module accepted an unknown module name")
    except ValueError:
        pass


def test_v1_untouched():
    """The default experience must still emit the legacy tables."""
    assert references(feature_sql("v1"), "tenant_feature")
    assert not references(feature_sql("v1"), "tenant_feature_config")
    assert references(feature_sql("v1"), "tenant_product_feature")

    assert references(workflow_sql("v1"), "branch_product_module")
    assert references(branch_sql("v1"), "branch_product_module")
    assert references(branch_sql("v1"), "branch_product_transaction_type")


def test_v2_feature_flags():
    sql = feature_sql("v2")
    assert references(sql, "tenant_feature_config")
    assert not references(sql, "tenant_product_feature")

    assert "DELETE tfc FROM tenant_feature_config" in sql

    # The whole point of the switch: v2 changes *where* rows are written, never
    # *which* rows. Both versions must reach the same diff decisions, so the
    # statement counts have to agree.
    v1 = feature_sql("v1")
    assert sql.count("INSERT INTO") == v1.count("INSERT INTO"), (
        f"v2 emitted {sql.count('INSERT INTO')} inserts, v1 emitted {v1.count('INSERT INTO')}")
    assert sql.count("DELETE") == v1.count("DELETE")
    # Tenant-scope rows pin every scope column to NULL.
    assert "SELECT t.tenant_id, f.feature_id, NULL, NULL, NULL, NULL, 1, 'SYSTEM'" in sql
    # Product-scope rows carry product_id and nothing else.
    assert "SELECT t.tenant_id, f.feature_id, NULL, p.product_id, NULL, NULL, 1, 'SYSTEM'" in sql
    # Guarded against the unique scope key, so a re-run is a no-op.
    assert "_module_or_zero = 0" in sql


def test_v2_workflow():
    sql = workflow_sql("v2")
    for table in REMOVED_TABLES:
        assert not references(sql, table), f"v2 workflow SQL still references {table}"

    assert "INSERT INTO workflow" in sql
    assert "INSERT INTO transition" in sql
    assert "DELETE w FROM workflow w" in sql
    # Scope is resolved on the workflow row itself, not through a link table.
    assert "existing_workflow._branch_or_zero" in sql
    # Row 2 has no branch, so its branch scope must collapse to 0 rather than
    # joining a branch that isn't there.
    assert "existing_workflow._branch_or_zero = 0" in sql
    # New transition columns are populated from codes, not raw ids.
    assert "trigger_id" in sql and "trigger_master" in sql
    assert "reassign_to_previous_user" in sql
    assert "action_label" in sql


def test_v2_workflow_bulk_delete():
    """One v1-style bulk DELETE covering every scope in the pull.

    v1 wiped the slate with a single ``branch IN (...) AND product IN (...) AND
    module IN (...)`` statement and re-inserted everything; v2 does the same so
    a scope the source dropped is actually removed. The v2 wrinkle is NULLable
    scope columns: ``code IN (...)`` never matches NULL, so the branch-less row
    here needs an explicit ``IS NULL`` arm or its stale workflow survives, the
    INSERT's NOT EXISTS no-ops, and its transitions duplicate.
    """
    sql = workflow_sql("v2")
    deletes = [s for s in sql.split(";") if s.strip().startswith("DELETE")]
    assert len(deletes) == 1, f"expected a single bulk DELETE, got {len(deletes)}"
    delete = deletes[0]

    # Set-based, not per-row: the codes collected across all rows.
    assert "b.code IN ('BR1')" in delete
    assert "p.code IN ('PAY')" in delete
    assert "m.code IN ('MOD1')" in delete
    assert "tt.code IN ('INWARD')" in delete

    # Row 2 has no branch, so branch also matches NULL. Nothing in WORKFLOW_ROWS
    # leaves product or module unset, so those must NOT get an IS NULL arm —
    # that would reach workflows outside the pulled scope.
    assert "w.branch_id IS NULL" in delete
    assert "w.product_id IS NULL" not in delete
    assert "w.module_id IS NULL" not in delete
    # Row 1 carries no transaction type, so that dimension does match NULL.
    assert "w.transaction_type_id IS NULL" in delete

    # LEFT JOIN, not inner — an inner join drops the NULL-scope rows outright.
    assert "LEFT JOIN branch b ON b.branch_id = w.branch_id" in delete
    # A branch is tenant-owned; the join must pin it to this tenant.
    assert "b.tenant_id = tr.tenant_id" in delete

    # Tenant-scoped — a missing tenant predicate would wipe other tenants.
    assert "tr.organization_code = 'ACME'" in delete


def test_v2_branch_product():
    sql = branch_sql("v2")
    for table in REMOVED_TABLES:
        assert not references(sql, table), f"v2 branch SQL still references {table}"

    for table in ("tenant_product", "tenant_branch_product",
                  "tenant_product_transaction_type",
                  "tenant_branch_product_transaction_type",
                  "tenant_module_binding", "product_transaction_type_module"):
        assert f"INSERT INTO {table}" in sql, f"v2 branch SQL never inserts into {table}"

    # tenant_branch_product must resolve through tenant_product, never a
    # product_module id.
    assert "tenant_product.id" in sql
    assert "existing_tenant_module_binding._product_or_zero" in sql
    # Modules are keyed on the unique `code`, not the non-unique `name`.
    assert "module.name =" not in sql


def test_module_missing_row_v2():
    """A product with no module must skip every module-dependent table."""
    row = dict(BRANCH_ROWS[0])
    row["module_missing_product_configurations"] = row["product_configurations"]
    row["module_configurations"] = None

    module = script_module("branch_product_sync", "v2")
    sync = module.BranchProductSync("ACME")
    sync.SOURCE_QUERY_RESULT = [row]
    sync.EXISTING_CONFIG = dict(BRANCH_DEST)
    sql = split_notes(capture(sync.read_branch_product_backup_csv))[0]

    assert "INSERT INTO tenant_module_binding" not in sql
    assert "INSERT INTO tenant_module " not in sql
    assert "INSERT INTO product_transaction_type_module" not in sql
    # The branch/product link itself is still required.
    assert "INSERT INTO tenant_branch_product" in sql


def test_pull_payload_keys_match():
    """v2 pull queries must ask for every key v1 did.

    The frontend rebuilds branch rows from a fixed key set and hardcodes the
    workflow table columns, so a missing key would break the UI.
    """
    v1_ff = pull_queries("feature_flag", "v1", "ACME")["source_query"]
    v2_ff = pull_queries("feature_flag", "v2", "ACME")["source_query"]
    for key in ("features", "enabled_tenant_features", "disabled_tenant_features",
                "enabled_product_features", "disabled_product_features"):
        assert f"'{key}'" in v1_ff and f"'{key}'" in v2_ff, key
    assert "tenant_feature_config" in v2_ff and "tenant_feature_config" not in v1_ff

    v1_wf = pull_queries("workflow_sync", "v1", "ACME", ["BR1"], ["PAY"])["source_query"]
    v2_wf = pull_queries("workflow_sync", "v2", "ACME", ["BR1"], ["PAY"])["source_query"]
    for key in ("branch", "product_name", "product", "module", "transition_id",
                "from_group", "to_groups", "condition", "trigger", "priority",
                "workflow_id"):
        assert f"'{key}'" in v1_wf and f"'{key}'" in v2_wf, key
    assert not references(v2_wf, "branch_product_module")

    v1_br = pull_queries("branch_product_sync", "v1", "ACME", ["BR1"], ["PAY"])
    v2_br = pull_queries("branch_product_sync", "v2", "ACME", ["BR1"], ["PAY"])
    # The five top-level keys unflattenBranchRow knows about.
    for key in ("product_configurations", "module_missing_product_configurations",
                "module_configurations", "transaction_type_configuration",
                "branch_configuration"):
        assert f"'{key}'" in v1_br["source_query"], key
        assert f"'{key}'" in v2_br["source_query"], key
    assert not references(v2_br["source_query"], "branch_product_module")
    assert references(v2_br["source_query"], "tenant_branch_product")
    # Destination query reads only tables that survived, so it is unchanged.
    assert v1_br["destination_query"] == v2_br["destination_query"]
    # Both sides must be present, or the UI shows only one pull box.
    assert v1_br["source_query"] and v1_br["destination_query"]
    assert v2_br["source_query"] and v2_br["destination_query"]


def test_capture_restores_stdout_on_error():
    """A raising generator must not leave stdout pointed at a dead buffer."""
    import sys

    def boom():
        raise RuntimeError("boom")

    try:
        capture(boom)
    except RuntimeError:
        pass
    assert sys.stdout is sys.__stdout__


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("\nAll schema-version checks passed.")
