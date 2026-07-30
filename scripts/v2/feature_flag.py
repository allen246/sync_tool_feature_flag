"""Feature flag sync — multi-tenant (v2) schema.

v1 kept two tables:
    tenant_feature         (tenant_id, feature_id, is_enabled)
    tenant_product_feature (tenant_id, feature_id, product_id, is_enabled)

v2 collapses both into ``tenant_feature_config``, which carries a scope tuple
(branch_id, product_id, transaction_type_id, module_id) where NULL means
"applies to everything at that level":

    tenant-level  → all four scope columns NULL
    product-level → product_id set, the other three NULL

The table has UNIQUE KEY uq_tenant_feature_config_scope over
(tenant_id, feature_id, _branch_or_zero, _product_or_zero,
 _txn_type_or_zero, _module_or_zero) — STORED generated columns that
COALESCE each scope column to 0.
"""

import json

# Restricts a tenant_feature_config row to the *tenant-wide* scope: no branch,
# product, transaction type or module narrowing. Applied to both DELETE and the
# source-pull SELECT so the two stay in agreement.
TENANT_SCOPE = """tfc.branch_id IS NULL
                                  AND tfc.product_id IS NULL
                                  AND tfc.transaction_type_id IS NULL
                                  AND tfc.module_id IS NULL"""

# Restricts to the *product* scope: product_id set, nothing else narrowed.
PRODUCT_SCOPE = """tfc.branch_id IS NULL
                                  AND tfc.transaction_type_id IS NULL
                                  AND tfc.module_id IS NULL"""


class FeatureFlags:
    SUPPORTED_TABLES = ['generate_tenant_feature_query', 'generate_tenant_product_feature_query']

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
        for query in self._generated_queries:
            print(query.replace("'None'", "null"))

    # ------------------------------------------------------------------ #
    #  Query generators                                                    #
    # ------------------------------------------------------------------ #

    def generate_tenant_feature_query(self, source_rows: dict, destination_rows: dict) -> None:
        migrating_features = destination_rows.get('features')
        removed_features = set(destination_rows.get('enabled_tenant_features') or []).difference(
            set(source_rows.get('enabled_tenant_features') or [])).union(
            set(destination_rows.get('disabled_tenant_features') or []).difference(
                set(source_rows.get('disabled_tenant_features') or [])))
        formated_removed_features = ", ".join(
            [f"'{removed_feature}'" for removed_feature in removed_features if removed_feature in migrating_features])
        if formated_removed_features:
            delete_query = """DELETE tfc FROM tenant_feature_config tfc
                                JOIN feature f
                                    ON f.feature_id = tfc.feature_id
                                JOIN tenant t
                                    ON t.tenant_id = tfc.tenant_id
                                WHERE f.name in ({formated_removed_features})
                                  AND t.organization_code = '{tenant_code}'
                                  AND {tenant_scope};""".format(
                tenant_code=self.tenant_code,
                formated_removed_features=formated_removed_features,
                tenant_scope=TENANT_SCOPE)
            self._collect_query(delete_query)

        for enabled_tenant_feature in set(source_rows.get('enabled_tenant_features') or []).difference(
                set(destination_rows.get('enabled_tenant_features') or [])):
            if enabled_tenant_feature in migrating_features:
                self._collect_query(self._tenant_feature_insert(enabled_tenant_feature, 1))

        for disabled_tenant_feature in set(source_rows.get('disabled_tenant_features') or []).difference(
                set(destination_rows.get('disabled_tenant_features') or [])):
            if disabled_tenant_feature in migrating_features:
                self._collect_query(self._tenant_feature_insert(disabled_tenant_feature, 0))

        return

    def _tenant_feature_insert(self, feature_name: str, is_enabled: int) -> str:
        """Tenant-wide flag: every scope column left NULL.

        The NOT EXISTS guards against the unique scope key rather than relying
        on the preceding DELETE — the DELETE only fires for features that
        actually changed state, so an unrelated re-run must stay idempotent.
        """
        return """
                    INSERT INTO tenant_feature_config
                        (tenant_id, feature_id, branch_id, product_id, transaction_type_id, module_id,
                         is_enabled, created_by)
                    SELECT t.tenant_id, f.feature_id, NULL, NULL, NULL, NULL, {is_enabled}, 'SYSTEM'
                    FROM feature f JOIN tenant t
                    WHERE f.name = '{feature_name}'
                      AND t.organization_code = '{tenant_code}'
                      AND NOT EXISTS (
                          SELECT 1
                          FROM tenant_feature_config existing_tenant_feature_config
                          WHERE existing_tenant_feature_config.tenant_id = t.tenant_id
                            AND existing_tenant_feature_config.feature_id = f.feature_id
                            AND existing_tenant_feature_config._branch_or_zero = 0
                            AND existing_tenant_feature_config._product_or_zero = 0
                            AND existing_tenant_feature_config._txn_type_or_zero = 0
                            AND existing_tenant_feature_config._module_or_zero = 0
                      );
                    """.format(tenant_code=self.tenant_code, feature_name=feature_name, is_enabled=is_enabled)

    def generate_tenant_product_feature_query(self, source_rows: dict, destination_rows: dict) -> None:
        migrating_features = destination_rows.get('features')
        removed_feature_products = set(destination_rows.get('enabled_product_features') or []).difference(
            set(source_rows.get('enabled_product_features')) or []).union(
            set(destination_rows.get('disabled_product_features') or []).difference(
                set(source_rows.get('disabled_product_features') or [])))
        for removed_feature_product in removed_feature_products:
            feature_name, product_code = removed_feature_product.split("---")
            if feature_name in migrating_features:
                delete_query = """DELETE tfc FROM tenant_feature_config tfc
                                JOIN tenant t
                                    ON tfc.tenant_id = t.tenant_id
                                    and t.organization_code = '{tenant_code}'
                                JOIN product p
                                    ON p.product_id = tfc.product_id
                                    AND p.name = '{product_code}'
                                JOIN feature f
                                    ON f.feature_id = tfc.feature_id
                                    AND f.name = '{feature_name}'
                                WHERE {product_scope};""".format(tenant_code=self.tenant_code,
                                                                 feature_name=feature_name,
                                                                 product_code=product_code,
                                                                 product_scope=PRODUCT_SCOPE)
                self._collect_query(delete_query)

        for enabled_tenant_product_feature in set(
                source_rows.get('enabled_product_features') or []).difference(
            set(destination_rows.get('enabled_product_features') or [])):
            feature_name, product_code = enabled_tenant_product_feature.split("---")
            if feature_name in migrating_features:
                self._collect_query(self._product_feature_insert(feature_name, product_code, 1))

        for disabled_tenant_product_feature in set(source_rows.get('disabled_product_features') or []).difference(
                set(destination_rows.get('disabled_product_features') or [])):
            feature_name, product_code = disabled_tenant_product_feature.split("---")
            if feature_name in migrating_features:
                self._collect_query(self._product_feature_insert(feature_name, product_code, 0))

        return

    def _product_feature_insert(self, feature_name: str, product_code: str, is_enabled: int) -> str:
        """Product-scoped flag: product_id set, branch/txn-type/module NULL.

        ``p.name`` is matched (not ``p.code``) to stay consistent with the
        ``CONCAT(f.name, '---', p.name)`` key built by the source pull query.
        """
        return """
                    INSERT INTO tenant_feature_config
                        (tenant_id, feature_id, branch_id, product_id, transaction_type_id, module_id,
                         is_enabled, created_by)
                    SELECT t.tenant_id, f.feature_id, NULL, p.product_id, NULL, NULL, {is_enabled}, 'SYSTEM'
                    FROM tenant t
                    JOIN product p
                        ON t.organization_code = '{tenant_code}'
                        AND p.name = '{product_code}'
                    JOIN feature f
                        ON f.name = '{feature_name}'
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM tenant_feature_config existing_tenant_feature_config
                        WHERE existing_tenant_feature_config.tenant_id = t.tenant_id
                          AND existing_tenant_feature_config.feature_id = f.feature_id
                          AND existing_tenant_feature_config._branch_or_zero = 0
                          AND existing_tenant_feature_config._product_or_zero = p.product_id
                          AND existing_tenant_feature_config._txn_type_or_zero = 0
                          AND existing_tenant_feature_config._module_or_zero = 0
                    );""".format(tenant_code=self.tenant_code,
                                 feature_name=feature_name,
                                 product_code=product_code,
                                 is_enabled=is_enabled)

    # ------------------------------------------------------------------ #
    #  Orchestration                                                       #
    # ------------------------------------------------------------------ #

    def generate_query(self, source_rows: list[dict], destination_rows) -> None:
        self._generated_query_set.clear()
        self._generated_queries.clear()
        for table_name in self.SUPPORTED_TABLES:
            getattr(self, table_name)(source_rows, destination_rows)
        self._print_collected_queries()

    def read_features_backup(
            self,
            source_file_name: str = "feature_flag_backup.json",
            destination_file_name: str = "feature_flag_existing_config.json",
    ) -> None:
        if self.SOURCE_QUERY_RESULT:
            source_rows = self.SOURCE_QUERY_RESULT
        else:
            with open(source_file_name, "r") as source_file:
                source_rows = json.load(source_file)

        if self.EXISTING_CONFIG:
            destination_rows = self.EXISTING_CONFIG
        else:
            with open(destination_file_name, "r") as destination_file:
                destination_rows = json.load(destination_file)

        self.generate_query(source_rows, destination_rows)


def generate_source_data_query(tenant_code):
    """Emit the source/destination pull query.

    The JSON keys are identical to v1 so the frontend and the diff logic need
    no changes — only the tables underneath moved to tenant_feature_config.
    """
    tenant_code_str = f"'{tenant_code}'"
    source_query = """SELECT JSON_OBJECT(
                    'features', (
                        SELECT JSON_ARRAYAGG(f.name)
                        FROM feature f
                    ),
                    'enabled_tenant_features', (
                        SELECT JSON_ARRAYAGG(f.name)
                        FROM tenant t
                        JOIN tenant_feature_config tfc
                            ON tfc.tenant_id = t.tenant_id
                           AND tfc.is_enabled = 1
                           AND {tenant_scope}
                        JOIN feature f
                            ON f.feature_id = tfc.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                    ),
                    'disabled_tenant_features', (
                        SELECT JSON_ARRAYAGG(f.name)
                        FROM tenant t
                        JOIN tenant_feature_config tfc
                            ON tfc.tenant_id = t.tenant_id
                           AND {tenant_scope}
                        JOIN feature f
                            ON f.feature_id = tfc.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                          AND (tfc.is_enabled IS NULL OR tfc.is_enabled = 0)
                    ),
                    'enabled_product_features', (
                        SELECT JSON_ARRAYAGG(CONCAT(f.name, '---', p.name))
                        FROM tenant t
                        JOIN tenant_feature_config tfc
                            ON tfc.tenant_id = t.tenant_id
                           AND tfc.is_enabled = 1
                           AND tfc.product_id IS NOT NULL
                           AND {product_scope}
                        JOIN product p
                            ON p.product_id = tfc.product_id
                        JOIN feature f
                            ON f.feature_id = tfc.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                    ),
                    'disabled_product_features', (
                        SELECT JSON_ARRAYAGG(CONCAT(f.name, '---', p.name))
                        FROM tenant t
                        JOIN tenant_feature_config tfc
                            ON tfc.tenant_id = t.tenant_id
                           AND tfc.product_id IS NOT NULL
                           AND {product_scope}
                        JOIN product p
                            ON p.product_id = tfc.product_id
                        JOIN feature f
                            ON f.feature_id = tfc.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                          AND (tfc.is_enabled IS NULL OR tfc.is_enabled = 0)
                    )
                ) AS result;""".format(tenant_code_str=tenant_code_str,
                                       tenant_scope=TENANT_SCOPE,
                                       product_scope=PRODUCT_SCOPE)
    print(f"Source DB query: {source_query}")
    print(f"Destination DB query: {source_query}")
