"""Declarative description of the tenant configuration surface (v2 schema).

One registry drives four things, so they can never drift apart:

  * the source export query          (SELECT ... JSON_OBJECT per table)
  * the destination compare query    (same shape, so the diff is symmetric)
  * the INSERT / UPDATE generation
  * the table list and column headers the UI renders for preview / edit

No primary keys are ever exported. Every foreign key is resolved to the
referenced row's *natural* key (a code or name), because surrogate ids differ
between environments. On the way back in, each natural key is resolved to an id
with a JOIN.

Table spec fields
─────────────────
  table     SQL table name; also the key in the exported JSON.
  label     Human label for the UI.
  group     UI grouping.
  tenant    How the row reaches the tenant:
              "column"  → the table has its own tenant_id
              a TenantVia → reached through tenant_product etc.
              None      → global catalogue row, not tenant-scoped
  refs      {fk_column: ref_name} — resolved via REFS.
  key       Exported field names that identify the row. Used to decide
            INSERT vs UPDATE, and as the UPDATE's WHERE clause.
  columns   Payload fields carried across.
  mode      "upsert"      insert when missing, update when different (default)
            "insert_only" never updated — used for the global catalogue, where
                          an UPDATE would change behaviour for other tenants
            "replace"     deleted and re-inserted (workflow / transition only)
  env       True when the table holds environment-specific values or secrets.
            These require explicit confirmation before SQL is generated.
  required  Fields that must be non-empty when an `env` table is selected.
  note      Advisory emitted whenever the table produces statements.
"""


# ── Reference resolvers ──────────────────────────────────────────────────── #
#
# Each ref describes one foreign key in both directions:
#
#   fields       exported JSON field names this ref contributes
#   column       the FK column on the owning table
#   export_join  join the export query uses to read the natural key
#   export       {field: SELECT expression} producing the natural key
#   insert_join  join used when writing, resolving natural key back to an id
#   id           expression yielding the id to store
#   nullable     when True a NULL natural key is legal and stays NULL
#
REFS = {
    "branch": {
        "fields": ["branch"], "column": "branch_id", "alias": "ref_branch",
        "export_join": "LEFT JOIN branch {a} ON {a}.branch_id = {src}.branch_id",
        "export": {"branch": "{a}.code"},
        # Branches are tenant-owned, so the lookup must be pinned to the tenant
        # or a same-coded branch from another tenant could be picked up.
        "insert_join": "JOIN branch {a} ON {a}.code = {branch} AND {a}.tenant_id = t.tenant_id",
        "id": "{a}.branch_id", "nullable": True,
        "target": ("branch", ["code"]),
    },
    "product": {
        "fields": ["product"], "column": "product_id", "alias": "ref_product",
        "export_join": "LEFT JOIN product {a} ON {a}.product_id = {src}.product_id",
        "export": {"product": "{a}.code"},
        "insert_join": "JOIN product {a} ON {a}.code = {product}",
        "id": "{a}.product_id", "nullable": True,
        "target": ("product", ["code"]),
    },
    "module": {
        "fields": ["module"], "column": "module_id", "alias": "ref_module",
        "export_join": "LEFT JOIN module {a} ON {a}.module_id = {src}.module_id",
        "export": {"module": "{a}.code"},
        "insert_join": "JOIN module {a} ON {a}.code = {module}",
        "id": "{a}.module_id", "nullable": True,
        "target": ("module", ["code"]),
    },
    "transaction_type": {
        "fields": ["transaction_type"], "column": "transaction_type_id", "alias": "ref_txn",
        "export_join": ("LEFT JOIN transaction_type_master {a} "
                        "ON {a}.transaction_type_id = {src}.transaction_type_id"),
        "export": {"transaction_type": "{a}.code"},
        "insert_join": "JOIN transaction_type_master {a} ON {a}.code = {transaction_type}",
        "id": "{a}.transaction_type_id", "nullable": True,
        "target": ("transaction_type_master", ["code"]),
    },
    "feature": {
        "fields": ["feature"], "column": "feature_id", "alias": "ref_feature",
        "export_join": "JOIN feature {a} ON {a}.feature_id = {src}.feature_id",
        "export": {"feature": "{a}.name"},
        "insert_join": "JOIN feature {a} ON {a}.name = {feature}",
        "id": "{a}.feature_id", "nullable": False,
        "target": ("feature", ["name"]),
    },
    "product_tag": {
        "fields": ["product_tag"], "column": "product_tag_id", "alias": "ref_ptag",
        "export_join": "LEFT JOIN product_tag {a} ON {a}.product_tag_id = {src}.product_tag_id",
        "export": {"product_tag": "{a}.code"},
        "insert_join": "JOIN product_tag {a} ON {a}.code = {product_tag}",
        "id": "{a}.product_tag_id", "nullable": True,
        "target": ("product_tag", ["code"]),
    },
    "country": {
        "fields": ["country"], "column": "country_id", "alias": "ref_country",
        "export_join": "LEFT JOIN countries {a} ON {a}.country_id = {src}.country_id",
        "export": {"country": "{a}.country_code"},
        "insert_join": "JOIN countries {a} ON {a}.country_code = {country}",
        "id": "{a}.country_id", "nullable": True,
        "target": ("countries", ["country_code"]),
    },
    "currency": {
        "fields": ["currency"], "column": "currency_id", "alias": "ref_currency",
        "export_join": "LEFT JOIN currencies {a} ON {a}.currency_id = {src}.currency_id",
        "export": {"currency": "{a}.currency_code"},
        "insert_join": "JOIN currencies {a} ON {a}.currency_code = {currency}",
        "id": "{a}.currency_id", "nullable": True,
        "target": ("currencies", ["currency_code"]),
    },
    "email_template": {
        "fields": ["email_template"], "column": "email_template_id", "alias": "ref_etpl",
        "export_join": "LEFT JOIN email_template {a} ON {a}.template_id = {src}.email_template_id",
        "export": {"email_template": "{a}.name"},
        "insert_join": "JOIN email_template {a} ON {a}.name = {email_template}",
        "id": "{a}.template_id", "nullable": True,
        "target": ("email_template", ["name"]),
    },
    "report_type": {
        "fields": ["report_type"], "column": "report_type_id", "alias": "ref_report",
        "export_join": "JOIN report_master {a} ON {a}.id = {src}.report_type_id",
        "export": {"report_type": "{a}.name"},
        "insert_join": "JOIN report_master {a} ON {a}.name = {report_type}",
        "id": "{a}.id", "nullable": False,
        "target": ("report_master", ["name"]),
    },
    "project_type": {
        "fields": ["project_type"], "column": "project_type_id", "alias": "ref_ptype",
        "export_join": "LEFT JOIN project_type {a} ON {a}.project_type_id = {src}.project_type_id",
        "export": {"project_type": "{a}.project_type_name"},
        "insert_join": "JOIN project_type {a} ON {a}.project_type_name = {project_type}",
        "id": "{a}.project_type_id", "nullable": True,
        "target": ("project_type", ["project_type_name"]),
    },
    "trigger_code": {
        "fields": ["trigger_code"], "column": "trigger_id", "alias": "ref_trigger",
        "export_join": "LEFT JOIN trigger_master {a} ON {a}.trigger_id = {src}.trigger_id",
        "export": {"trigger_code": "{a}.code"},
        "insert_join": "JOIN trigger_master {a} ON {a}.code = {trigger_code}",
        "id": "{a}.trigger_id", "nullable": True,
        "target": ("trigger_master", ["code"]),
    },
    # master_list is uniquely keyed on (category_code, version), so this ref
    # contributes two exported fields.
    "master_list": {
        "fields": ["master_list_category", "master_list_version"],
        "column": "master_list_id", "alias": "ref_mlist",
        "export_join": "LEFT JOIN master_list {a} ON {a}.master_list_id = {src}.master_list_id",
        "export": {"master_list_category": "{a}.category_code",
                   "master_list_version": "{a}.version"},
        "insert_join": ("JOIN master_list {a} ON {a}.category_code = {master_list_category} "
                        "AND {a}.version = {master_list_version}"),
        "id": "{a}.master_list_id", "nullable": True,
        "target": ("master_list", ["category_code", "version"]),
    },
    # Composite: a tenant_product row is identified by the tenant plus the
    # product code, so this ref needs `product` and emits two joins.
    "tenant_product": {
        "fields": ["product"], "column": "tenant_product_id", "alias": "ref_tp",
        "export_join": ("JOIN tenant_product {a} ON {a}.id = {src}.tenant_product_id\n"
                        "        JOIN product ref_tp_product ON ref_tp_product.product_id = {a}.product_id"),
        "export": {"product": "ref_tp_product.code"},
        "insert_join": ("JOIN product ref_tp_product ON ref_tp_product.code = {product}\n"
                        "    JOIN tenant_product {a} ON {a}.tenant_id = t.tenant_id "
                        "AND {a}.product_id = ref_tp_product.product_id"),
        "id": "{a}.id", "nullable": False,
        "target": ("tenant_product", ["product"]),
    },
    "product_transaction_type": {
        "fields": ["product", "transaction_type"],
        "column": "product_transaction_type_id", "alias": "ref_ptt",
        "export_join": (
            "JOIN product_transaction_type {a} "
            "ON {a}.product_transaction_type_id = {src}.product_transaction_type_id\n"
            "        JOIN product ref_ptt_product ON ref_ptt_product.product_id = {a}.product_id\n"
            "        JOIN transaction_type_master ref_ptt_txn "
            "ON ref_ptt_txn.transaction_type_id = {a}.transaction_type_id"),
        "export": {"product": "ref_ptt_product.code",
                   "transaction_type": "ref_ptt_txn.code"},
        "insert_join": (
            "JOIN product ref_ptt_product ON ref_ptt_product.code = {product}\n"
            "    JOIN transaction_type_master ref_ptt_txn ON ref_ptt_txn.code = {transaction_type}\n"
            "    JOIN product_transaction_type {a} "
            "ON {a}.product_id = ref_ptt_product.product_id "
            "AND {a}.transaction_type_id = ref_ptt_txn.transaction_type_id"),
        "id": "{a}.product_transaction_type_id", "nullable": False,
        "target": ("product_transaction_type", ["product", "transaction_type"]),
    },
    # A tenant_product_transaction_type row needs tenant + product + txn code.
    "tenant_product_transaction_type": {
        "fields": ["product", "transaction_type"],
        "column": "tenant_product_transaction_type_id", "alias": "ref_tptt",
        "export_join": (
            "JOIN tenant_product_transaction_type {a} "
            "ON {a}.id = {src}.tenant_product_transaction_type_id\n"
            "        JOIN tenant_product ref_tptt_tp ON ref_tptt_tp.id = {a}.tenant_product_id\n"
            "        JOIN product ref_tptt_product "
            "ON ref_tptt_product.product_id = ref_tptt_tp.product_id\n"
            "        JOIN product_transaction_type ref_tptt_ptt "
            "ON ref_tptt_ptt.product_transaction_type_id = {a}.product_transaction_type_id\n"
            "        JOIN transaction_type_master ref_tptt_txn "
            "ON ref_tptt_txn.transaction_type_id = ref_tptt_ptt.transaction_type_id"),
        "export": {"product": "ref_tptt_product.code",
                   "transaction_type": "ref_tptt_txn.code"},
        "insert_join": (
            "JOIN product ref_tptt_product ON ref_tptt_product.code = {product}\n"
            "    JOIN transaction_type_master ref_tptt_txn "
            "ON ref_tptt_txn.code = {transaction_type}\n"
            "    JOIN tenant_product ref_tptt_tp ON ref_tptt_tp.tenant_id = t.tenant_id "
            "AND ref_tptt_tp.product_id = ref_tptt_product.product_id\n"
            "    JOIN product_transaction_type ref_tptt_ptt "
            "ON ref_tptt_ptt.product_id = ref_tptt_product.product_id "
            "AND ref_tptt_ptt.transaction_type_id = ref_tptt_txn.transaction_type_id\n"
            "    JOIN tenant_product_transaction_type {a} "
            "ON {a}.tenant_product_id = ref_tptt_tp.id "
            "AND {a}.product_transaction_type_id = ref_tptt_ptt.product_transaction_type_id"),
        "id": "{a}.id", "nullable": False,
        "target": ("tenant_product_transaction_type", ["product", "transaction_type"]),
    },
}


# How a table reaches its tenant.
TENANT_COLUMN = "column"     # the table has its own tenant_id
TENANT_VIA_REF = "via_ref"   # reached through a composite ref (tenant_product, …)
TENANT_GLOBAL = None         # global catalogue, not tenant-scoped


TABLES = [
    # ── Identity ────────────────────────────────────────────────────────── #
    {
        "table": "tenant", "label": "Tenant", "group": "Identity",
        "tenant": "self", "refs": {"country_id": "country"},
        "key": ["organization_code"],
        "columns": ["tenant_name", "sub_domain", "default_currency", "description",
                    "status", "logo", "country", "created_by"],
        "note": "Note: tenant.sub_domain and organization_code are identity fields — "
                "confirm they are correct for the destination environment.",
    },
    {
        "table": "tenant_sub_domain", "label": "Sub Domains", "group": "Identity",
        "tenant": TENANT_COLUMN, "refs": {},
        "key": ["sub_domain"],
        "columns": ["name", "description", "status", "created_by"],
    },

    # ── Environment-specific / credentials ──────────────────────────────── #
    # Included at the user's request, behind mandatory validation + confirmation.
    {
        "table": "tenant_auth", "label": "Auth", "group": "Environment",
        "tenant": TENANT_COLUMN, "refs": {},
        "key": ["auth_type"],
        "columns": ["auth_json", "admin_credentials"],
        "env": True, "required": ["auth_type", "auth_json"],
        "note": "Note: tenant_auth carries admin_credentials — verify the value is "
                "correct for the destination environment before executing.",
    },
    {
        "table": "tenant_db_config", "label": "DB Config", "group": "Environment",
        "tenant": TENANT_COLUMN, "refs": {},
        "key": ["module", "db_type"],
        "columns": ["db_driver", "db_name", "pool_size", "max_overflow", "pool_timeout",
                    "db_host", "db_username", "db_password", "db_port"],
        "env": True,
        "required": ["db_host", "db_port", "db_name", "db_username", "db_password"],
        "note": "Note: tenant_db_config points at a specific database host — the source "
                "value is almost certainly wrong for the destination. Review every field.",
    },
    {
        "table": "minio_config", "label": "MinIO", "group": "Environment",
        "tenant": TENANT_COLUMN, "refs": {"project_type_id": "project_type"},
        "key": ["project_type"],
        "columns": ["host", "port", "bucket_name", "access_key", "secret_key", "is_secure"],
        "env": True,
        "required": ["host", "port", "bucket_name", "access_key", "secret_key"],
        "note": "Note: minio_config carries access_key / secret_key and a bucket that "
                "must exist in the destination environment.",
    },
    {
        "table": "tenant_service_provider_config", "label": "Service Providers",
        "group": "Environment", "tenant": TENANT_COLUMN,
        "refs": {"branch_id": "branch", "product_id": "product",
                 "transaction_type_id": "transaction_type"},
        "key": ["branch", "product", "transaction_type", "service_type", "category"],
        "columns": ["configuration", "is_active"],
        "env": True, "required": ["service_type", "configuration"],
        "note": "Note: tenant_service_provider_config.configuration usually holds "
                "third-party endpoints and API keys — review before executing.",
    },

    # ── Structure ───────────────────────────────────────────────────────── #
    {
        "table": "branch", "label": "Branches", "group": "Structure",
        "tenant": TENANT_COLUMN, "refs": {"country_id": "country"},
        "key": ["code"],
        "columns": ["name", "description", "status", "country", "created_by"],
    },
    {
        "table": "tenant_product", "label": "Tenant Products", "group": "Structure",
        "tenant": TENANT_COLUMN, "refs": {"product_id": "product"},
        "key": ["product"],
        "columns": ["is_active", "display_name", "default_on", "created_by"],
    },
    {
        "table": "tenant_branch_product", "label": "Branch Products", "group": "Structure",
        "tenant": TENANT_VIA_REF, "refs": {"tenant_product_id": "tenant_product",
                                           "branch_id": "branch"},
        "key": ["product", "branch"],
        "columns": ["is_active", "display_name", "created_by"],
    },
    {
        "table": "tenant_module", "label": "Tenant Modules", "group": "Structure",
        "tenant": TENANT_COLUMN, "refs": {"module_id": "module"},
        "key": ["module"],
        "columns": ["display_name", "dependent_modules"],
    },
    {
        "table": "tenant_module_binding", "label": "Module Bindings", "group": "Structure",
        "tenant": TENANT_COLUMN,
        "refs": {"module_id": "module", "branch_id": "branch", "product_id": "product",
                 "transaction_type_id": "transaction_type"},
        "key": ["module", "branch", "product", "transaction_type"],
        "columns": ["sequence", "is_active", "created_by"],
    },
    {
        "table": "tenant_product_transaction_type", "label": "Product Txn Types",
        "group": "Structure", "tenant": TENANT_VIA_REF,
        "refs": {"tenant_product_id": "tenant_product",
                 "product_transaction_type_id": "product_transaction_type"},
        "key": ["product", "transaction_type"],
        "columns": ["is_active", "display_name", "default_on", "created_by"],
    },
    {
        "table": "tenant_branch_product_transaction_type", "label": "Branch Txn Types",
        "group": "Structure", "tenant": TENANT_VIA_REF,
        "refs": {"tenant_product_transaction_type_id": "tenant_product_transaction_type",
                 "branch_id": "branch"},
        "key": ["product", "transaction_type", "branch"],
        "columns": ["is_active", "display_name", "created_by"],
    },

    # ── Configuration ───────────────────────────────────────────────────── #
    {
        "table": "tenant_feature_config", "label": "Feature Config", "group": "Configuration",
        "tenant": TENANT_COLUMN,
        "refs": {"feature_id": "feature", "branch_id": "branch", "product_id": "product",
                 "transaction_type_id": "transaction_type", "module_id": "module"},
        "key": ["feature", "branch", "product", "transaction_type", "module"],
        "columns": ["is_enabled", "created_by"],
    },
    {
        "table": "tenant_module_config", "label": "Module Config", "group": "Configuration",
        "tenant": TENANT_COLUMN,
        "refs": {"module_id": "module", "branch_id": "branch", "product_id": "product",
                 "transaction_type_id": "transaction_type"},
        "key": ["module", "configuration_type", "branch", "product", "transaction_type"],
        "columns": ["value", "created_by"],
    },
    {
        "table": "tenant_tag_meta", "label": "Tag Meta", "group": "Configuration",
        "tenant": TENANT_COLUMN,
        "refs": {"product_tag_id": "product_tag", "product_id": "product"},
        "key": ["product_tag", "product"],
        "columns": ["field_meta", "is_enabled"],
    },
    {
        "table": "tenant_sla", "label": "SLA", "group": "Configuration",
        "tenant": TENANT_COLUMN, "refs": {"branch_id": "branch", "product_id": "product"},
        "key": ["branch", "product"],
        "columns": ["configuration", "is_enabled", "sla_duration"],
    },
    {
        "table": "tenant_weekends", "label": "Weekends", "group": "Configuration",
        "tenant": TENANT_COLUMN, "refs": {"branch_id": "branch"},
        "key": ["branch"],
        "columns": ["is_monday", "is_tuesday", "is_wednesday", "is_thursday",
                    "is_friday", "is_saturday", "is_sunday"],
    },
    {
        "table": "tenant_work_time", "label": "Work Time", "group": "Configuration",
        "tenant": TENANT_COLUMN, "refs": {"branch_id": "branch"},
        "key": ["branch"],
        "columns": ["work_start_time", "work_end_time"],
    },
    {
        "table": "holidays", "label": "Holidays", "group": "Configuration",
        "tenant": TENANT_COLUMN,
        "refs": {"branch_id": "branch", "country_id": "country", "currency_id": "currency"},
        # No unique constraint exists; this is the logical key the tool matches on.
        "key": ["branch", "holiday_date", "holiday_name"],
        "columns": ["holiday_type", "holiday_category", "country", "currency"],
    },
    {
        "table": "tenant_email_template", "label": "Email Templates", "group": "Configuration",
        "tenant": TENANT_COLUMN,
        "refs": {"branch_id": "branch", "product_id": "product",
                 "email_template_id": "email_template"},
        "key": ["branch", "product", "template_type"],
        "columns": ["email_template", "additional_info"],
    },
    {
        "table": "tenant_master_list", "label": "Master Lists", "group": "Configuration",
        "tenant": TENANT_COLUMN,
        "refs": {"branch_id": "branch", "product_id": "product",
                 "transaction_type_id": "transaction_type", "master_list_id": "master_list"},
        "key": ["branch", "product", "transaction_type", "category_code"],
        "columns": ["master_list_category", "master_list_version", "is_active",
                    "effective_from", "effective_to", "created_by"],
    },
    {
        "table": "master_list_configuration", "label": "Master List Config",
        "group": "Configuration", "tenant": TENANT_COLUMN, "refs": {},
        "key": ["category_code"],
        "columns": ["name", "tooltip", "sort_order", "is_active", "is_deleted",
                    "ui_configuration"],
    },
    {
        "table": "tenant_reports", "label": "Reports", "group": "Configuration",
        "tenant": TENANT_COLUMN, "refs": {"report_type_id": "report_type"},
        "key": ["report_type"],
        "columns": ["is_active", "select_clause", "where_clause", "field_metadata"],
    },

    # ── Workflow — the only tables this tool may delete from ─────────────── #
    {
        "table": "workflow", "label": "Workflows", "group": "Workflow",
        "tenant": TENANT_COLUMN,
        "refs": {"module_id": "module", "branch_id": "branch", "product_id": "product",
                 "transaction_type_id": "transaction_type"},
        "key": ["module", "branch", "product", "transaction_type"],
        "columns": ["workflow_name", "is_active"],
        "mode": "replace",
    },
    {
        "table": "transition", "label": "Transitions", "group": "Workflow",
        # Transitions are exported flat, each carrying its workflow's scope, to
        # match how the Workflow Sync tab already presents them and so the
        # table preview can edit them like any other row.
        "tenant": "workflow", "refs": {"trigger_id": "trigger_code"},
        "key": ["module", "branch", "product", "transaction_type", "from_group", "priority"],
        "columns": ["to_groups", "condition", "trigger", "trigger_code", "action_label",
                    "is_disabled", "change_reason", "reassign_to_previous_user"],
        "mode": "replace",
    },

    # ── Global catalogue — insert-only ──────────────────────────────────── #
    # Restricted to rows this tenant actually references. Never updated: these
    # rows are shared, so an UPDATE here would change behaviour for other
    # tenants on the destination.
    {
        "table": "product_tag", "label": "Product Tags", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["code"],
        "columns": ["name", "sequence"], "mode": "insert_only",
    },
    {
        "table": "product", "label": "Products", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {"product_tag_id": "product_tag"},
        "key": ["code"],
        "columns": ["name", "description", "tag", "sequence", "is_inbound",
                    "supported_file_formats", "product_tag"],
        "mode": "insert_only",
        "note": "Note: product.parent_product_id is not migrated — re-point parent "
                "products manually if the source used them.",
    },
    {
        "table": "module", "label": "Modules", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["code"],
        "columns": ["name", "description", "dependent_modules"], "mode": "insert_only",
    },
    {
        "table": "feature", "label": "Features", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {"module_id": "module"}, "key": ["name"],
        "columns": ["description", "feature_group", "module"], "mode": "insert_only",
    },
    {
        "table": "transaction_type_master", "label": "Txn Types", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["code"],
        "columns": ["name", "description", "sequence"], "mode": "insert_only",
    },
    {
        "table": "product_module", "label": "Product Modules", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {"product_id": "product", "module_id": "module"},
        "key": ["product", "module"], "columns": ["sequence", "code"],
        "mode": "insert_only",
    },
    {
        "table": "product_transaction_type", "label": "Product Txn Types",
        "group": "Catalogue", "tenant": TENANT_GLOBAL,
        "refs": {"product_id": "product", "transaction_type_id": "transaction_type"},
        "key": ["product", "transaction_type"], "columns": ["sequence"],
        "mode": "insert_only",
    },
    {
        "table": "product_transaction_type_module", "label": "Txn Type Modules",
        "group": "Catalogue", "tenant": TENANT_GLOBAL,
        "refs": {"product_transaction_type_id": "product_transaction_type",
                 "module_id": "module"},
        "key": ["product", "transaction_type", "module"], "columns": ["sequence"],
        "mode": "insert_only",
    },
    {
        "table": "trigger_master", "label": "Triggers", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["code"],
        "columns": ["display_name", "category", "description", "is_active"],
        "mode": "insert_only",
    },
    {
        "table": "countries", "label": "Countries", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["country_code"],
        "columns": ["country_name", "status"], "mode": "insert_only",
    },
    {
        "table": "currencies", "label": "Currencies", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["currency_code"],
        "columns": ["currency_name", "status"], "mode": "insert_only",
    },
    {
        "table": "master_list", "label": "Master List Versions", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["category_code", "version"],
        "columns": ["list_json", "status"], "mode": "insert_only",
    },
    {
        "table": "email_template", "label": "Email Template Bodies", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["name"],
        "columns": ["subject", "body", "recipients"], "mode": "insert_only",
    },
    {
        "table": "report_master", "label": "Report Types", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["name"],
        "columns": ["description", "is_active", "category"], "mode": "insert_only",
    },
    {
        "table": "project_type", "label": "Project Types", "group": "Catalogue",
        "tenant": TENANT_GLOBAL, "refs": {}, "key": ["project_type_name"],
        "columns": ["description"], "mode": "insert_only",
    },
]

BY_NAME = {spec["table"]: spec for spec in TABLES}

# Only these two may be deleted from, per the tool's contract.
DELETABLE = {"workflow", "transition"}

# The order statements are emitted in — foreign key safe, so the script can be
# run top to bottom in one go. This is deliberately NOT the order of TABLES
# above: that order groups tables for the UI, which puts the global catalogue
# last, whereas catalogue rows have to be inserted *first* for the tenant rows
# that reference them to resolve.
EMIT_ORDER = [
    # Global catalogue, dependency-ordered among itself.
    "countries",
    "currencies",
    "project_type",
    "product_tag",
    "product",
    "module",
    "feature",
    "transaction_type_master",
    "product_module",
    "product_transaction_type",
    "product_transaction_type_module",
    "trigger_master",
    "master_list",
    "email_template",
    "report_master",
    # Tenant identity, then everything hanging off it.
    "tenant",
    "tenant_sub_domain",
    "branch",
    "tenant_module",
    "tenant_product",
    "tenant_branch_product",
    "tenant_product_transaction_type",
    "tenant_branch_product_transaction_type",
    "tenant_module_binding",
    "tenant_module_config",
    "tenant_feature_config",
    "tenant_tag_meta",
    "tenant_sla",
    "tenant_weekends",
    "tenant_work_time",
    "holidays",
    "tenant_email_template",
    "master_list_configuration",
    "tenant_master_list",
    "tenant_reports",
    # Environment-specific last, so a rejected confirmation stops the least.
    "tenant_auth",
    "tenant_db_config",
    "minio_config",
    "tenant_service_provider_config",
    # Workflow last: the only tables this tool deletes from.
    "workflow",
    "transition",
]


def spec(table):
    return BY_NAME[table]


def fields(table_spec):
    """Every exported field for a table, in display order: key then payload."""
    seen, ordered = set(), []
    for field in list(table_spec["key"]) + list(table_spec["columns"]):
        if field not in seen:
            seen.add(field)
            ordered.append(field)
    return ordered


def mode(table_spec):
    return table_spec.get("mode", "upsert")


def env_tables():
    return [s["table"] for s in TABLES if s.get("env")]


def check() -> list:
    """Validate the registry's internal consistency.

    Called at import time. These are authoring mistakes, not runtime
    conditions — the kind that would otherwise show up as a foreign key
    silently missing from the export, which is very hard to spot by eye.
    """
    problems = []
    for table_spec in TABLES:
        table = table_spec["table"]
        declared = set(fields(table_spec))

        # Every field a ref contributes must be exported, or the FK is dropped.
        for ref_name in table_spec["refs"].values():
            if ref_name not in REFS:
                problems.append(f"{table}: unknown ref {ref_name!r}")
                continue
            for field in REFS[ref_name]["fields"]:
                if field not in declared:
                    problems.append(
                        f"{table}: ref {ref_name!r} exports {field!r}, "
                        f"but it is missing from key/columns")

        # A row with no key cannot be matched, so it could never be updated.
        if not table_spec["key"]:
            problems.append(f"{table}: no key declared")

        if mode(table_spec) == "replace" and table not in DELETABLE:
            problems.append(f"{table}: mode 'replace' but not in DELETABLE")

        for field in table_spec.get("required", ()):
            if field not in declared:
                problems.append(f"{table}: required field {field!r} is not exported")

    # EMIT_ORDER drives the whole generated script; a table missing from it would
    # simply never be emitted, silently.
    missing = [s["table"] for s in TABLES if s["table"] not in EMIT_ORDER]
    unknown = [t for t in EMIT_ORDER if t not in BY_NAME]
    duplicated = [t for t in set(EMIT_ORDER) if EMIT_ORDER.count(t) > 1]
    if missing:
        problems.append(f"EMIT_ORDER is missing: {missing}")
    if unknown:
        problems.append(f"EMIT_ORDER names unknown tables: {unknown}")
    if duplicated:
        problems.append(f"EMIT_ORDER repeats: {duplicated}")

    return problems


_PROBLEMS = check()
if _PROBLEMS:
    raise AssertionError("tenant_registry is inconsistent:\n  " + "\n  ".join(_PROBLEMS))


def ui_metadata():
    """Table list the frontend renders for selection and preview."""
    return [
        {
            "table": s["table"],
            "label": s["label"],
            "group": s["group"],
            "mode": mode(s),
            "env": bool(s.get("env")),
            "key": list(s["key"]),
            "fields": fields(s),
            "deletable": s["table"] in DELETABLE,
            "required": list(s.get("required", [])),
        }
        for s in TABLES
    ]
