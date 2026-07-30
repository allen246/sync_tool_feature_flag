"""Branch / product sync — multi-tenant (v2) schema.

The v1 link chain ``product → product_module → branch_product_module → branch``
is gone. v2 inserts a tenant layer between the global catalogue and the branch::

    product      (global catalogue, unchanged)
      → tenant_product              (tenant enables the product)
        → tenant_branch_product     (branch enables it)   [was branch_product_module]

    product_transaction_type        (global, unchanged)
      → tenant_product_transaction_type
        → tenant_branch_product_transaction_type          [was branch_product_transaction_type]

    module                          (global, unchanged)
      → tenant_module               (tenant enables the module)
      → tenant_module_binding       (module scoped to branch/product/txn-type)

    product_transaction_type_module (new: txn-type ↔ module, global)

Two deliberate differences from v1, both forced by that split
────────────────────────────────────────────────────────────
1. v1 skipped ``tenant_module`` whenever the *global* module code already
   existed in the destination. In v2 the global catalogue and the tenant's
   enablement are separate rows, so skipping the tenant row would emit a
   migration that silently fails to enable the module. Tenant-scoped tables are
   therefore always emitted; every insert is guarded by NOT EXISTS, so a re-run
   stays idempotent. Only global-catalogue tables are skipped on a code match.
2. Modules are matched on ``module.code`` rather than ``module.name``. ``code``
   carries UNIQUE KEY uq_module_code; ``name`` does not, so the v1 join could
   match the wrong row or none at all.

The source-pull JSON keeps exactly the five top-level keys v1 produced, because
``unflattenBranchRow`` in static/js/tabs/branch.js rebuilds rows from that fixed
key set — any new top-level key would be dropped on a Table View round-trip.
v2-only fields are nested inside those objects instead.
"""

import json
from typing import Any


class BranchProductSync:
    # Global catalogue tables — safe to skip when the destination already has
    # the code, exactly as in v1.
    PRODUCT_RELATIONAL_TABLES = frozenset(["product_tag", "product"])

    BRANCH_RELATIONAL_TABLES = frozenset(["branch"])

    TRANSACTION_TYPE_TABLES = frozenset(["transaction_type_master"])

    # v1 also listed tenant_module here; see difference (1) in the module docstring.
    MODULE_RELATIONAL_TABLES = frozenset(["module"])

    # Tables that cannot be written without a module on the row.
    MODULE_DEPENDENT_TABLES = frozenset([
        "tenant_module", "product_transaction_type_module", "tenant_module_binding",
    ])

    # Tables that only apply when the row carries a transaction type.
    TRANSACTION_TYPE_DEPENDENT_TABLES = frozenset([
        "transaction_type_master", "product_transaction_type",
        "product_transaction_type_module", "tenant_product_transaction_type",
        "tenant_branch_product_transaction_type",
    ])

    SUPPORTED_TABLES = [
        # Order matters: dependencies must be inserted before dependents.
        "branch",
        "product_tag",
        "product",
        "module",
        "tenant_module",
        "product_module",
        "tenant_product",
        "tenant_branch_product",
        "transaction_type_master",
        "product_transaction_type",
        "product_transaction_type_module",
        "tenant_product_transaction_type",
        "tenant_branch_product_transaction_type",
        "tenant_module_binding",
    ]

    def __init__(self, tenant_code: str):
        self.tenant_code = tenant_code
        self.SOURCE_QUERY_RESULT = {}
        self.EXISTING_CONFIG = {}
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
        replace_mapper = {"'None'": "null", "= null": "is null"}
        for query in self._generated_queries:
            for replacement_key in replace_mapper:
                query = query.replace(replacement_key, replace_mapper[replacement_key])
            print(query)

    # ------------------------------------------------------------------ #
    #  Helpers                                                             #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _is_module_missing_row(row: dict) -> bool:
        return bool(
            row.get("module_missing_product_configurations")
            and not row.get("module_configurations")
        )

    @staticmethod
    def _active_product_configurations(row: dict) -> dict:
        if BranchProductSync._is_module_missing_row(row):
            return row["module_missing_product_configurations"]
        return row.get("product_configurations") or row.get("module_missing_product_configurations") or {}

    def _existing_config_values(self, key: str) -> list:
        values = self.EXISTING_CONFIG.get(key) or []
        if isinstance(values, str):
            try:
                return json.loads(values) or []
            except json.JSONDecodeError:
                return [values]
        return values

    @staticmethod
    def _serialize_value(value: Any) -> str:
        """Wrap scalar values in single quotes; JSON-encode dicts or lists."""
        if isinstance(value, (dict, list)):
            return f"'{json.dumps(value)}'"
        return f"'{value}'"

    def _get_tenant_arguments(self) -> dict:
        """Return base argument dict containing branch and tenant identifiers."""
        return {
            "organization_code": f"'{self.tenant_code}'"
        }

    @staticmethod
    def _flag(value: Any, default: int) -> int:
        """Coerce a tinyint(1) column coming back from JSON into 0/1."""
        if value is None or value == "":
            return default
        if isinstance(value, bool):
            return int(value)
        text = str(value).strip().lower()
        if text in ("1", "true", "yes", "active"):
            return 1
        if text in ("0", "false", "no", "inactive"):
            return 0
        return default

    @staticmethod
    def _nullable(value: Any) -> str:
        """Inline a value that may legitimately be NULL (e.g. display_name)."""
        if value is None or value == "" or str(value).lower() in ("none", "null"):
            return "NULL"
        return "'{0}'".format(str(value).replace("'", "''"))

    def _module_code(self, row: dict):
        module_configurations = row.get("module_configurations") or {}
        return module_configurations.get("code")

    # ------------------------------------------------------------------ #
    #  Query generators — global catalogue (unchanged from v1)             #
    # ------------------------------------------------------------------ #

    def generate_branch_insert_query(self, arguments: dict) -> str:
        branch_configuration = arguments["branch_configuration"]
        query_arguments = {
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in branch_configuration.items()
        }
        query_arguments.update({"tenant_code": f"'{self.tenant_code}'"})

        return """
            INSERT INTO branch (code, name, tenant_id, description, status)
            SELECT
                {code},
                {name},
                t.tenant_id,
                {description},
                {status}
            FROM tenant t
            WHERE NOT EXISTS (
                SELECT 1
                FROM branch b join tenant t
                WHERE b.code = {code} and t.organization_code={tenant_code}
            ) and t.organization_code={tenant_code};""".format(**query_arguments)

    @staticmethod
    def generate_product_tag_insert_query(arguments: dict) -> str:
        product_configurations = BranchProductSync._active_product_configurations(arguments)
        product_tag_configurations = product_configurations.get("product_tag_configurations", {})

        query_arguments = {
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in product_tag_configurations.items()
        }

        return """
            INSERT INTO product_tag (code, name, sequence)
            SELECT
                {code},
                {name},
                {sequence}
            FROM product_tag
            WHERE NOT EXISTS (
                SELECT 1
                FROM product_tag pt
                WHERE pt.code = {code}
            );""".format(**query_arguments)

    @staticmethod
    def generate_product_insert_query(arguments: dict) -> str:
        product_configurations = BranchProductSync._active_product_configurations(arguments).copy()
        product_tag_code = product_configurations.pop("product_tag_configurations", {}).get("code")

        query_arguments = {
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in product_configurations.items()
        }
        query_arguments["product_tag_code"] = f"'{product_tag_code}'"

        return """
            INSERT INTO product (code, name, description, tag, sequence, product_tag_id)
            SELECT
                {code},
                {name},
                {description},
                {tag},
                {sequence},
                product_tag.product_tag_id
            FROM product_tag
            WHERE product_tag.code = {product_tag_code}
            AND NOT EXISTS (
                SELECT 1
                FROM product existing_product
                WHERE existing_product.code = {code}
            );""".format(**query_arguments)

    @staticmethod
    def generate_module_insert_query(arguments: dict) -> str:
        module_configurations = arguments["module_configurations"]
        query_arguments = {
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in module_configurations.items()
        }

        return """
            INSERT INTO module (code, name, description, dependent_modules)
            SELECT
                {code},
                {name},
                {description},
                {dependent_modules}
            WHERE NOT EXISTS (
                SELECT 1
                FROM module existing_module
                WHERE existing_module.code = {code}
            );""".format(**query_arguments)

    @staticmethod
    def generate_product_module_insert_query(arguments: dict) -> str:
        """Global product ↔ module catalogue. Still keyed on module.code in v2."""
        product_configurations = BranchProductSync._active_product_configurations(arguments)
        module_configurations = arguments.get("module_configurations")

        if BranchProductSync._is_module_missing_row(arguments):
            query_arguments = {
                "product_code": f"'{product_configurations['code']}'",
                "sequence": f"'{product_configurations.get('product_module_sequence')}'",
            }

            return """
            INSERT INTO product_module (product_id, module_id, sequence)
            SELECT
                product.product_id,
                NULL,
                {sequence}
            FROM product
            WHERE product.code = {product_code}
            AND NOT EXISTS (
                SELECT 1
                FROM product_module existing_product_module
                WHERE existing_product_module.product_id = product.product_id
                  AND existing_product_module.module_id IS NULL
                  AND existing_product_module.sequence = {sequence}
            );""".format(**query_arguments)

        query_arguments = {
            "product_code": f"'{product_configurations['code']}'",
            "module_code": f"'{module_configurations['code']}'",
            "sequence": f"'{product_configurations.get('product_module_sequence')}'",
        }

        return """
            INSERT INTO product_module (product_id, module_id, sequence)
            SELECT
                product.product_id,
                module.module_id,
                {sequence}
            FROM product
            JOIN module
                ON module.code = {module_code}
            WHERE product.code = {product_code}
            AND NOT EXISTS (
                SELECT 1
                FROM product_module existing_product_module
                WHERE existing_product_module.product_id = product.product_id
                  AND existing_product_module.module_id = module.module_id
            );""".format(**query_arguments)

    @staticmethod
    def generate_transaction_type_master_insert_query(arguments: dict) -> str:
        transaction_type_configuration = arguments["transaction_type_configuration"]
        if not transaction_type_configuration:
            return ""
        query_arguments = {
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in transaction_type_configuration.items()
        }

        return """
            INSERT INTO transaction_type_master (code, name, description, sequence, created_by)
            SELECT
                {code},
                {name},
                {description},
                {transaction_type_master_sequence},
                'SYSTEM'
            WHERE NOT EXISTS (
                SELECT 1
                FROM transaction_type_master existing_transaction_type_master
                WHERE existing_transaction_type_master.code = {code}
            );""".format(**query_arguments)

    @staticmethod
    def generate_product_transaction_type_insert_query(arguments: dict) -> str:
        transaction_type_configuration = arguments["transaction_type_configuration"]
        if not transaction_type_configuration:
            return ""
        product_configurations = BranchProductSync._active_product_configurations(arguments)

        query_arguments = {"product_code": f"'{product_configurations['code']}'"}
        query_arguments.update({
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in transaction_type_configuration.items()
        })

        return """
            INSERT INTO product_transaction_type (product_id, transaction_type_id, sequence, created_by)
            SELECT
                product.product_id,
                transaction_type_master.transaction_type_id,
                {product_transaction_type_sequence},
                'SYSTEM'
            FROM product
            JOIN transaction_type_master
                ON product.code = {product_code}
                AND transaction_type_master.code = {code}
            WHERE NOT EXISTS (
                SELECT 1
                FROM product_transaction_type existing_product_transaction_type
                WHERE existing_product_transaction_type.product_id = product.product_id
                  AND existing_product_transaction_type.transaction_type_id
                      = transaction_type_master.transaction_type_id
            );""".format(**query_arguments)

    def generate_product_transaction_type_module_insert_query(self, arguments: dict) -> str:
        """New in v2: which module a product's transaction type belongs to."""
        transaction_type_configuration = arguments["transaction_type_configuration"]
        module_code = self._module_code(arguments)
        if not transaction_type_configuration or not module_code:
            return ""
        product_configurations = self._active_product_configurations(arguments)

        query_arguments = {
            "product_code": f"'{product_configurations['code']}'",
            "module_code": f"'{module_code}'",
            "code": f"'{transaction_type_configuration['code']}'",
            "sequence": self._nullable(
                transaction_type_configuration.get("product_transaction_type_module_sequence")
                or transaction_type_configuration.get("product_transaction_type_sequence")),
        }

        return """
            INSERT INTO product_transaction_type_module
                (product_transaction_type_id, module_id, sequence, created_by)
            SELECT
                product_transaction_type.product_transaction_type_id,
                module.module_id,
                {sequence},
                'SYSTEM'
            FROM product_transaction_type
            JOIN product
                ON product.product_id = product_transaction_type.product_id
                AND product.code = {product_code}
            JOIN transaction_type_master
                ON transaction_type_master.transaction_type_id = product_transaction_type.transaction_type_id
                AND transaction_type_master.code = {code}
            JOIN module
                ON module.code = {module_code}
            WHERE NOT EXISTS (
                SELECT 1
                FROM product_transaction_type_module existing_product_transaction_type_module
                WHERE existing_product_transaction_type_module.product_transaction_type_id
                          = product_transaction_type.product_transaction_type_id
                  AND existing_product_transaction_type_module.module_id = module.module_id
            );""".format(**query_arguments)

    # ------------------------------------------------------------------ #
    #  Query generators — tenant layer (new in v2)                         #
    # ------------------------------------------------------------------ #

    def generate_tenant_module_insert_query(self, arguments: dict) -> str:
        module_configurations = arguments["module_configurations"]
        query_arguments = {
            "tenant_code": f"'{self.tenant_code}'",
            "code": f"'{module_configurations['code']}'",
            "display_name": self._nullable(module_configurations.get("tenant_module_display_name")),
            "dependent_modules": self._nullable(
                json.dumps(module_configurations["tenant_module_dependent_modules"])
                if isinstance(module_configurations.get("tenant_module_dependent_modules"), (dict, list))
                else module_configurations.get("tenant_module_dependent_modules")),
        }

        return """
            INSERT INTO tenant_module (module_id, tenant_id, display_name, dependent_modules)
            SELECT
                module.module_id,
                tenant.tenant_id,
                {display_name},
                {dependent_modules}
            FROM module
            JOIN tenant
                ON tenant.organization_code = {tenant_code}
            WHERE module.code = {code}
            AND NOT EXISTS (
                SELECT 1
                FROM tenant_module existing_tenant_module
                WHERE existing_tenant_module.module_id = module.module_id
                  AND existing_tenant_module.tenant_id = tenant.tenant_id
            );""".format(**query_arguments)

    def generate_tenant_product_insert_query(self, arguments: dict) -> str:
        """Tenant-level product enablement — the first half of what
        branch_product_module used to express."""
        product_configurations = self._active_product_configurations(arguments)

        is_active = self._flag(product_configurations.get("tenant_product_is_active"), 1)
        default_on = self._flag(product_configurations.get("tenant_product_default_on"), 0)
        # ck_tenant_product_default_requires_active: is_active = 1 OR default_on = 0
        if default_on and not is_active:
            is_active = 1

        query_arguments = {
            **self._get_tenant_arguments(),
            "product_code": f"'{product_configurations['code']}'",
            "is_active": is_active,
            "default_on": default_on,
            "display_name": self._nullable(product_configurations.get("tenant_product_display_name")),
        }

        return """
            INSERT INTO tenant_product
                (tenant_id, product_id, is_active, display_name, default_on, created_by)
            SELECT
                tenant.tenant_id,
                product.product_id,
                {is_active},
                {display_name},
                {default_on},
                'SYSTEM'
            FROM tenant
            JOIN product
                ON product.code = {product_code}
            WHERE tenant.organization_code = {organization_code}
            AND NOT EXISTS (
                SELECT 1
                FROM tenant_product existing_tenant_product
                WHERE existing_tenant_product.tenant_id = tenant.tenant_id
                  AND existing_tenant_product.product_id = product.product_id
            );""".format(**query_arguments)

    def generate_tenant_branch_product_insert_query(self, arguments: dict) -> str:
        """Branch-level product enablement — replaces branch_product_module."""
        product_configurations = self._active_product_configurations(arguments)
        branch_configuration = arguments["branch_configuration"]

        query_arguments = {
            **self._get_tenant_arguments(),
            "product_code": f"'{product_configurations['code']}'",
            "branch_code": f"'{branch_configuration['code']}'",
            "is_active": self._flag(product_configurations.get("tenant_branch_product_is_active"), 1),
            "display_name": self._nullable(
                product_configurations.get("tenant_branch_product_display_name")),
        }

        return """
            INSERT INTO tenant_branch_product
                (tenant_product_id, branch_id, is_active, display_name, created_by)
            SELECT
                tenant_product.id,
                branch.branch_id,
                {is_active},
                {display_name},
                'SYSTEM'
            FROM tenant_product
            JOIN tenant
                ON tenant.tenant_id = tenant_product.tenant_id
                AND tenant.organization_code = {organization_code}
            JOIN product
                ON product.product_id = tenant_product.product_id
                AND product.code = {product_code}
            JOIN branch
                ON branch.tenant_id = tenant.tenant_id
                AND branch.code = {branch_code}
            WHERE NOT EXISTS (
                SELECT 1
                FROM tenant_branch_product existing_tenant_branch_product
                WHERE existing_tenant_branch_product.tenant_product_id = tenant_product.id
                  AND existing_tenant_branch_product.branch_id = branch.branch_id
            );""".format(**query_arguments)

    def generate_tenant_product_transaction_type_insert_query(self, arguments: dict) -> str:
        transaction_type_configuration = arguments["transaction_type_configuration"]
        if not transaction_type_configuration:
            return ""
        product_configurations = self._active_product_configurations(arguments)

        is_active = self._flag(
            transaction_type_configuration.get("tenant_product_transaction_type_is_active"), 1)
        default_on = self._flag(
            transaction_type_configuration.get("tenant_product_transaction_type_default_on"), 1)

        query_arguments = {
            **self._get_tenant_arguments(),
            "product_code": f"'{product_configurations['code']}'",
            "code": f"'{transaction_type_configuration['code']}'",
            "is_active": is_active,
            "default_on": default_on,
            "display_name": self._nullable(
                transaction_type_configuration.get("transaction_type_display_name")),
        }

        return """
            INSERT INTO tenant_product_transaction_type
                (tenant_product_id, product_transaction_type_id, is_active, display_name,
                 default_on, created_by)
            SELECT
                tenant_product.id,
                product_transaction_type.product_transaction_type_id,
                {is_active},
                {display_name},
                {default_on},
                'SYSTEM'
            FROM tenant_product
            JOIN tenant
                ON tenant.tenant_id = tenant_product.tenant_id
                AND tenant.organization_code = {organization_code}
            JOIN product
                ON product.product_id = tenant_product.product_id
                AND product.code = {product_code}
            JOIN product_transaction_type
                ON product_transaction_type.product_id = product.product_id
            JOIN transaction_type_master
                ON transaction_type_master.transaction_type_id
                       = product_transaction_type.transaction_type_id
                AND transaction_type_master.code = {code}
            WHERE NOT EXISTS (
                SELECT 1
                FROM tenant_product_transaction_type existing_tenant_product_transaction_type
                WHERE existing_tenant_product_transaction_type.tenant_product_id = tenant_product.id
                  AND existing_tenant_product_transaction_type.product_transaction_type_id
                          = product_transaction_type.product_transaction_type_id
            );""".format(**query_arguments)

    def generate_tenant_branch_product_transaction_type_insert_query(self, arguments: dict) -> str:
        """Replaces branch_product_transaction_type, now via the tenant layer."""
        transaction_type_configuration = arguments["transaction_type_configuration"]
        if not transaction_type_configuration:
            return ""
        product_configurations = self._active_product_configurations(arguments)
        branch_configuration = arguments["branch_configuration"]

        query_arguments = {
            **self._get_tenant_arguments(),
            "product_code": f"'{product_configurations['code']}'",
            "branch_code": f"'{branch_configuration['code']}'",
            "code": f"'{transaction_type_configuration['code']}'",
            "is_active": self._flag(
                transaction_type_configuration.get(
                    "tenant_branch_product_transaction_type_is_active"), 1),
            "display_name": self._nullable(
                transaction_type_configuration.get("transaction_type_display_name")),
        }

        return """
            INSERT INTO tenant_branch_product_transaction_type
                (tenant_product_transaction_type_id, branch_id, is_active, display_name, created_by)
            SELECT
                tenant_product_transaction_type.id,
                branch.branch_id,
                {is_active},
                {display_name},
                'SYSTEM'
            FROM tenant_product_transaction_type
            JOIN tenant_product
                ON tenant_product.id = tenant_product_transaction_type.tenant_product_id
            JOIN tenant
                ON tenant.tenant_id = tenant_product.tenant_id
                AND tenant.organization_code = {organization_code}
            JOIN product
                ON product.product_id = tenant_product.product_id
                AND product.code = {product_code}
            JOIN product_transaction_type
                ON product_transaction_type.product_transaction_type_id
                       = tenant_product_transaction_type.product_transaction_type_id
            JOIN transaction_type_master
                ON transaction_type_master.transaction_type_id
                       = product_transaction_type.transaction_type_id
                AND transaction_type_master.code = {code}
            JOIN branch
                ON branch.tenant_id = tenant.tenant_id
                AND branch.code = {branch_code}
            WHERE NOT EXISTS (
                SELECT 1
                FROM tenant_branch_product_transaction_type existing_tenant_branch_product_txn
                WHERE existing_tenant_branch_product_txn.tenant_product_transaction_type_id
                          = tenant_product_transaction_type.id
                  AND existing_tenant_branch_product_txn.branch_id = branch.branch_id
            );""".format(**query_arguments)

    def generate_tenant_module_binding_insert_query(self, arguments: dict) -> str:
        """New in v2: scopes a module to a branch / product (and optionally a
        transaction type). Matched against the STORED COALESCE(...,0) columns
        that back uq_tenant_module_config_scope."""
        module_configurations = arguments.get("module_configurations") or {}
        module_code = module_configurations.get("code")
        if not module_code:
            return ""
        product_configurations = self._active_product_configurations(arguments)
        branch_configuration = arguments["branch_configuration"]

        query_arguments = {
            **self._get_tenant_arguments(),
            "module_code": f"'{module_code}'",
            "product_code": f"'{product_configurations['code']}'",
            "branch_code": f"'{branch_configuration['code']}'",
            "sequence": self._nullable(
                module_configurations.get("tenant_module_binding_sequence")
                or product_configurations.get("product_module_sequence")),
            "is_active": self._flag(
                module_configurations.get("tenant_module_binding_is_active"), 1),
        }

        return """
            INSERT INTO tenant_module_binding
                (tenant_id, module_id, branch_id, product_id, transaction_type_id,
                 sequence, is_active, created_by)
            SELECT
                tenant.tenant_id,
                module.module_id,
                branch.branch_id,
                product.product_id,
                NULL,
                {sequence},
                {is_active},
                'SYSTEM'
            FROM tenant
            JOIN module
                ON module.code = {module_code}
            JOIN branch
                ON branch.tenant_id = tenant.tenant_id
                AND branch.code = {branch_code}
            JOIN product
                ON product.code = {product_code}
            WHERE tenant.organization_code = {organization_code}
            AND NOT EXISTS (
                SELECT 1
                FROM tenant_module_binding existing_tenant_module_binding
                WHERE existing_tenant_module_binding.tenant_id = tenant.tenant_id
                  AND existing_tenant_module_binding.module_id = module.module_id
                  AND existing_tenant_module_binding._branch_or_zero = branch.branch_id
                  AND existing_tenant_module_binding._product_or_zero = product.product_id
                  AND existing_tenant_module_binding._txn_type_or_zero = 0
            );""".format(**query_arguments)

    # ------------------------------------------------------------------ #
    #  Orchestration                                                       #
    # ------------------------------------------------------------------ #

    def identify_missing_data(self, row: dict) -> list[str]:
        """Determine which tables require INSERT queries for this row.

        Returns an ordered list respecting foreign key dependencies. Only
        global-catalogue tables are dropped on a destination code match; see
        difference (1) in the module docstring.
        """
        product_configurations = self._active_product_configurations(row)
        module_configurations = row.get("module_configurations")
        branch_configuration = row["branch_configuration"]
        transaction_type_configuration = row.get("transaction_type_configuration")
        is_module_missing_row = self._is_module_missing_row(row)
        has_module_configurations = bool(module_configurations and module_configurations.get("code"))

        required_tables = list(self.SUPPORTED_TABLES)

        validation_errors = []
        if product_configurations.get('parent_product_id'):
            validation_errors.append(
                f"Note: Parent product ID in product table for {product_configurations['code']} exist but need to move manually")
        if branch_configuration.get('country_id'):
            validation_errors.append(
                f"Note: County ID in branch table for {branch_configuration['code']} exist but need to move manually")

        if validation_errors:
            print("\n".join(validation_errors))

        if product_configurations["code"] in self._existing_config_values("product_codes"):
            required_tables = [
                table for table in required_tables
                if table not in self.PRODUCT_RELATIONAL_TABLES
            ]

        # Without a module on the row there is nothing to bind — drop every
        # module-dependent table. `product_module` stays: it has a
        # module_id IS NULL variant, exactly as in v1.
        if is_module_missing_row or not has_module_configurations:
            required_tables = [
                table for table in required_tables
                if table not in self.MODULE_DEPENDENT_TABLES
                and table not in self.MODULE_RELATIONAL_TABLES
            ]
        elif module_configurations["code"] in self._existing_config_values("module_codes"):
            required_tables = [
                table for table in required_tables
                if table not in self.MODULE_RELATIONAL_TABLES
            ]

        if branch_configuration["code"] in self._existing_config_values("branch_codes"):
            required_tables = [
                table for table in required_tables
                if table not in self.BRANCH_RELATIONAL_TABLES
            ]

        if not transaction_type_configuration:
            required_tables = [
                table for table in required_tables
                if table not in self.TRANSACTION_TYPE_DEPENDENT_TABLES
            ]
        elif transaction_type_configuration["code"] in self._existing_config_values(
                "transaction_type_configuration"):
            required_tables = [
                table for table in required_tables
                if table not in self.TRANSACTION_TYPE_TABLES
            ]

        return required_tables

    def generate_query(self, row: dict) -> None:
        for table_name in self.identify_missing_data(row):
            insert_method = getattr(self, f"generate_{table_name}_insert_query")
            self._collect_query(insert_method(row))

    def read_branch_product_backup_csv(self, file_name: str = "branch_product_backup.json") -> None:
        if self.SOURCE_QUERY_RESULT:
            rows = self.SOURCE_QUERY_RESULT
        else:
            with open(file_name, "r") as file:
                rows = json.load(file)

        self._generated_query_set.clear()
        self._generated_queries.clear()
        for row in rows:
            self.generate_query(row)
        self._print_collected_queries()


def generate_source_destination_initial_data_query(tenant_code, branch_codes, product_codes):
    """Emit the source and destination pull queries.

    The source walks the v2 chain
    ``product → tenant_product → tenant_branch_product → branch`` instead of
    ``product_module → branch_product_module``, and picks up the new tenant
    columns. Top-level JSON keys are unchanged (see module docstring); the
    v2-only fields are nested inside the existing configuration objects.

    The destination query is unchanged — every table it reads
    (product, module, transaction_type_master, product_tag, branch) still
    exists with the same shape in v2.
    """
    branch_codes_str = ", ".join([f"'{c.strip()}'" for c in branch_codes if c and c.strip()])
    product_codes_str = ", ".join([f"'{c.strip()}'" for c in product_codes if c and c.strip()])
    tenant_code_str = f"'{tenant_code.strip()}'"
    source_query = """SELECT JSON_ARRAYAGG(
                            JSON_OBJECT(
                                'product_configurations', product_configurations,
                                'module_missing_product_configurations', module_missing_product_configurations,
                                'module_configurations', module_configurations,
                                'transaction_type_configuration', transaction_type_configuration,
                                'branch_configuration', branch_configuration
                            )
                        ) AS result
                        FROM (
                            SELECT
                                JSON_OBJECT(
                                    'product_id', p.product_id,
                                    'name', p.name,
                                    'code', p.code,
                                    'description', p.description,
                                    'tag', p.tag,
                                    'created_by', p.created_by,
                                    'created_at', p.created_at,
                                    'sequence', p.sequence,
                                    'parent_product_id', p.parent_product_id,
                                    'is_inbound', p.is_inbound,
                                    'product_module_sequence', pm.sequence,
                                    'product_tag_configurations',
                                        JSON_OBJECT(
                                            'product_tag_id', pt.product_tag_id,
                                            'name', pt.name,
                                            'code', pt.code,
                                            'sequence', pt.sequence
                                        ),
                                    'supported_file_formats', p.supported_file_formats,
                                    'tenant_product_is_active', tp.is_active,
                                    'tenant_product_default_on', tp.default_on,
                                    'tenant_product_display_name', tp.display_name,
                                    'tenant_branch_product_is_active', tbp.is_active,
                                    'tenant_branch_product_display_name', tbp.display_name
                                ) AS product_configurations,

                                CASE
                                    WHEN pm.module_id IS NULL THEN
                                        JSON_OBJECT(
                                            'product_module_id', pm.product_module_id,
                                            'product_id', p.product_id,
                                            'name', p.name,
                                            'code', p.code,
                                            'description', p.description,
                                            'tag', p.tag,
                                            'created_by', p.created_by,
                                            'created_at', p.created_at,
                                            'sequence', p.sequence,
                                            'parent_product_id', p.parent_product_id,
                                            'is_inbound', p.is_inbound,
                                            'product_module_sequence', pm.sequence,
                                            'product_tag_configurations',
                                                JSON_OBJECT(
                                                    'product_tag_id', pt.product_tag_id,
                                                    'name', pt.name,
                                                    'code', pt.code,
                                                    'sequence', pt.sequence
                                                ),
                                            'supported_file_formats', p.supported_file_formats,
                                            'tenant_product_is_active', tp.is_active,
                                            'tenant_product_default_on', tp.default_on,
                                            'tenant_product_display_name', tp.display_name,
                                            'tenant_branch_product_is_active', tbp.is_active,
                                            'tenant_branch_product_display_name', tbp.display_name
                                        )
                                    ELSE NULL
                                END AS module_missing_product_configurations,

                                CASE
                                    WHEN m.module_id IS NOT NULL THEN
                                        JSON_OBJECT(
                                            'module_id', m.module_id,
                                            'name', m.name,
                                            'description', m.description,
                                            'code', m.code,
                                            'dependent_modules', m.dependent_modules,
                                            'tenant_module_dependent_modules', tm.dependent_modules,
                                            'tenant_module_display_name', tm.display_name,
                                            'tenant_module_binding_sequence', tmb.sequence,
                                            'tenant_module_binding_is_active', tmb.is_active
                                        )
                                    ELSE NULL
                                END AS module_configurations,

                                CASE
                                    WHEN tptt.id IS NOT NULL OR tbptt.id IS NOT NULL THEN
                                        JSON_OBJECT(
                                            'transaction_type_display_name',
                                                COALESCE(tbptt.display_name, tptt.display_name),
                                            'transaction_type_id', tym.transaction_type_id,
                                            'code', tym.code,
                                            'name', tym.name,
                                            'description', tym.description,
                                            'transaction_type_master_sequence', tym.sequence,
                                            'product_transaction_type_sequence', ptt.sequence,
                                            'created_by', tym.created_by,
                                            'product_transaction_type_module_sequence', pttm.sequence,
                                            'tenant_product_transaction_type_is_active', tptt.is_active,
                                            'tenant_product_transaction_type_default_on', tptt.default_on,
                                            'tenant_branch_product_transaction_type_is_active', tbptt.is_active
                                        )
                                    ELSE NULL
                                END AS transaction_type_configuration,

                                JSON_OBJECT(
                                    'name', b.name,
                                    'description', b.description,
                                    'status', b.status,
                                    'created_by', b.created_by,
                                    'code',b.code,
                                    'country_id', b.country_id
                                ) AS branch_configuration


                            FROM (
                                    SELECT *
                                    FROM product
                                    WHERE code IN ({product_codes_str})
                                 ) p

                            JOIN product_tag pt
                                ON pt.product_tag_id = p.product_tag_id

                            JOIN tenant t
                                ON t.organization_code = {tenant_code_str}

                            JOIN tenant_product tp
                                ON tp.product_id = p.product_id
                               AND tp.tenant_id = t.tenant_id

                            JOIN tenant_branch_product tbp
                                ON tbp.tenant_product_id = tp.id

                            JOIN branch b
                                ON b.branch_id = tbp.branch_id
                               AND b.tenant_id = t.tenant_id
                               AND b.code in ({branch_codes_str})

                            LEFT JOIN product_module pm
                                ON pm.product_id = p.product_id

                            LEFT JOIN module m
                                ON m.module_id = pm.module_id

                            LEFT JOIN tenant_module tm
                                ON tm.module_id = m.module_id
                               AND tm.tenant_id = t.tenant_id

                            LEFT JOIN tenant_module_binding tmb
                                ON tmb.tenant_id = t.tenant_id
                               AND tmb.module_id = m.module_id
                               AND tmb.branch_id = b.branch_id
                               AND tmb.product_id = p.product_id

                            LEFT JOIN product_transaction_type ptt
                                ON ptt.product_id = p.product_id

                            LEFT JOIN transaction_type_master tym
                                ON ptt.transaction_type_id = tym.transaction_type_id

                            LEFT JOIN product_transaction_type_module pttm
                                ON pttm.product_transaction_type_id = ptt.product_transaction_type_id
                               AND pttm.module_id = m.module_id

                            LEFT JOIN tenant_product_transaction_type tptt
                                ON tptt.tenant_product_id = tp.id
                               AND tptt.product_transaction_type_id = ptt.product_transaction_type_id

                            LEFT JOIN tenant_branch_product_transaction_type tbptt
                                ON tbptt.tenant_product_transaction_type_id = tptt.id
                               AND tbptt.branch_id = b.branch_id
                        ) x;
                        """
    destination_query_file = """SELECT JSON_OBJECT(
                                'product_codes', (
                                    SELECT JSON_ARRAYAGG(p.code)
                                    FROM product p
                                ),
                                'module_codes', (
                                    SELECT JSON_ARRAYAGG(m.code)
                                    FROM module m
                                ),
                                'transaction_type_configuration', (
                                    SELECT JSON_ARRAYAGG(ttm.code)
                                    FROM transaction_type_master ttm
                                ),
                                'product_tag_codes', (
                                    SELECT JSON_ARRAYAGG(pt.code)
                                    FROM product_tag pt
                                ),
                                'branch_codes', (
                                    SELECT JSON_ARRAYAGG(b.code)
                                    FROM branch b join tenant t on b.tenant_id = t.tenant_id  and t.organization_code = {tenant_code_str}
                                )
                            ) AS result;"""
    formatted_source = source_query.format(
        tenant_code_str=tenant_code_str,
        branch_codes_str=branch_codes_str,
        product_codes_str=product_codes_str
    )
    formatted_destination = destination_query_file.format(
        tenant_code_str=tenant_code_str
    )
    print(f'Source DB query: {formatted_source}')
    print(f'Destination DB query: {formatted_destination}')
