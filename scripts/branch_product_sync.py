import json
from typing import Any


class BranchProductSync:
    PRODUCT_RELATIONAL_TABLES = frozenset([
        "product_tag", "product"])

    BRANCH_RELATIONAL_TABLES = frozenset([
        "branch"
    ])

    # BRANCH_PRODUCT_TABLES = frozenset(
    #     ["branch_product_transaction_type", "product_transaction_type", "transaction_type_master"])

    TRANSACTION_TYPE_TABLES = frozenset(
        ["transaction_type_master"])

    MODULE_RELATIONAL_TABLES = frozenset(["module", "tenant_module"])

    SUPPORTED_TABLES = [
        # Order matters: dependencies must be inserted before dependents.
        "branch",
        "product_tag",
        "product",
        "module",
        "tenant_module",
        "product_module",
        "transaction_type_master",
        "product_transaction_type",
        "branch_product_transaction_type",
        "branch_product_module",
    ]

    def __init__(self, tenant_code: str):
        self.tenant_code = tenant_code
        # FIX 1: Moved mutable defaults from class level to instance level
        # to prevent shared state across instances.
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
    #  Helpers                                                             #
    # ------------------------------------------------------------------ #

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

    # ------------------------------------------------------------------ #
    #  Query generators                                                    #
    # ------------------------------------------------------------------ #

    def generate_branch_product_transaction_type_insert_query(self, arguments: dict) -> str:
        transaction_type_configuration = arguments["transaction_type_configuration"]
        if not transaction_type_configuration:
            return ""
        product_configurations = arguments["product_configurations"]
        branch_configuration = arguments["branch_configuration"]

        query_arguments = {
            **self._get_tenant_arguments(),
            "product_code": f"'{product_configurations['code']}'",
            "branch_code": f"'{branch_configuration['code']}'",
        }
        query_arguments.update({
            key: self._serialize_value(value)
            for key, value in transaction_type_configuration.items()
        })

        return """
            INSERT INTO branch_product_transaction_type
                (product_transaction_type_id, branch_id, transaction_type_display_name, created_by)
            SELECT
                product_transaction_type.product_transaction_type_id,
                branch.branch_id,
                {transaction_type_display_name},
                'SYSTEM'
            FROM product_transaction_type
            JOIN product
                ON product.product_id = product_transaction_type.product_id
                AND product.code = {product_code}
            JOIN transaction_type_master
                ON transaction_type_master.transaction_type_id = product_transaction_type.transaction_type_id
                AND transaction_type_master.code = {code}
            JOIN branch
                ON branch.code = {branch_code}
            JOIN tenant
                ON tenant.organization_code = {organization_code}
                AND branch.tenant_id = tenant.tenant_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM branch_product_transaction_type existing_branch_product_transaction_type
                WHERE existing_branch_product_transaction_type.branch_id = branch.branch_id
                  AND existing_branch_product_transaction_type.product_transaction_type_id
                      = product_transaction_type.product_transaction_type_id
            );""".format(**query_arguments)

    @staticmethod
    def generate_product_transaction_type_insert_query(arguments: dict) -> str:
        transaction_type_configuration = arguments["transaction_type_configuration"]
        if not transaction_type_configuration:
            return ""
        product_configurations = arguments["product_configurations"]

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

    def generate_tenant_module_insert_query(self, arguments: dict) -> str:
        module_configurations = arguments["module_configurations"]
        query_arguments = {"tenant_code": f"'{self.tenant_code}'"}
        query_arguments.update({
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in module_configurations.items()
        })

        return """
            INSERT INTO tenant_module (module_id, tenant_id, dependent_modules)
            SELECT
                module.module_id,
                tenant.tenant_id,
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

    def generate_branch_insert_query(self, arguments: dict) -> str:
        branch_configuration = arguments["branch_configuration"]
        query_arguments = {
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in branch_configuration.items()
        }
        query_arguments.update({"tenant_code": f"'{self.tenant_code}'"})

        # FIX 4: Column name corrected from `dependent_modules` to `status`
        # to match both the docstring and the branch_configuration schema.
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
    def generate_product_tag_insert_query(arguments: dict) -> str:
        product_configurations = arguments["product_configurations"]
        module_configurations = arguments["module_configurations"]
        product_tag_configurations = product_configurations.get("product_tag_configurations", {})

        query_arguments = {"module_name": f"'{module_configurations['name']}'"}
        query_arguments.update({
            key: (f"'{json.dumps(value)}'" if isinstance(value, dict) else f"'{value}'")
            for key, value in product_tag_configurations.items()
        })

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
        # FIX 6: Use .get() instead of .pop() to avoid mutating the caller's dict.
        # A shallow copy is made so subsequent formatting is safe.
        product_configurations = arguments["product_configurations"].copy()
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

    def generate_branch_product_module_insert_query(self, arguments: dict) -> str:
        product_configurations = arguments["product_configurations"]
        module_configurations = arguments["module_configurations"]
        branch_configuration = arguments["branch_configuration"]

        query_arguments = {
            **self._get_tenant_arguments(),
            "product_code": f"'{product_configurations['code']}'",
            "module_name": f"'{module_configurations['name']}'",
            "branch_code": f"'{branch_configuration['code']}'",
        }

        return """
            INSERT INTO branch_product_module (product_module_id, branch_id, created_by)
            SELECT
                product_module.product_module_id,
                branch.branch_id,
                'SYSTEM'
            FROM product_module
            JOIN product
                ON product.product_id = product_module.product_id
            JOIN module
                ON module.module_id = product_module.module_id
            JOIN branch
                ON branch.code = {branch_code}
            JOIN tenant
                ON tenant.tenant_id = branch.tenant_id
                AND tenant.organization_code = {organization_code}
            WHERE product.code = {product_code}
              AND module.name = {module_name}
            AND NOT EXISTS (
                SELECT 1
                FROM branch_product_module existing_branch_product_module
                WHERE existing_branch_product_module.product_module_id = product_module.product_module_id
                  AND existing_branch_product_module.branch_id = branch.branch_id
            );""".format(**query_arguments)

    @staticmethod
    def generate_product_module_insert_query(arguments: dict) -> str:
        product_configurations = arguments["product_configurations"]
        module_configurations = arguments["module_configurations"]

        query_arguments = {
            "product_code": f"'{product_configurations['code']}'",
            "module_name": f"'{module_configurations['name']}'",
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
                ON module.name = {module_name}
            WHERE product.code = {product_code}
            AND NOT EXISTS (
                SELECT 1
                FROM product_module existing_product_module
                WHERE existing_product_module.product_id = product.product_id
                  AND existing_product_module.module_id = module.module_id
            );""".format(**query_arguments)

    # ------------------------------------------------------------------ #
    #  Orchestration                                                       #
    # ------------------------------------------------------------------ #

    def identify_missing_data(self, row: dict) -> list[str]:
        """
        Determine which tables require INSERT queries based on whether
        the product and module codes already exist in the system config.

        Returns an ordered list respecting foreign key dependencies.
        """
        product_configurations = row["product_configurations"]
        module_configurations = row["module_configurations"]
        branch_configuration = row["branch_configuration"]
        transaction_type_configuration = row["transaction_type_configuration"]

        # FIX 5: Use a list (not set) so insertion order is deterministic
        # and foreign key dependencies are always satisfied.
        required_tables = list(self.SUPPORTED_TABLES)

        validation_errors = []
        if product_configurations['parent_product_id']:
            validation_errors.append(f"Note: Parent product ID in product table for {product_configurations['code']} exist but need to move manually")
        if branch_configuration['country_id']:
            validation_errors.append(f"Note: County ID in branch table for {branch_configuration['code']} exist but need to move manually")

        if validation_errors:
            print("\n".join(validation_errors))

        if product_configurations["code"] in self.EXISTING_CONFIG.get("product_codes", []):
            required_tables = [
                table for table in required_tables
                if table not in self.PRODUCT_RELATIONAL_TABLES
            ]

        if module_configurations["code"] in self.EXISTING_CONFIG.get("module_codes", []):
            required_tables = [
                table for table in required_tables
                if table not in self.MODULE_RELATIONAL_TABLES
            ]

        if branch_configuration["code"] in self.EXISTING_CONFIG.get("branch_codes", []):
            required_tables = [
                table for table in required_tables
                if table not in self.BRANCH_RELATIONAL_TABLES
            ]

        if transaction_type_configuration and transaction_type_configuration["code"] in self.EXISTING_CONFIG.get("transaction_type_configuration", []):
            required_tables = [
                table for table in required_tables
                if table not in self.TRANSACTION_TYPE_TABLES
            ]

        # if branch_configuration["code"] in self.EXISTING_CONFIG.get("branch_codes", []) and product_configurations["code"] in self.EXISTING_CONFIG.get("product_codes", []):
        #     required_tables = [
        #         table for table in required_tables
        #         if table not in self.BRANCH_PRODUCT_TABLES
        #     ]

        return required_tables

    def generate_query(self, row: dict) -> None:
        """
        Generate and print all required INSERT queries for a given CSV row.
        """
        for table_name in self.identify_missing_data(row):
            insert_method = getattr(self, f"generate_{table_name}_insert_query")
            self._collect_query(insert_method(row))

    # FIX 7: Renamed parameter default to .json to match actual usage;
    # docstring previously said .csv but the file was read as JSON.
    def read_branch_product_backup_csv(self, file_name: str = "branch_product_backup.json") -> None:
        """
        Read the branch product backup JSON file and generate INSERT queries for each row.

        Parameters
        ----------
        file_name : str
            Path to the JSON file. Defaults to ``branch_product_backup.json``.
        """
        # FIX 2: SOURCE_QUERY_RESULT is now actually used — rows are sourced
        # from it if already loaded, falling back to reading the file.
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
    branch_codes_str = ", ".join([f"'{branch_code}'" for branch_code in branch_codes])
    product_codes_str = ", ".join([f"'{product_code}'" for product_code in product_codes])
    tenant_code_str = f"'{tenant_code}'"
    source_query = """SELECT JSON_ARRAYAGG(
                            JSON_OBJECT(
                                'product_configurations', product_configurations,
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
                                    'supported_file_formats', p.supported_file_formats
                                ) AS product_configurations,
                        
                                JSON_OBJECT(
                                    'module_id', m.module_id,
                                    'name', m.name,
                                    'description', m.description,
                                    'code', m.code,
                                    'dependent_modules', m.dependent_modules,
                                    'tenant_module_dependent_modules', tm.dependent_modules
                                ) AS module_configurations,
                        
                                bpm.eligibility_config AS branch_product_module_eligibility_config,
                        
                                JSON_OBJECT(
                                    'transaction_type_display_name', bpt.transaction_type_display_name,
                                    'transaction_type_id', tym.transaction_type_id,
                                    'code', tym.code,
                                    'name', tym.name,
                                    'description', tym.description,
                                    'transaction_type_master_sequence', tym.sequence,
                                    'product_transaction_type_sequence', ptt.sequence,
                                    'created_by', tym.created_by
                                ) AS transaction_type_configuration,
                        
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
                        
                            JOIN product_module pm
                                ON pm.product_id = p.product_id
                        
                            JOIN module m
                                ON m.module_id = pm.module_id
                        
                            JOIN branch_product_module bpm
                                ON bpm.product_module_id = pm.product_module_id
                        
                            JOIN branch b
                                ON b.branch_id = bpm.branch_id
                               AND b.code in ({branch_codes_str})
                        
                            JOIN tenant t
                                ON t.tenant_id = b.tenant_id
                               AND t.organization_code = {tenant_code_str}
                        
                            LEFT JOIN tenant_module tm
                               ON tm.module_id = m.module_id
                               AND tm.tenant_id = t.tenant_id
                        
                            LEFT JOIN product_transaction_type ptt
                                ON ptt.product_id = p.product_id
                        
                            LEFT JOIN transaction_type_master tym
                                ON ptt.transaction_type_id = tym.transaction_type_id
                        
                            JOIN branch_product_transaction_type bpt
                               ON bpt.product_transaction_type_id = ptt.product_transaction_type_id
                               AND b.branch_id = bpt.branch_id
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


if __name__ == "__main__":
    tenant_code = input("Enter tenant code: ")
    branch_codes = input("Enter branch code (Multiple supported with comma separation): ").split(",")
    product_codes = input("Enter product code (Multiple supported with comma separation): ").split(",")
    generate_source_destination_initial_data_query(tenant_code, branch_codes, product_codes)

    branch_product_sync = BranchProductSync(tenant_code)

    # FIX 3: Wrap user input with json.loads() so the attributes are
    # parsed dicts/lists, not raw strings.
    # Prompt the user to press Enter to continue
    input(
        "Save the Source QUERY result into branch_product_backup.json and Destination file result into existing_config.json file, then press Enter to proceed...\n")

    try:
        # Open the files and load the JSON data
        with open("branch_product_backup.json", "r") as source_file_result, \
                open("existing_config.json", "r") as destination_file_result:

            branch_product_sync.SOURCE_QUERY_RESULT = json.load(source_file_result)
            branch_product_sync.EXISTING_CONFIG = json.load(destination_file_result)

        print("Files loaded successfully.")

    except FileNotFoundError as e:
        print(f"Error: One or more files not found: {e}")
    except json.JSONDecodeError as e:
        print(f"Error: Failed to decode JSON: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

    branch_product_sync.read_branch_product_backup_csv()
