import json


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
            delete_query = """DELETE tf FROM tenant_feature tf
                                JOIN feature f 
                                    ON f.feature_id = tf.feature_id
                                JOIN tenant t 
                                    ON t.tenant_id = tf.tenant_id
                                WHERE f.name in ({formated_removed_features})
                                  AND t.organization_code = '{tenant_code}';""".format(tenant_code=self.tenant_code,
                                                                                       formated_removed_features=formated_removed_features)
            self._collect_query(delete_query)
        for enabled_tenant_feature in set(source_rows.get('enabled_tenant_features') or []).difference(
                set(destination_rows.get('enabled_tenant_features') or [])):
            if enabled_tenant_feature in migrating_features:
                insert_enabled_tenant_feature_query = """
                    INSERT INTO tenant_feature (tenant_id, feature_id, is_enabled)
                    SELECT t.tenant_id, f.feature_id, 1
                    FROM feature f JOIN tenant t 
                    WHERE f.name = '{enabled_tenant_feature}'
                      AND t.organization_code = '{tenant_code}';
                    """.format(tenant_code=self.tenant_code, enabled_tenant_feature=enabled_tenant_feature)
                self._collect_query(insert_enabled_tenant_feature_query)

        for disabled_tenant_feature in set(source_rows.get('disabled_tenant_features') or []).difference(
                set(destination_rows.get('disabled_tenant_features') or [])):
            if disabled_tenant_feature in migrating_features:
                insert_disabled_tenant_feature_query = """
                    INSERT INTO tenant_feature (tenant_id, feature_id, is_enabled)
                    SELECT t.tenant_id, f.feature_id, 0
                    FROM feature f JOIN tenant t 
                    WHERE f.name = '{disabled_tenant_feature}'
                      AND t.organization_code = '{tenant_code}';
                    """.format(tenant_code=self.tenant_code, disabled_tenant_feature=disabled_tenant_feature)
                self._collect_query(insert_disabled_tenant_feature_query)

        return

    def generate_tenant_product_feature_query(self, source_rows: dict, destination_rows: dict) -> None:
        migrating_features = destination_rows.get('features')
        removed_feature_products = set(destination_rows.get('enabled_product_features') or []).difference(
            set(source_rows.get('enabled_product_features')) or []).union(
            set(destination_rows.get('disabled_product_features') or []).difference(
                set(source_rows.get('disabled_product_features') or [])))
        for removed_feature_product in removed_feature_products:
            feature_name, product_code = removed_feature_product.split("---")
            if feature_name in migrating_features:
                delete_query = """DELETE tpf FROM tenant_product_feature tpf 
                                JOIN tenant t
                                    ON tpf.tenant_id = t.tenant_id 
                                    and t.organization_code = '{tenant_code}'
                                JOIN product p 
                                    ON p.product_id = tpf.product_id
                                    AND p.name = '{product_code}'
                                JOIN feature f 
                                    ON f.feature_id = tpf.feature_id
                                    AND f.name = '{feature_name}';""".format(tenant_code=self.tenant_code,
                                                                             feature_name=feature_name,
                                                                             product_code=product_code)
                self._collect_query(delete_query)

        for enabled_tenant_product_feature in set(
                source_rows.get('enabled_product_features') or []).difference(
            set(destination_rows.get('enabled_product_features') or [])):
            feature_name, product_code = enabled_tenant_product_feature.split("---")
            if feature_name in migrating_features:
                insert_enabled_tenant_feature_query = """
                    INSERT INTO tenant_product_feature (tenant_id, feature_id, product_id, is_enabled)
                    SELECT t.tenant_id, f.feature_id, p.product_id, 1
                    FROM tenant t
                    JOIN product p 
                        ON t.organization_code = '{tenant_code}'
                        AND p.name = '{product_code}'
                    JOIN feature f 
                        ON f.name = '{feature_name}';""".format(tenant_code=self.tenant_code,
                                                                 feature_name=feature_name,
                                                                 product_code=product_code)
                self._collect_query(insert_enabled_tenant_feature_query)

        for disabled_tenant_product_feature in set(source_rows.get('disabled_product_features') or []).difference(
                set(destination_rows.get('disabled_product_features') or [])):
            feature_name, product_code = disabled_tenant_product_feature.split("---")
            if feature_name in migrating_features:
                insert_enabled_tenant_feature_query = """
                    INSERT INTO tenant_product_feature (tenant_id, feature_id, product_id, is_enabled)
                    SELECT t.tenant_id, f.feature_id, p.product_id, 0
                    FROM tenant t
                    JOIN product p 
                        ON t.organization_code = '{tenant_code}'
                        AND p.name = '{product_code}'
                    JOIN feature f 
                        ON f.name = '{feature_name}';""".format(tenant_code=self.tenant_code,
                                                                 feature_name=feature_name,
                                                                 product_code=product_code)
                self._collect_query(insert_enabled_tenant_feature_query)

        return

    def generate_delete_workflow_query(self, rows: list[dict]) -> None:
        branches = set()
        products = set()
        modules = set()
        for row in rows:
            branches.add(row['branch'])
            products.add(row['product'])
            modules.add(row['module'])

        branches_str = ", ".join(f"'{b}'" for b in branches)
        products_str = ", ".join(f"'{p}'" for p in products)
        modules_str = ", ".join(f"'{m}'" for m in modules)

        generated_query = """
        DELETE FROM workflow
        WHERE branch_product_module_id IN (
            SELECT bpm.tenant_product_module
            FROM branch_product_module bpm
            JOIN branch b
                ON bpm.branch_id = b.branch_id
            JOIN product_module pm
                ON bpm.product_module_id = pm.product_module_id
            JOIN product p
                ON p.product_id = pm.product_id
            JOIN module m
                ON m.module_id = pm.module_id
            JOIN tenant tr
                ON tr.tenant_id = b.tenant_id
            WHERE b.code IN ({branches})
              AND p.code IN ({products})
              AND m.code IN ({modules})
              AND tr.organization_code = '{tenant_code}'
        );
        """.format(
            modules=modules_str,
            products=products_str,
            branches=branches_str,
            tenant_code=self.tenant_code
        )
        self._collect_query(generated_query)
        return

    # ------------------------------------------------------------------ #
    #  Orchestration                                                       #
    # ------------------------------------------------------------------ #

    def generate_query(self, source_rows: list[dict], destination_rows) -> None:
        """
        Generate and print all required INSERT queries for a given CSV row.
        """
        self._generated_query_set.clear()
        self._generated_queries.clear()
        for table_name in self.SUPPORTED_TABLES:
            getattr(self, table_name)(source_rows, destination_rows)
        self._print_collected_queries()

    # FIX 7: Renamed parameter default to .json to match actual usage;
    # docstring previously said .csv but the file was read as JSON.

    def read_features_backup(
            self,
            source_file_name: str = "feature_flag_backup.json",
            destination_file_name: str = "feature_flag_existing_config.json",
    ) -> None:
        """
        Read the source and destination feature flag JSON files and
        generate INSERT queries based on their contents.

        Parameters
        ----------
        source_file_name : str, optional
            Path to the source backup JSON file.
            Defaults to "feature_flag_backup.json".

        destination_file_name : str, optional
            Path to the destination existing config JSON file.
            Defaults to "feature_flag_existing_config.json".
        """

        # Load source rows (prefer in-memory data if available)
        if self.SOURCE_QUERY_RESULT:
            source_rows = self.SOURCE_QUERY_RESULT
        else:
            with open(source_file_name, "r") as source_file:
                source_rows = json.load(source_file)

        # Load destination rows (prefer in-memory data if available)
        if self.EXISTING_CONFIG:
            destination_rows = self.EXISTING_CONFIG
        else:
            with open(destination_file_name, "r") as destination_file:
                destination_rows = json.load(destination_file)

        # Pass both datasets to query generator
        self.generate_query(source_rows, destination_rows)


def generate_source_data_query(tenant_code):
    tenant_code_str = f"'{tenant_code}'"
    source_query = """SELECT JSON_OBJECT(
                    'features', (
                        SELECT JSON_ARRAYAGG(f.name)
                        FROM feature f
                    ),
                    'enabled_tenant_features', (
                        SELECT JSON_ARRAYAGG(f.name)
                        FROM tenant t
                        JOIN tenant_feature tf 
                            ON tf.tenant_id = t.tenant_id 
                           AND tf.is_enabled = 1
                        JOIN feature f 
                            ON f.feature_id = tf.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                    ),
                    'disabled_tenant_features', (
                        SELECT JSON_ARRAYAGG(f.name)
                        FROM tenant t
                        JOIN tenant_feature tf 
                            ON tf.tenant_id = t.tenant_id 
                        JOIN feature f 
                            ON f.feature_id = tf.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                          AND (tf.is_enabled IS NULL OR tf.is_enabled = 0)
                    ),
                    'enabled_product_features', (
                        SELECT JSON_ARRAYAGG(CONCAT(f.name, '---', p.name))
                        FROM tenant t
                        JOIN tenant_product_feature tpf 
                            ON tpf.tenant_id = t.tenant_id 
                           AND tpf.is_enabled = 1
                        JOIN product p 
                            ON p.product_id = tpf.product_id
                        JOIN feature f 
                            ON f.feature_id = tpf.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                    ),
                    'disabled_product_features', (
                        SELECT JSON_ARRAYAGG(CONCAT(f.name, '---', p.name))
                        FROM tenant t
                        JOIN tenant_product_feature tpf 
                            ON tpf.tenant_id = t.tenant_id 
                        JOIN product p 
                            ON p.product_id = tpf.product_id
                        JOIN feature f 
                            ON f.feature_id = tpf.feature_id
                        WHERE t.organization_code = {tenant_code_str}
                          AND (tpf.is_enabled IS NULL OR tpf.is_enabled = 0)
                    )
                ) AS result;""".format(tenant_code_str=tenant_code_str)
    print(f"Source DB query: {source_query}")
    print(f"Destination DB query: {source_query}")


if __name__ == "__main__":
    tenant_code = input("Enter tenant code: ")

    generate_source_data_query(tenant_code)

    feature_flag_sync = FeatureFlags(tenant_code)

    # FIX 3: Wrap user input with json.loads() so the attributes are
    # parsed dicts/lists, not raw strings.
    # Prompt the user to press Enter to continue
    input(
        "Save the Source QUERY result into branch_product_backup.json and Destination file result into existing_config.json file, then press Enter to proceed...\n")

    try:
        # Open the files and load the JSON data
        with open("feature_flag_backup.json", "r") as source_file_result, \
                open("feature_flag_existing_config.json", "r") as destination_file_result:
            feature_flag_sync.SOURCE_QUERY_RESULT = json.load(source_file_result)
            feature_flag_sync.EXISTING_CONFIG = json.load(destination_file_result)

        print("Files loaded successfully.")

    except FileNotFoundError as e:
        print(f"Error: One or more files not found: {e}")
    except json.JSONDecodeError as e:
        print(f"Error: Failed to decode JSON: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

    feature_flag_sync.read_features_backup()
