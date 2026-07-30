"""Read side: builds the tenant export query and the destination compare query.

Both queries have the *same shape* — one JSON object keyed by table name, each
holding an array of rows with natural keys instead of primary keys. Running the
same shape on both databases makes the diff symmetric, so the comparison logic
in tenant_upsert.py never has to care which side a row came from.

    {
      "tenant":               [{"organization_code": "ACME", ...}],
      "branch":               [{"code": "BR1", "country": "IN", ...}],
      "tenant_feature_config":[{"feature": "ALPHA", "branch": "BR1", ...}],
      ...
    }

The destination query is scoped to the same organization_code. When the tenant
does not exist there yet every array comes back empty, and the whole export
becomes inserts.
"""

from scripts.v2 import tenant_registry as registry
from scripts.v2.sql_util import escape, quote_identifier

ROW_ALIAS = "row_data"
TENANT_ALIAS = "t"


def build_export_query(tenant_code: str) -> str:
    """The single query to run on the source database."""
    return _build(tenant_code, registry.TABLES)


def build_destination_query(tenant_code: str) -> str:
    """The query to run on the destination database.

    Identical shape to the export. Catalogue tables are *not* narrowed to the
    tenant here: we need to know whether a catalogue row exists at all on the
    destination, regardless of who references it.
    """
    return _build(tenant_code, registry.TABLES, destination=True)


def _build(tenant_code: str, table_specs, destination: bool = False) -> str:
    sections = [
        "    {key}, {subquery}".format(
            key=escape(spec["table"]),
            subquery=_table_subquery(spec, destination=destination))
        for spec in table_specs
    ]
    return (
        "SELECT JSON_OBJECT(\n"
        + ",\n".join(sections)
        + "\n) AS result\n"
        + f"FROM tenant {TENANT_ALIAS}\n"
        + f"WHERE {TENANT_ALIAS}.organization_code = {escape(tenant_code)};"
    )


def _table_subquery(spec, destination: bool) -> str:
    """One correlated subquery producing a JSON array of rows for a table."""
    alias = ROW_ALIAS
    selects, joins = _row_projection(spec, alias)
    where = _tenant_predicate(spec, alias, destination=destination)

    body = [
        f"FROM {spec['table']} {alias}",
        *joins,
    ]
    if where:
        body.append(f"WHERE {where}")

    projection = ",\n            ".join(f"{escape(name)}, {expr}" for name, expr in selects)
    return (
        "(SELECT JSON_ARRAYAGG(JSON_OBJECT(\n"
        f"            {projection}\n"
        "        ))\n        "
        + "\n        ".join(body)
        + ")"
    )


def _row_projection(spec, alias):
    """Return ([(field, sql_expression)], [join, ...]) for one table.

    Fields resolved from a foreign key come from the ref's natural key; every
    other field reads straight off the row.
    """
    if spec["table"] == "transition":
        return _transition_projection(spec, alias)

    joins = []
    ref_fields = {}
    for ref_name in spec["refs"].values():
        ref = registry.REFS[ref_name]
        joins.append(ref["export_join"].format(a=ref["alias"], src=alias))
        for field, expression in ref["export"].items():
            ref_fields[field] = expression.format(a=ref["alias"])

    selects = [
        (field, ref_fields.get(field) or f"{alias}.{quote_identifier(field)}")
        for field in registry.fields(spec)
    ]
    return selects, joins


def _transition_projection(spec, alias):
    """Flat projection for `transition`, joined up to its workflow's scope.

    Transitions are exported flat rather than nested under their workflow, so
    each row stands alone in the table preview and can be edited like any
    other row. The workflow's scope columns are repeated on every transition.
    """
    joins = [
        f"JOIN workflow wf ON wf.workflow_id = {alias}.workflow_id",
        "LEFT JOIN module ref_module ON ref_module.module_id = wf.module_id",
        "LEFT JOIN branch ref_branch ON ref_branch.branch_id = wf.branch_id",
        "LEFT JOIN product ref_product ON ref_product.product_id = wf.product_id",
        "LEFT JOIN transaction_type_master ref_txn "
        "ON ref_txn.transaction_type_id = wf.transaction_type_id",
        f"LEFT JOIN trigger_master ref_trigger ON ref_trigger.trigger_id = {alias}.trigger_id",
    ]
    workflow_scope = {
        "module": "ref_module.code",
        "branch": "ref_branch.code",
        "product": "ref_product.code",
        "transaction_type": "ref_txn.code",
        "trigger_code": "ref_trigger.code",
    }
    selects = [
        (field, workflow_scope.get(field) or f"{alias}.{quote_identifier(field)}")
        for field in registry.fields(spec)
    ]
    return selects, joins


def _tenant_predicate(spec, alias, destination: bool) -> str:
    """Restrict a table's rows to the tenant being exported.

    Catalogue tables have no tenant column. On the source they are narrowed to
    the rows this tenant actually references, keeping the payload small; on the
    destination they are read in full, because the question there is only
    "does this row already exist".
    """
    linkage = spec["tenant"]

    if linkage == "self":
        return f"{alias}.tenant_id = {TENANT_ALIAS}.tenant_id"
    if linkage == registry.TENANT_COLUMN:
        return f"{alias}.tenant_id = {TENANT_ALIAS}.tenant_id"
    if linkage == "workflow":
        return f"wf.tenant_id = {TENANT_ALIAS}.tenant_id"
    if linkage == registry.TENANT_VIA_REF:
        return _via_ref_predicate(spec, alias)
    if linkage is registry.TENANT_GLOBAL:
        return "" if destination else CATALOGUE_USAGE.get(spec["table"], "")
    raise ValueError(f"Unknown tenant linkage {linkage!r} on {spec['table']}")


def _via_ref_predicate(spec, alias) -> str:
    """Tenant predicate for tables reached through a composite ref.

    tenant_branch_product hangs off tenant_product, which carries tenant_id;
    the ref's export join already brought that row in, so pin it here.
    """
    for ref_name in spec["refs"].values():
        ref = registry.REFS[ref_name]
        if ref_name == "tenant_product":
            return f"{ref['alias']}.tenant_id = {TENANT_ALIAS}.tenant_id"
        if ref_name == "tenant_product_transaction_type":
            return f"ref_tptt_tp.tenant_id = {TENANT_ALIAS}.tenant_id"
    raise ValueError(f"{spec['table']} declares TENANT_VIA_REF but has no tenant-bearing ref")


# Narrows each catalogue table on the *source* to only the rows this tenant
# uses, so the exported JSON stays a reviewable size instead of dragging in the
# entire global catalogue.
CATALOGUE_USAGE = {
    "product": (
        "EXISTS (SELECT 1 FROM tenant_product tp "
        "WHERE tp.product_id = row_data.product_id AND tp.tenant_id = t.tenant_id)"
    ),
    "product_tag": (
        "EXISTS (SELECT 1 FROM product p JOIN tenant_product tp "
        "ON tp.product_id = p.product_id AND tp.tenant_id = t.tenant_id "
        "WHERE p.product_tag_id = row_data.product_tag_id)"
    ),
    "module": (
        "EXISTS (SELECT 1 FROM tenant_module tm "
        "WHERE tm.module_id = row_data.module_id AND tm.tenant_id = t.tenant_id)"
    ),
    "feature": (
        "EXISTS (SELECT 1 FROM tenant_feature_config tfc "
        "WHERE tfc.feature_id = row_data.feature_id AND tfc.tenant_id = t.tenant_id)"
    ),
    "transaction_type_master": (
        "EXISTS (SELECT 1 FROM tenant_module_binding tmb "
        "WHERE tmb.transaction_type_id = row_data.transaction_type_id "
        "AND tmb.tenant_id = t.tenant_id) "
        "OR EXISTS (SELECT 1 FROM tenant_product_transaction_type tptt "
        "JOIN tenant_product tp ON tp.id = tptt.tenant_product_id AND tp.tenant_id = t.tenant_id "
        "JOIN product_transaction_type ptt "
        "ON ptt.product_transaction_type_id = tptt.product_transaction_type_id "
        "WHERE ptt.transaction_type_id = row_data.transaction_type_id)"
    ),
    "product_module": (
        "EXISTS (SELECT 1 FROM tenant_product tp "
        "WHERE tp.product_id = row_data.product_id AND tp.tenant_id = t.tenant_id)"
    ),
    "product_transaction_type": (
        "EXISTS (SELECT 1 FROM tenant_product_transaction_type tptt "
        "JOIN tenant_product tp ON tp.id = tptt.tenant_product_id AND tp.tenant_id = t.tenant_id "
        "WHERE tptt.product_transaction_type_id = row_data.product_transaction_type_id)"
    ),
    "product_transaction_type_module": (
        "EXISTS (SELECT 1 FROM tenant_product_transaction_type tptt "
        "JOIN tenant_product tp ON tp.id = tptt.tenant_product_id AND tp.tenant_id = t.tenant_id "
        "WHERE tptt.product_transaction_type_id = row_data.product_transaction_type_id)"
    ),
    "trigger_master": (
        "EXISTS (SELECT 1 FROM transition tr JOIN workflow w "
        "ON w.workflow_id = tr.workflow_id AND w.tenant_id = t.tenant_id "
        "WHERE tr.trigger_id = row_data.trigger_id)"
    ),
    "countries": (
        "row_data.country_id = t.country_id "
        "OR EXISTS (SELECT 1 FROM branch b "
        "WHERE b.country_id = row_data.country_id AND b.tenant_id = t.tenant_id)"
    ),
    "currencies": (
        "row_data.currency_code = t.default_currency "
        "OR EXISTS (SELECT 1 FROM holidays h "
        "WHERE h.currency_id = row_data.currency_id AND h.tenant_id = t.tenant_id)"
    ),
    "master_list": (
        "EXISTS (SELECT 1 FROM tenant_master_list tml "
        "WHERE tml.master_list_id = row_data.master_list_id AND tml.tenant_id = t.tenant_id)"
    ),
    "email_template": (
        "EXISTS (SELECT 1 FROM tenant_email_template tet "
        "WHERE tet.email_template_id = row_data.template_id AND tet.tenant_id = t.tenant_id)"
    ),
    "report_master": (
        "EXISTS (SELECT 1 FROM tenant_reports trp "
        "WHERE trp.report_type_id = row_data.id AND trp.tenant_id = t.tenant_id)"
    ),
    "project_type": (
        "EXISTS (SELECT 1 FROM minio_config mc "
        "WHERE mc.project_type_id = row_data.project_type_id AND mc.tenant_id = t.tenant_id)"
    ),
}
