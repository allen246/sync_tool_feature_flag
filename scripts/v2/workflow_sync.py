"""Workflow / transition sync — multi-tenant (v2) schema.

v1 reached a workflow through a chain of link tables::

    workflow.branch_product_module_id
        → branch_product_module.tenant_product_module
        → product_module → product / module
        → branch → tenant

``branch_product_module`` no longer exists. v2 scopes a workflow directly::

    workflow (tenant_id, module_id, branch_id, product_id, transaction_type_id)

guarded by UNIQUE KEY uq_workflow_scope over the tenant plus the four
COALESCE(...,0) generated columns. Every scope column except tenant_id is
nullable, and NULL means "not narrowed by that dimension" — so the SQL is
built per row from whichever dimensions the source row actually carries.

``transition`` also gained trigger_id (FK to trigger_master), action_label and
reassign_to_previous_user. These are carried through the pull as *codes and
values* rather than raw ids so they resolve correctly against a different
database.
"""

import json

# Scope dimensions shared by the workflow INSERT and DELETE builders.
#   name        → key in the source row
#   table/alias → lookup table for resolving the code to an id
#   id_column   → primary key column on that table
#   workflow_gen_column → the STORED COALESCE(...,0) column on `workflow`
SCOPE_DIMENSIONS = (
    {"name": "module", "table": "module", "alias": "m",
     "id_column": "module_id", "workflow_gen_column": "_module_or_zero"},
    {"name": "branch", "table": "branch", "alias": "b",
     "id_column": "branch_id", "workflow_gen_column": "_branch_or_zero"},
    {"name": "product", "table": "product", "alias": "p",
     "id_column": "product_id", "workflow_gen_column": "_product_or_zero"},
    {"name": "transaction_type", "table": "transaction_type_master", "alias": "tt",
     "id_column": "transaction_type_id", "workflow_gen_column": "_txn_type_or_zero"},
)


def _sql_literal(value) -> str:
    """Quote a scalar for inline SQL, mapping None onto a bare NULL."""
    if value is None or value == "":
        return "NULL"
    return "'{0}'".format(str(value).replace("'", "''"))


# SQL templates. Kept at module level and left-aligned so the emitted script is
# readable — the generated SQL is meant to be reviewed by a human before it runs.
WORKFLOW_INSERT = """\
INSERT INTO workflow
    (workflow_name, tenant_id, module_id, branch_id, product_id, transaction_type_id, is_active)
SELECT '{workflow_name}', tr.tenant_id, {selects}, 1
FROM tenant tr
{joins}
WHERE tr.organization_code = '{tenant_code}'
  AND NOT EXISTS (
      SELECT 1
      FROM workflow existing_workflow
      WHERE existing_workflow.tenant_id = tr.tenant_id
        {conditions}
  );"""

TRANSITION_INSERT = """\
INSERT INTO transition
    (workflow_id, from_group, to_groups, `condition`, `trigger`, priority,
     trigger_id, action_label, reassign_to_previous_user)
SELECT w.workflow_id, '{from_group}', '{to_groups}', '{condition}', '{trigger}', '{priority}',
       {trigger_id_expression}, {action_label}, {reassign}
FROM workflow w
JOIN tenant tr ON tr.tenant_id = w.tenant_id
{joins}
WHERE tr.organization_code = '{tenant_code}'
  {conditions};"""

WORKFLOW_DELETE = """\
DELETE w FROM workflow w
JOIN tenant tr ON tr.tenant_id = w.tenant_id
{joins}
WHERE tr.organization_code = '{tenant_code}'
  {conditions};"""


def _lines(items, indent: int) -> str:
    """Join SQL fragment lines at a fixed indentation.

    The first line carries no padding because it lands wherever the template's
    placeholder already sits.
    """
    return ("\n" + " " * indent).join(items)


def _present(row: dict, key: str):
    """Return row[key] when it is a usable code, else None.

    A CSV round-trip through the Table View drops columns that are not in
    TABLE_COLUMNS, so any v2-only key can legitimately be missing.
    """
    value = row.get(key)
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in ("none", "null"):
        return None
    return text


class WorkflowSync:
    SUPPORTED_TABLES = ['generate_delete_workflow_query', 'generate_workflow_insert_query']

    def __init__(self, tenant_code: str, branch_codes: list):
        self.tenant_code = tenant_code
        self.branch_codes = branch_codes
        self.SOURCE_QUERY_RESULT = {}
        self._generated_query_set = set()
        self._generated_queries = []

    def _collect_query(self, query: str) -> None:
        normalized_query = query.strip()
        if not normalized_query:
            return
        if normalized_query in self._generated_query_set:
            return
        self._generated_query_set.add(normalized_query)
        self._generated_queries.append(normalized_query)

    def _print_collected_queries(self) -> None:
        for query in self._generated_queries:
            print(query.replace("'None'", "null"))

    # ------------------------------------------------------------------ #
    #  Scope resolution                                                    #
    # ------------------------------------------------------------------ #

    def _scope(self, row: dict, alias: str = "existing_workflow") -> dict:
        """Build the JOIN / SELECT / scope-match fragments for one row's scope.

        Dimensions absent from the row contribute a literal NULL to the INSERT
        and a ``= 0`` comparison against the generated column, which is exactly
        how uq_workflow_scope treats them.

        Returns raw line lists; callers indent them with ``_lines`` to match
        wherever they are interpolated, so the emitted SQL stays readable for
        the human reviewing it.
        """
        joins = []
        selects = []
        conditions = []
        for dimension in SCOPE_DIMENSIONS:
            code = _present(row, dimension["name"])
            table_alias = dimension["alias"]
            gen_column = dimension["workflow_gen_column"]
            if code is None:
                selects.append("NULL")
                conditions.append(f"AND {alias}.{gen_column} = 0")
                continue
            selects.append(f"{table_alias}.{dimension['id_column']}")
            conditions.append(
                f"AND {alias}.{gen_column} = {table_alias}.{dimension['id_column']}")
            # A branch is tenant-owned, so it must also be pinned to the tenant.
            tenant_pin = f" AND {table_alias}.tenant_id = tr.tenant_id" \
                if dimension["name"] == "branch" else ""
            joins.append("JOIN {table} {alias} ON {alias}.code = {code}{tenant_pin}".format(
                table=dimension["table"], alias=table_alias,
                code=_sql_literal(code), tenant_pin=tenant_pin))
        return {"joins": joins, "selects": ", ".join(selects), "conditions": conditions}

    # ------------------------------------------------------------------ #
    #  Query generators                                                    #
    # ------------------------------------------------------------------ #

    def generate_workflow_insert_query(self, rows: list[dict]) -> None:
        existing_keys = []
        for row in rows:
            to_grp_name = "-".join(row.get('to_groups', 'None'))
            from_grp = row.get('from_groups', 'None')
            if row['to_groups']:
                row['to_groups'] = json.dumps(row['to_groups'])
            if row['condition']:
                row['condition'] = json.dumps(row['condition'])
            workflow_name = f"{from_grp}--{to_grp_name}"
            row.update({'tenant_code': self.tenant_code, 'workflow_name': workflow_name})

            scope = self._scope(row)
            scope_key = "{0}-{1}-{2}-{3}".format(
                row.get('branch'), row.get('module'), row.get('product'),
                row.get('transaction_type'))
            if scope_key not in existing_keys:
                existing_keys.append(scope_key)
                self._collect_query(WORKFLOW_INSERT.format(
                    workflow_name=workflow_name,
                    tenant_code=self.tenant_code,
                    selects=scope["selects"],
                    joins=_lines(scope["joins"], 0),
                    conditions=_lines(scope["conditions"], 8)))

            self._collect_query(self._transition_insert(row, scope))
        return

    def _transition_insert(self, row: dict, scope: dict) -> str:
        """Insert the transition against the workflow matching this row's scope.

        trigger_id is resolved via a scalar subquery on trigger_master.code so
        the statement stays portable across databases; it lands as NULL when the
        source row carries no trigger code.
        """
        trigger_code = _present(row, 'trigger_code') or _present(row, 'trigger')
        trigger_id_expression = (
            "(SELECT trigger_id FROM trigger_master WHERE code = {0})".format(_sql_literal(trigger_code))
            if trigger_code else "NULL")
        reassign = 1 if str(row.get('reassign_to_previous_user') or '0').strip() in ('1', 'True', 'true') else 0

        # The workflow row is matched on the same scope tuple the INSERT used,
        # compared against the generated columns.
        match = self._scope(row, alias="w")
        return TRANSITION_INSERT.format(
            from_group=row.get('from_group'),
            to_groups=row.get('to_groups'),
            condition=row.get('condition'),
            trigger=row.get('trigger'),
            priority=row.get('priority'),
            trigger_id_expression=trigger_id_expression,
            action_label=_sql_literal(_present(row, 'action_label')),
            reassign=reassign,
            joins=_lines(scope["joins"], 0),
            tenant_code=self.tenant_code,
            conditions=_lines(match["conditions"], 2))

    def generate_delete_workflow_query(self, rows: list[dict]) -> None:
        """Wipe every workflow in the pulled scopes with one statement, v1-style.

        This mirrors v1's single ``branch IN (...) AND product IN (...) AND
        module IN (...)`` DELETE: clear the slate for the codes the pull
        collected, then let the INSERTs below rebuild it. The blast radius is
        the whole cross-product of those codes on purpose — a branch × product ×
        module combination the source no longer carries is one that should no
        longer exist in the destination either, and only a wipe-then-reinsert
        removes it. A per-row DELETE cannot: it only ever touches scopes the
        source still has.

        Two v2 differences the v1 statement did not have to handle:

        * There is no ``branch_product_module`` link table. Scope lives on
          ``workflow`` itself, so each dimension is a LEFT JOIN back to its
          lookup table rather than a subquery through the chain.
        * Every scope column except tenant_id is nullable, and ``code IN (...)``
          never matches a NULL. So a dimension gets an ``IS NULL`` arm as well —
          but *only* when the source actually carries rows that leave that
          dimension unset. Adding it unconditionally would sweep up a
          tenant-wide workflow nobody asked about.

        Transitions go with their workflow via transition_ibfk_1
        ON DELETE CASCADE, same as v1.
        """
        if not rows:
            return

        joins = []
        conditions = []
        for dimension in SCOPE_DIMENSIONS:
            present = [_present(row, dimension["name"]) for row in rows]
            codes = sorted({code for code in present if code})
            unset = any(code is None for code in present)
            alias = dimension["alias"]
            # The lookup table's id column carries the same name on `workflow`.
            column = dimension["id_column"]
            # A branch is tenant-owned, so it must also be pinned to the tenant.
            tenant_pin = f" AND {alias}.tenant_id = tr.tenant_id" \
                if dimension["name"] == "branch" else ""
            joins.append("LEFT JOIN {table} {alias} ON {alias}.{column} = w.{column}{tenant_pin}".format(
                table=dimension["table"], alias=alias, column=column, tenant_pin=tenant_pin))

            arms = []
            if codes:
                arms.append("{0}.code IN ({1})".format(
                    alias, ", ".join(_sql_literal(code) for code in codes)))
            if unset:
                arms.append(f"w.{column} IS NULL")
            conditions.append("AND ({0})".format(" OR ".join(arms)))

        self._collect_query(WORKFLOW_DELETE.format(
            joins=_lines(joins, 0),
            tenant_code=self.tenant_code,
            conditions=_lines(conditions, 2)))
        return

    # ------------------------------------------------------------------ #
    #  Orchestration                                                       #
    # ------------------------------------------------------------------ #

    def generate_query(self, rows: list[dict]) -> None:
        self._generated_query_set.clear()
        self._generated_queries.clear()
        for table_name in self.SUPPORTED_TABLES:
            getattr(self, table_name)(rows)
        self._print_collected_queries()

    def read_workflow_backup(self, file_name: str = "workflow_backup.json") -> None:
        if self.SOURCE_QUERY_RESULT:
            rows = self.SOURCE_QUERY_RESULT
        else:
            with open(file_name, "r") as file:
                rows = json.load(file)

        self.generate_query(rows)


def generate_source_data_query(tenant_code, branch_codes, product_codes=None):
    """Emit the source pull query.

    Every v1 JSON key is preserved so the Table View columns and the CSV
    template keep working unchanged. Four v2-only keys are appended
    (transaction_type, trigger_code, action_label,
    reassign_to_previous_user) — the Table View passes unknown keys through
    untouched, so they reach /workflow/final without altering the UI.

    Branch, product and module are LEFT JOINed because in v2 each of those
    scope columns is nullable on `workflow`; an inner join would silently drop
    tenant-wide or product-wide workflows.
    """
    product_codes = product_codes or []
    branch_codes_str = ", ".join([f"'{c.strip()}'" for c in branch_codes if c and c.strip()])
    product_codes_str = ", ".join([f"'{c.strip()}'" for c in product_codes if c and c.strip()])
    tenant_code_str = f"'{tenant_code.strip()}'"
    source_query = """SELECT JSON_ARRAYAGG(
                        JSON_OBJECT(
                            'branch', b.code,
                            'product_name', p.tag,
                            'product', p.code,
                            'module', m.code,
                            'transition_id', t.transition_id,
                            'from_group', t.from_group,
                            'to_groups', t.to_groups,
                            'condition', t.`condition`,
                            'trigger', t.`trigger`,
                            'priority', t.priority,
                            'workflow_id', w.workflow_id,
                            'transaction_type', tt.code,
                            'trigger_code', tm.code,
                            'action_label', t.action_label,
                            'reassign_to_previous_user', t.reassign_to_previous_user
                        )
                    ) AS result
                    FROM transition t
                    JOIN workflow w
                        ON w.workflow_id = t.workflow_id and t.is_disabled = 0
                    JOIN tenant tr
                        ON tr.tenant_id = w.tenant_id
                    LEFT JOIN branch b
                        ON b.branch_id = w.branch_id
                    LEFT JOIN product p
                        ON p.product_id = w.product_id
                    LEFT JOIN module m
                        ON m.module_id = w.module_id
                    LEFT JOIN transaction_type_master tt
                        ON tt.transaction_type_id = w.transaction_type_id
                    LEFT JOIN trigger_master tm
                        ON tm.trigger_id = t.trigger_id
                    WHERE tr.organization_code = {tenant_code_str}"""
    if branch_codes_str:
        source_query += f" and b.code in ({branch_codes_str})"
    if product_codes_str:
        source_query += f" and p.code in ({product_codes_str})"
    source_query += ";"
    formatted_source = source_query.format(
        tenant_code_str=tenant_code_str,
        branch_codes_str=branch_codes_str,
        product_codes_str=product_codes_str
    )

    print(f"Source DB query: {formatted_source}")
