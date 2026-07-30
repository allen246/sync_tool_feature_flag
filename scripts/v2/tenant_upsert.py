"""Write side: turns a source export + a destination snapshot into migration SQL.

Contract enforced here
──────────────────────
* Rows missing on the destination become INSERTs.
* Rows that exist but differ become UPDATEs touching only the changed columns.
* Rows that match are skipped entirely — no statement is emitted.
* DELETE is only ever emitted for `workflow` and `transition`. Every other
  table is insert-or-update; nothing else is removed, even when the destination
  holds rows the source does not.
* Global catalogue tables are insert-only. They are shared with other tenants,
  so an UPDATE there could change behaviour outside the tenant being migrated;
  a difference is reported as a note instead.

Statements come out in registry.EMIT_ORDER, which is foreign-key safe, so the
script can be run top to bottom in one pass.
"""

from scripts.v2 import tenant_registry as registry
from scripts.v2.sql_util import comparable, escape, is_blank, literal, quote_identifier

TENANT_ALIAS = "t"
ROW_ALIAS = "x"


class TenantUpsert:
    """Builds the migration script for one tenant.

    Parameters
    ----------
    tenant_code
        organization_code of the tenant being migrated.
    source, destination
        Parsed results of the two pull queries, each ``{table: [row, ...]}``.
    selected
        Table names the user ticked. Tables outside this set are skipped
        entirely — nothing is read from them and nothing is emitted.
    confirmed
        Table names whose environment-specific values the user has explicitly
        confirmed. Required before any `env` table can produce SQL.
    """

    def __init__(self, tenant_code, source, destination, selected=None, confirmed=()):
        self.tenant_code = tenant_code
        self.source = _normalize(source)
        self.destination = _normalize(destination)
        self.selected = set(selected) if selected is not None else set(registry.BY_NAME)
        self.confirmed = set(confirmed)
        self.notes = []
        self.stats = {}

    # ------------------------------------------------------------------ #
    #  Validation — runs before any SQL is produced                        #
    # ------------------------------------------------------------------ #

    def validate(self) -> list:
        """Return blocking problems. A non-empty result means: emit nothing.

        Environment-specific tables are the reason this exists. They carry
        credentials and per-environment endpoints, so they must be both
        explicitly confirmed and complete before they can reach a script that
        someone will paste into a destination database.
        """
        problems = []
        if not str(self.tenant_code or "").strip():
            problems.append("Tenant organization_code is required.")

        for table in self._tables_in_play():
            spec = registry.spec(table)
            if not spec.get("env"):
                continue
            rows = self.source.get(table) or []
            if not rows:
                continue
            if table not in self.confirmed:
                problems.append(
                    f"{spec['label']} ({table}) holds environment-specific values and "
                    f"must be confirmed before SQL can be generated.")
                continue
            problems.extend(self._missing_required(spec, rows))

        return problems

    def _missing_required(self, spec, rows) -> list:
        """Every required field on an env table must be filled in."""
        problems = []
        for position, row in enumerate(rows, start=1):
            for field in spec.get("required", ()):
                if is_blank(row.get(field)):
                    problems.append(
                        f"{spec['label']} ({spec['table']}) row {position}: "
                        f"{field!r} is required for the destination environment.")
        return problems

    # ------------------------------------------------------------------ #
    #  Generation                                                          #
    # ------------------------------------------------------------------ #

    def generate(self) -> str:
        """Build the migration script. Assumes validate() returned empty."""
        self.notes = []
        self.stats = {}
        sections = []

        for table in registry.EMIT_ORDER:
            if table not in self.selected:
                continue
            section = self._table_section(registry.spec(table))
            if section:
                sections.append(section)

        self._report_unreferenced()
        return "\n\n".join(sections)

    def _table_section(self, spec) -> str:
        """All statements for one table, under a comment header."""
        statements = self._statements_for(spec)
        if not statements:
            return ""

        if spec.get("note"):
            self.notes.append(spec["note"])

        header = f"-- ── {spec['label']}  ({spec['table']}) " + "─" * 12
        return header + "\n" + "\n".join(statements)

    def _statements_for(self, spec) -> list:
        mode = registry.mode(spec)
        if mode == "replace":
            return self._replace_statements(spec)
        return self._upsert_statements(spec)

    def _upsert_statements(self, spec) -> list:
        """INSERT what is missing, UPDATE what differs, skip what matches."""
        table = spec["table"]
        insert_only = registry.mode(spec) == "insert_only"
        destination_by_key = self._index(spec, self.destination.get(table))

        statements, inserted, updated, unchanged, reported = [], 0, 0, 0, 0
        for row in self.source.get(table) or []:
            existing = destination_by_key.get(self._key_of(spec, row))
            if existing is None:
                statements.append(self._insert(spec, row))
                inserted += 1
                continue

            changed = self._changed_fields(spec, row, existing)
            if not changed:
                unchanged += 1
            elif insert_only:
                # Shared catalogue row: report the difference, never rewrite it.
                reported += 1
                self.notes.append(
                    f"Note: {spec['label']} ({table}) {self._describe(spec, row)} differs "
                    f"on the destination ({', '.join(sorted(changed))}) but is a shared "
                    f"catalogue row — left untouched. Review manually if intended.")
            else:
                statements.append(self._update(spec, row, changed))
                updated += 1

        self.stats[table] = {"insert": inserted, "update": updated,
                             "unchanged": unchanged, "reported": reported}
        return statements

    def _replace_statements(self, spec) -> list:
        """workflow / transition: wipe the pulled scope, then re-insert it.

        These are the only tables the tool deletes from. One set-based DELETE
        clears everything in the collected scope — the same wipe-then-reinsert
        the Workflow Sync tab does — then every source row is inserted back.

        Deleting a workflow cascades to its transitions (transition_ibfk_1
        ON DELETE CASCADE), so when both tables are selected the transition
        DELETE is redundant but harmless — and it is what makes selecting
        `transition` alone work.
        """
        table = spec["table"]
        rows = self.source.get(table) or []
        deletes = [self._bulk_delete(spec, rows)] if rows else []
        inserts = [self._insert(spec, row) for row in rows]

        if table == "workflow":
            self._note_destination_only_workflows()

        self.stats[table] = {"insert": len(inserts), "delete": len(deletes),
                             "update": 0, "unchanged": 0, "reported": 0}
        return deletes + inserts

    # ------------------------------------------------------------------ #
    #  Statement builders                                                  #
    # ------------------------------------------------------------------ #

    def _insert(self, spec, row) -> str:
        # A transition is identified by its parent workflow's scope rather than
        # by columns of its own, so it needs a dedicated builder.
        if spec["table"] == "transition":
            return self._insert_transition(row)

        bindings = self._bind_refs(spec, row)
        columns, values = [], []

        # Tables that carry their own tenant_id must be told which tenant they
        # belong to; the anchor join resolves it from the organization_code.
        # TENANT_VIA_REF tables inherit it through their parent row instead, and
        # `tenant` / catalogue tables have no such column.
        if spec["tenant"] == registry.TENANT_COLUMN:
            columns.append("tenant_id")
            values.append(f"{TENANT_ALIAS}.tenant_id")

        for binding in bindings:
            columns.append(binding["column"])
            values.append(binding["value"])
        for field in self._plain_fields(spec):
            columns.append(quote_identifier(field))
            values.append(literal(row.get(field)))

        anchor, joins = self._from_clause(spec, bindings, for_update=False)
        conditions = self._tenant_condition(spec) + self._key_conditions(spec, row, bindings)

        return (
            f"INSERT INTO {spec['table']}\n"
            f"    ({', '.join(columns)})\n"
            f"SELECT {', '.join(values)}\n"
            f"{anchor}"
            + _block(joins)
            + "WHERE " + _and(self._anchor_condition(spec) + [
                "NOT EXISTS (\n        SELECT 1 FROM {table} {alias}\n        WHERE {match}\n    )".format(
                    table=spec["table"], alias=ROW_ALIAS, match=_and(conditions, indent=14))
            ], indent=2)
            + ";"
        )

    def _insert_transition(self, row) -> str:
        """Insert one transition against the workflow matching its scope.

        The exported row carries module / branch / product / transaction_type —
        its parent workflow's scope, repeated on every transition so the row can
        stand alone in the table preview. Those four fields are not columns of
        `transition`; here they resolve the workflow to hang the row off.

        No NOT EXISTS guard is needed: `transition` is a replace-mode table, so
        every transition for this scope has already been deleted above.

        trigger_id resolves through a scalar subquery rather than a join, so a
        trigger code that is missing on the destination lands as NULL instead of
        silently dropping the whole transition.
        """
        spec = registry.spec("transition")
        workflow_spec = registry.spec("workflow")
        scope_bindings = self._bind_refs(workflow_spec, row)
        _, scope_joins = self._from_clause(workflow_spec, scope_bindings, for_update=True)

        columns, values = ["workflow_id"], ["wf.workflow_id"]

        trigger_code = row.get("trigger_code")
        columns.append("trigger_id")
        values.append(
            "NULL" if is_blank(trigger_code)
            else f"(SELECT trigger_id FROM trigger_master WHERE code = {literal(trigger_code)})")

        for field in self._plain_fields(spec):
            if field in _WORKFLOW_SCOPE:
                continue          # scope, resolved by the workflow join above
            columns.append(quote_identifier(field))
            values.append(literal(row.get(field)))

        match = self._key_conditions(workflow_spec, row, scope_bindings, alias="wf")
        return (
            f"INSERT INTO transition\n    ({', '.join(columns)})\n"
            f"SELECT {', '.join(values)}\n"
            "FROM workflow wf\n"
            f"JOIN tenant {TENANT_ALIAS} ON {TENANT_ALIAS}.tenant_id = wf.tenant_id\n"
            + _block(scope_joins)
            + "WHERE " + _and(
                [f"{TENANT_ALIAS}.organization_code = {escape(self.tenant_code)}"] + match,
                indent=2)
            + ";"
        )

    def _update(self, spec, row, changed) -> str:
        """UPDATE touching only the fields that actually differ."""
        bindings = self._bind_refs(spec, row)
        assignments = []

        for binding in bindings:
            if any(field in changed for field in binding["fields"]):
                assignments.append(f"{ROW_ALIAS}.{binding['column']} = {binding['value']}")
        for field in self._plain_fields(spec):
            if field in changed:
                assignments.append(
                    f"{ROW_ALIAS}.{quote_identifier(field)} = {literal(row.get(field))}")

        if not assignments:
            return ""

        _, joins = self._from_clause(spec, bindings, for_update=True)
        conditions = self._tenant_condition(spec) + self._key_conditions(spec, row, bindings)

        return (
            f"UPDATE {spec['table']} {ROW_ALIAS}\n"
            + (f"JOIN tenant {TENANT_ALIAS} "
               f"ON {TENANT_ALIAS}.organization_code = {escape(self.tenant_code)}\n"
               if self._needs_tenant_join(spec) else "")
            + _block(joins)
            + "SET " + ",\n    ".join(assignments) + "\n"
            + "WHERE " + _and(conditions, indent=2) + ";"
        )

    def _bulk_delete(self, spec, rows) -> str:
        """One DELETE clearing every scope the export covers.

        Shape follows v1's workflow wipe: collect the distinct module / branch /
        product / transaction_type codes across all rows and delete anything
        inside that cross-product, so a combination the source has dropped is
        removed rather than left behind. A per-row DELETE could never do that —
        it only touches scopes the source still carries.

        Each dimension joins back from the workflow row to its lookup table with
        the registry's own export_join, then contributes one predicate. Because
        every scope column on `workflow` is nullable and ``code IN (...)`` never
        matches a NULL, a dimension also gets an ``IS NULL`` arm — but only when
        the export actually has rows leaving it unset, otherwise the wipe would
        reach tenant-wide workflows outside the pull.

        Transitions are handled through their parent workflow's scope, the same
        way _insert_transition resolves them.
        """
        workflow_spec = registry.spec("workflow")
        joins, conditions = [], []

        for fk_column, ref_name in workflow_spec["refs"].items():
            ref = registry.REFS[ref_name]
            field = ref["fields"][0]        # every scope ref is a single-code key
            values = [row.get(field) for row in rows]
            codes = sorted({str(v).strip() for v in values if not is_blank(v)})
            alias = ref["alias"]

            # A tenant-owned lookup (branch) must be pinned to the tenant, the
            # same way its insert_join does it.
            tenant_pin = f" AND {alias}.tenant_id = {TENANT_ALIAS}.tenant_id" \
                if "tenant_id" in ref["insert_join"] else ""
            joins.append(ref["export_join"].format(a=alias, src="wf") + tenant_pin)

            arms = []
            if codes:
                arms.append("{0} IN ({1})".format(
                    ref["export"][field].format(a=alias),
                    ", ".join(escape(code) for code in codes)))
            if any(is_blank(v) for v in values):
                arms.append(f"wf.{fk_column} IS NULL")
            conditions.append("(" + " OR ".join(arms) + ")")

        tenant_join = (f"JOIN tenant {TENANT_ALIAS} "
                       f"ON {TENANT_ALIAS}.organization_code = {escape(self.tenant_code)}\n")
        where = _and([f"wf.tenant_id = {TENANT_ALIAS}.tenant_id"] + conditions, indent=2)

        if spec["table"] == "workflow":
            return ("DELETE wf FROM workflow wf\n" + tenant_join + _block(joins)
                    + "WHERE " + where + ";")

        return ("DELETE tr FROM transition tr\n"
                "JOIN workflow wf ON wf.workflow_id = tr.workflow_id\n"
                + tenant_join + _block(joins) + "WHERE " + where + ";")

    # ------------------------------------------------------------------ #
    #  Row helpers                                                         #
    # ------------------------------------------------------------------ #

    def _bind_refs(self, spec, row) -> list:
        """Resolve each foreign key on a row to a join + an id expression.

        A ref whose natural key is absent contributes a literal NULL and no
        join, which is how the v2 schema represents "not narrowed by this
        dimension".
        """
        bindings = []
        for fk_column, ref_name in spec["refs"].items():
            ref = registry.REFS[ref_name]
            values = {field: row.get(field) for field in ref["fields"]}
            present = not all(is_blank(v) for v in values.values())

            if not present:
                if not ref["nullable"]:
                    self.notes.append(
                        f"Note: {spec['label']} ({spec['table']}) row is missing required "
                        f"{ref_name!r} — skipped.")
                bindings.append({"column": fk_column, "value": "NULL", "join": None,
                                 "id": None, "fields": ref["fields"], "ref": ref_name})
                continue

            quoted = {field: literal(value) for field, value in values.items()}
            bindings.append({
                "column": fk_column,
                "value": ref["id"].format(a=ref["alias"]),
                "join": ref["insert_join"].format(a=ref["alias"], **quoted),
                "id": ref["id"].format(a=ref["alias"]),
                "fields": ref["fields"],
                "ref": ref_name,
            })
        return bindings

    def _plain_fields(self, spec) -> list:
        """Exported fields that map straight onto a column of this table."""
        from_refs = {
            field
            for ref_name in spec["refs"].values()
            for field in registry.REFS[ref_name]["fields"]
        }
        return [f for f in registry.fields(spec) if f not in from_refs]

    def _from_clause(self, spec, bindings, for_update: bool):
        """The FROM anchor and the ref joins for a statement.

        A tenant-scoped INSERT anchors on `tenant`, which both scopes the row
        and refuses to insert anything when the organization_code is unknown.
        The `tenant` table itself and the global catalogue have no such anchor,
        so they use a one-row subquery instead — portable, unlike a bare
        SELECT without FROM.
        """
        joins = [b["join"] for b in bindings if b["join"]]
        if for_update:
            return "", joins
        if self._needs_tenant_join(spec):
            return f"FROM tenant {TENANT_ALIAS}\n", joins
        return "FROM (SELECT 1) AS anchor_row\n", joins

    def _needs_tenant_join(self, spec) -> bool:
        """True when the statement has to resolve the tenant by organization_code.

        The `tenant` row itself is identified by organization_code directly, and
        catalogue rows are not tenant-scoped at all.
        """
        return spec["tenant"] not in (registry.TENANT_GLOBAL, "self")

    def _anchor_condition(self, spec) -> list:
        if self._needs_tenant_join(spec):
            return [f"{TENANT_ALIAS}.organization_code = {escape(self.tenant_code)}"]
        return []

    def _tenant_condition(self, spec) -> list:
        """Scope the matched row to this tenant.

        TENANT_VIA_REF tables need nothing here: their identifying ref
        (tenant_product / tenant_product_transaction_type) is already pinned to
        the tenant inside its own join.
        """
        linkage = spec["tenant"]
        if linkage == registry.TENANT_COLUMN:
            return [f"{ROW_ALIAS}.tenant_id = {TENANT_ALIAS}.tenant_id"]
        return []

    def _key_conditions(self, spec, row, bindings, alias=ROW_ALIAS) -> list:
        """The WHERE fragment that identifies exactly one row."""
        key_fields = set(spec["key"])
        conditions = []

        for binding in bindings:
            if not any(field in key_fields for field in binding["fields"]):
                continue
            if binding["id"] is None:
                conditions.append(f"{alias}.{binding['column']} IS NULL")
            else:
                conditions.append(f"{alias}.{binding['column']} = {binding['id']}")

        ref_fields = {f for b in bindings for f in b["fields"]}
        for field in spec["key"]:
            if field in ref_fields:
                continue
            value = row.get(field)
            if is_blank(value):
                conditions.append(f"{alias}.{quote_identifier(field)} IS NULL")
            else:
                conditions.append(f"{alias}.{quote_identifier(field)} = {literal(value)}")
        return conditions

    def _key_of(self, spec, row) -> tuple:
        return tuple(comparable(row.get(field)) for field in spec["key"])

    def _index(self, spec, rows) -> dict:
        return {self._key_of(spec, row): row for row in rows or []}

    def _changed_fields(self, spec, source_row, destination_row) -> set:
        """Payload fields whose normalised values differ between the two sides.

        Key fields are excluded: they matched, by definition. Fields absent from
        the destination row are treated as unchanged rather than as a difference,
        so a destination export that predates a new column does not produce a
        script full of spurious UPDATEs.
        """
        changed = set()
        for field in spec["columns"]:
            if field in spec["key"] or field not in destination_row:
                continue
            if comparable(source_row.get(field)) != comparable(destination_row.get(field)):
                changed.add(field)
        return changed

    def _describe(self, spec, row) -> str:
        return "/".join(str(row.get(f)) for f in spec["key"] if not is_blank(row.get(f))) or "row"

    # ------------------------------------------------------------------ #
    #  Advisory notes                                                      #
    # ------------------------------------------------------------------ #

    def _tables_in_play(self) -> list:
        return [t for t in registry.EMIT_ORDER if t in self.selected]

    def _note_destination_only_workflows(self):
        """Workflows on the destination that the source does not have.

        Not deleted: the tool only removes the scopes it is about to re-insert.
        Reported so the decision is the operator's.
        """
        spec = registry.spec("workflow")
        source_keys = {self._key_of(spec, r) for r in self.source.get("workflow") or []}
        orphans = [
            r for r in self.destination.get("workflow") or []
            if self._key_of(spec, r) not in source_keys
        ]
        for row in orphans:
            self.notes.append(
                f"Note: destination has workflow {self._describe(spec, row)!r} "
                f"({row.get('workflow_name')}) which the source does not — left in place. "
                f"Remove it manually if the source is authoritative.")

    def _report_unreferenced(self):
        """Flag natural keys that will not resolve on the destination.

        Every foreign key is written as a JOIN on a natural key. If that key is
        absent from the destination *and* not being inserted by this script, the
        JOIN matches nothing and the statement silently inserts zero rows —
        which is exactly the failure that is hardest to notice by eye.
        """
        for table in self._tables_in_play():
            spec = registry.spec(table)
            for ref_name in spec["refs"].values():
                ref = registry.REFS[ref_name]
                target_table, target_fields = ref["target"]
                available = self._available_keys(target_table, target_fields)
                if available is None:
                    continue
                for row in self.source.get(table) or []:
                    values = [row.get(f) for f in ref["fields"]]
                    if all(is_blank(v) for v in values):
                        continue
                    needle = tuple(comparable(v) for v in values)
                    if needle not in available:
                        shown = "/".join(str(v) for v in values)
                        self.notes.append(
                            f"Note: {spec['label']} ({table}) references "
                            f"{ref_name} {shown!r}, which is not on the destination and is "
                            f"not being inserted — that statement will affect 0 rows. "
                            f"Select the {target_table} table, or create it manually.")
                        break

    def _available_keys(self, target_table, target_fields):
        """Natural keys of a referenced table that will exist after this script.

        That is: whatever the destination already has, plus whatever the script
        is going to insert. Returns None when the target is not part of the
        registry, in which case no claim can be made.
        """
        if target_table not in registry.BY_NAME:
            return None
        keys = {
            tuple(comparable(row.get(f)) for f in target_fields)
            for row in self.destination.get(target_table) or []
        }
        if target_table in self.selected:
            keys |= {
                tuple(comparable(row.get(f)) for f in target_fields)
                for row in self.source.get(target_table) or []
            }
        return keys


# The scope columns shared by workflow and transition rows.
_WORKFLOW_SCOPE = ("module", "branch", "product", "transaction_type")


def _normalize(payload) -> dict:
    """Accept the several shapes a pasted DB export can arrive in.

    A single JSON_OBJECT result may come back as the object itself, wrapped in
    a one-row array, wrapped under a `result` key, or double-encoded as a
    string. Anything unrecognised yields an empty mapping rather than raising,
    so a missing destination export simply means "everything is new".
    """
    import json

    for _ in range(5):
        if payload is None:
            return {}
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
                continue
            except (ValueError, TypeError):
                return {}
        if isinstance(payload, list):
            if len(payload) != 1:
                return {}
            payload = payload[0]
            continue
        if isinstance(payload, dict):
            if len(payload) == 1 and next(iter(payload)) in ("result", "data", "rows"):
                payload = next(iter(payload.values()))
                continue
            return {k: (v or []) for k, v in payload.items()}
    return {}


def _and(conditions, indent: int = 0) -> str:
    pad = "\n" + " " * indent + "AND "
    return pad.join(c for c in conditions if c)


def _block(lines) -> str:
    """Render join lines one per row at a consistent indent.

    Composite refs supply multi-line join templates; their continuation lines
    are re-indented here so every JOIN in the emitted statement starts in the
    same column.
    """
    rendered = []
    for line in lines:
        if not line:
            continue
        for part in str(line).split("\n"):
            part = part.strip()
            if part:
                rendered.append(part + "\n")
    return "".join(rendered)
