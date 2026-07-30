"""Self-check for the Full Tenant Export feature (v2).

Run from the project root:  python test_tenant_export.py

The contract this guards
────────────────────────
  1. No primary keys leave the source — every reference is a natural key.
  2. DELETE is emitted for workflow and transition, and for nothing else.
  3. The global catalogue is insert-only; it is shared with other tenants.
  4. Environment-specific tables cannot produce SQL without confirmation.
  5. Rows that already match produce no statement at all.
  6. tenant_id is written exactly where the table's linkage requires it.
"""

import re

from scripts.v2 import tenant_registry as registry
from scripts.v2.tenant_export_query import build_destination_query, build_export_query
from scripts.v2.tenant_upsert import TenantUpsert

TENANT = "ACME"

SOURCE = {
    "tenant": [{"organization_code": "ACME", "tenant_name": "Acme", "sub_domain": "acme",
                "default_currency": "USD", "description": None, "status": "Active",
                "logo": None, "country": "IN", "created_by": "SYSTEM"}],
    "countries": [{"country_code": "IN", "country_name": "India", "status": "Active"}],
    "product_tag": [{"code": "PAY_TAG", "name": "Payments", "sequence": 1}],
    "product": [{"code": "PAY", "name": "Payments", "description": None, "tag": "PAY",
                 "sequence": 1, "is_inbound": 1, "supported_file_formats": "csv",
                 "product_tag": "PAY_TAG"}],
    "module": [{"code": "MOD1", "name": "Recon", "description": None,
                "dependent_modules": None}],
    "feature": [{"name": "ALPHA", "description": None, "feature_group": "core",
                 "module": "MOD1"}],
    "branch": [{"code": "BR1", "name": "Mumbai", "description": None, "status": "Active",
                "country": "IN", "created_by": "SYSTEM"}],
    "tenant_product": [{"product": "PAY", "is_active": 1, "display_name": "Payments",
                        "default_on": 1, "created_by": "SYSTEM"}],
    "tenant_branch_product": [{"product": "PAY", "branch": "BR1", "is_active": 1,
                               "display_name": None, "created_by": "SYSTEM"}],
    "tenant_feature_config": [
        {"feature": "ALPHA", "branch": None, "product": None, "transaction_type": None,
         "module": None, "is_enabled": 1, "created_by": "SYSTEM"}],
    "workflow": [{"module": "MOD1", "branch": "BR1", "product": "PAY",
                  "transaction_type": None, "workflow_name": "MAKER--CHECKER",
                  "is_active": 1}],
    "transition": [{"module": "MOD1", "branch": "BR1", "product": "PAY",
                    "transaction_type": None, "from_group": "MAKER", "priority": 1,
                    "to_groups": ["CHECKER"], "condition": None, "trigger": "SUBMIT",
                    "trigger_code": "SUBMIT", "action_label": "Submit", "is_disabled": 0,
                    "change_reason": None, "reassign_to_previous_user": 0}],
    "trigger_master": [{"code": "SUBMIT", "display_name": "Submit", "category": "manual",
                        "description": None, "is_active": 1}],
}

ENV_ROW = {
    "tenant_db_config": [{"module": "core", "db_type": "mysql", "db_driver": "pymysql",
                          "db_name": "acme", "pool_size": 5, "max_overflow": 10,
                          "pool_timeout": 30, "db_host": "src-db", "db_username": "u",
                          "db_password": "p", "db_port": 3306}],
}


def build(source=None, destination=None, selected=None, confirmed=()):
    source = SOURCE if source is None else source
    upsert = TenantUpsert(TENANT, source, destination or {},
                          selected=selected if selected is not None else set(source),
                          confirmed=confirmed)
    return upsert


def statements(sql):
    """Split a generated script into statements, dropping comment headers."""
    body = "\n".join(l for l in sql.splitlines() if not l.startswith("-- ──"))
    return [s.strip() for s in body.split(";") if s.strip()]


def test_registry_is_consistent():
    """check() runs at import; assert it stays clean and covers every table."""
    assert registry.check() == []
    assert len(registry.EMIT_ORDER) == len(registry.TABLES)
    assert set(registry.EMIT_ORDER) == set(registry.BY_NAME)


def test_export_exposes_no_primary_keys():
    """Surrogate ids differ per environment, so none may be exported."""
    query = build_export_query(TENANT)
    for spec in registry.TABLES:
        for field in registry.fields(spec):
            assert not re.fullmatch(r"(\w+_)?id", field), \
                f"{spec['table']} exports raw id field {field!r}"

    # The projection must never select a bare *_id column off the row alias.
    selected_ids = re.findall(r"'(\w*_?id)', row_data\.", query)
    assert not selected_ids, f"export selects primary/foreign ids directly: {selected_ids}"

    # Every table appears in both queries.
    destination = build_destination_query(TENANT)
    for table in registry.BY_NAME:
        assert f"'{table}'" in query, f"{table} missing from export query"
        assert f"'{table}'" in destination, f"{table} missing from destination query"


def test_export_is_tenant_scoped():
    query = build_export_query(TENANT)
    assert query.count("t.organization_code = 'ACME'") == 1
    # Tenant-scoped tables must be filtered; a missing predicate would export
    # every tenant's rows.
    for spec in registry.TABLES:
        if spec["tenant"] == registry.TENANT_COLUMN:
            block = query.split(f"'{spec['table']}', (SELECT")[1].split("),\n")[0]
            assert "tenant_id = t.tenant_id" in block, \
                f"{spec['table']} subquery is not tenant-scoped"


def test_delete_only_for_workflow_and_transition():
    sql = build().generate()
    for statement in statements(sql):
        if not statement.upper().startswith("DELETE"):
            continue
        assert re.match(r"DELETE (wf FROM workflow|tr FROM transition)", statement), \
            f"DELETE against a table other than workflow/transition:\n{statement}"

    # And the two that are allowed do appear.
    assert "DELETE wf FROM workflow" in sql
    assert "DELETE tr FROM transition" in sql


def test_workflow_delete_is_one_bulk_statement():
    """One set-based DELETE per replace table, v1's wipe-then-reinsert shape.

    Multi-scope source so the code sets have something to collect. The second
    workflow is tenant-wide (no branch) and carries a transaction type the first
    one lacks, which is what forces the IS NULL arms: `code IN (...)` never
    matches NULL, so without them a stale workflow survives the wipe, the
    INSERT's NOT EXISTS no-ops, and its transitions duplicate onto the old row.
    """
    source = dict(SOURCE)
    source["workflow"] = SOURCE["workflow"] + [
        {"module": "MOD2", "branch": None, "product": "PAY2",
         "transaction_type": "INWARD", "workflow_name": "CHECKER--DONE", "is_active": 1},
    ]
    sql = build(source=source).generate()
    deletes = [s for s in statements(sql) if s.startswith("DELETE")]
    assert len(deletes) == 2, f"expected one DELETE per replace table, got {len(deletes)}"

    workflow_delete = next(d for d in deletes if d.startswith("DELETE wf"))
    # Set-based over every code the export carries, not one statement per row.
    assert "ref_module.code IN ('MOD1', 'MOD2')" in workflow_delete
    assert "ref_product.code IN ('PAY', 'PAY2')" in workflow_delete
    assert "ref_branch.code IN ('BR1')" in workflow_delete
    assert "ref_txn.code IN ('INWARD')" in workflow_delete

    # Dimensions the source leaves unset on some row also match NULL; the ones
    # it always fills must not, or the wipe reaches outside the pulled scope.
    assert "wf.branch_id IS NULL" in workflow_delete
    assert "wf.transaction_type_id IS NULL" in workflow_delete
    assert "wf.module_id IS NULL" not in workflow_delete
    assert "wf.product_id IS NULL" not in workflow_delete

    # LEFT JOIN, not inner — an inner join drops the NULL-scope rows outright.
    assert "LEFT JOIN branch ref_branch" in workflow_delete
    # Tenant-scoped, and the tenant-owned branch lookup pinned to that tenant.
    assert "wf.tenant_id = t.tenant_id" in workflow_delete
    assert "ref_branch.tenant_id = t.tenant_id" in workflow_delete


def test_no_delete_when_workflow_not_selected():
    """Deselecting the workflow tables removes every DELETE from the script."""
    selected = set(SOURCE) - {"workflow", "transition"}
    sql = build(selected=selected).generate()
    assert "DELETE" not in sql


def test_catalogue_is_insert_only():
    """A differing catalogue row is reported, never rewritten."""
    source = {"module": [{"code": "MOD1", "name": "New", "description": None,
                          "dependent_modules": None}]}
    destination = {"module": [{"code": "MOD1", "name": "Old", "description": None,
                               "dependent_modules": None}]}
    upsert = build(source, destination, selected={"module"})
    sql = upsert.generate()
    assert sql == "", "catalogue difference must not emit SQL"
    assert any("shared" in n for n in upsert.notes)
    assert upsert.stats["module"]["reported"] == 1

    # No UPDATE is ever generated for an insert_only table.
    for spec in registry.TABLES:
        if registry.mode(spec) == "insert_only":
            assert spec["tenant"] is registry.TENANT_GLOBAL, \
                f"{spec['table']} is insert_only but tenant-scoped — check intent"


def test_env_tables_require_confirmation():
    source = dict(SOURCE, **ENV_ROW)

    blocked = build(source, selected={"tenant_db_config"})
    problems = blocked.validate()
    assert problems and "confirmed" in problems[0]

    ok = build(source, selected={"tenant_db_config"}, confirmed={"tenant_db_config"})
    assert ok.validate() == []
    assert "INSERT INTO tenant_db_config" in ok.generate()


def test_env_required_fields_must_be_filled():
    incomplete = {"tenant_db_config": [dict(ENV_ROW["tenant_db_config"][0], db_host="")]}
    upsert = build(incomplete, selected={"tenant_db_config"},
                   confirmed={"tenant_db_config"})
    problems = upsert.validate()
    assert any("db_host" in p for p in problems), problems


def test_unchanged_rows_emit_nothing():
    """Source identical to destination produces an empty script."""
    upsert = build(SOURCE, SOURCE, selected=set(SOURCE) - {"workflow", "transition"})
    assert upsert.generate() == ""
    assert all(s["insert"] == 0 and s["update"] == 0 for s in upsert.stats.values())


def test_update_touches_only_changed_columns():
    destination = {"tenant": [dict(SOURCE["tenant"][0], tenant_name="Old Name",
                                   description="also different")]}
    upsert = build(SOURCE, destination, selected={"tenant"})
    sql = upsert.generate()
    assert sql.count("UPDATE tenant") == 1
    assert "tenant_name = 'Acme'" in sql
    # description differs too, so it must be in the SET; status matches, so it must not.
    assert "x.description" in sql
    assert "x.`status`" not in sql, "unchanged column appeared in SET"


def test_tenant_id_written_per_linkage():
    """tenant_id belongs on tables that carry it, and nowhere else."""
    sql = build().generate()
    for block in sql.split("-- ── ")[1:]:
        table = block.split("(")[1].split(")")[0]
        inserts = [s for s in statements(block) if s.startswith("INSERT INTO")]
        if not inserts:
            continue
        column_list = inserts[0].split("SELECT")[0]
        expected = registry.spec(table)["tenant"] == registry.TENANT_COLUMN
        assert ("tenant_id" in column_list) == expected, \
            f"{table}: tenant_id presence {not expected} — linkage is " \
            f"{registry.spec(table)['tenant']!r}"


def test_transition_hangs_off_its_workflow():
    """transition rows carry workflow scope, which is not columns of their own."""
    sql = build().generate()
    block = sql[sql.index("-- ── Transitions"):]
    insert = [s for s in statements(block) if s.startswith("INSERT INTO transition")][0]
    columns = insert.split("SELECT")[0]

    assert "workflow_id" in columns
    assert "wf.workflow_id" in insert
    # The scope fields must not be written as transition columns.
    for scope in ("`module`", "branch,", "product,", "transaction_type"):
        assert scope not in columns, f"scope field {scope} leaked into transition columns"
    # trigger_id resolves by code so a missing trigger lands as NULL, not a lost row.
    assert "SELECT trigger_id FROM trigger_master WHERE code = 'SUBMIT'" in insert


def test_unresolvable_reference_is_reported():
    """A natural key absent from the destination and not being inserted is a note."""
    source = {
        "tenant_feature_config": [
            {"feature": "GHOST", "branch": None, "product": None,
             "transaction_type": None, "module": None, "is_enabled": 1,
             "created_by": "SYSTEM"}],
    }
    upsert = build(source, {}, selected={"tenant_feature_config"})
    upsert.generate()
    assert any("GHOST" in n and "0 rows" in n for n in upsert.notes), upsert.notes


def test_destination_only_workflow_is_reported_not_deleted():
    destination = {"workflow": [{"module": "MOD2", "branch": "BR1", "product": "PAY",
                                 "transaction_type": None, "workflow_name": "ORPHAN",
                                 "is_active": 1}]}
    upsert = build(SOURCE, destination, selected={"workflow"})
    sql = upsert.generate()
    assert any("ORPHAN" in n and "left in place" in n for n in upsert.notes), upsert.notes
    # The orphan's own scope must not be deleted — only the scopes being re-inserted.
    assert "MOD2" not in sql


def test_selection_is_honoured():
    """An unticked table contributes nothing."""
    upsert = build(selected={"branch"})
    sql = upsert.generate()
    assert "INSERT INTO branch" in sql
    for table in ("tenant_product", "workflow", "tenant_feature_config"):
        assert f"INTO {table}" not in sql


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("\nAll tenant-export checks passed.")
