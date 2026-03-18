import json
from typing import Any



class WorkflowSync:

    SUPPORTED_TABLES = ['generate_delete_workflow_query', 'generate_workflow_insert_query']

    def __init__(self, tenant_code: str, branch_codes:list):
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
    #  Query generators                                                    #
    # ------------------------------------------------------------------ #


    def generate_workflow_insert_query(self, rows: list[dict]) -> None:
        existing_keys = []
        for row in rows:
            existing_keys.append(f"{row['branch']}-{row['module']}-{row['product']}")
            to_grp_name = "-".join(row.get('to_groups', 'None'))
            from_grp = row.get('from_groups', 'None')
            if row['to_groups']:
                row['to_groups'] = json.dumps(row['to_groups'])
            if row['condition']:
                row['condition'] = json.dumps(row['condition'])
            workflow_name = f"{from_grp}--{to_grp_name}"
            row.update({'tenant_code': self.tenant_code, 'workflow_name': workflow_name})

            insert_workflow_query = """
                INSERT INTO workflow (workflow_name, branch_product_module_id)
                SELECT '{workflow_name}', bpm.tenant_product_module
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
                WHERE b.code = '{branch}'
                  AND p.code = '{product}'
                  AND m.code = '{module}'
                  AND tr.organization_code = '{tenant_code}';
                """.format(**row)

            insert_transition_query = """
                INSERT INTO transition (workflow_id, from_group, to_groups, `condition`, `trigger`, priority)
                SELECT w.workflow_id, '{from_group}', '{to_groups}', '{condition}', '{trigger}', '{priority}' from workflow w
                JOIN branch_product_module bpm
                    ON w.branch_product_module_id = bpm.tenant_product_module
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
                WHERE b.code = '{branch}'
                  AND p.code = '{product}'
                  AND m.code = '{module}'
                  AND tr.organization_code = '{tenant_code}';
                """.format(**row)
            self._collect_query(insert_workflow_query)
            self._collect_query(insert_transition_query)
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


    def generate_query(self, rows: list[dict]) -> None:
        """
        Generate and print all required INSERT queries for a given CSV row.
        """
        self._generated_query_set.clear()
        self._generated_queries.clear()
        for table_name in self.SUPPORTED_TABLES:
            getattr(self, table_name)(rows)
        self._print_collected_queries()

    # FIX 7: Renamed parameter default to .json to match actual usage;
    # docstring previously said .csv but the file was read as JSON.
    def read_workflow_backup(self, file_name: str = "workflow_backup.json") -> None:
        """
        Read the branch product backup JSON file and generate INSERT queries for each row.

        Parameters
        ----------
        file_name : str
            Path to the JSON file. Defaults to ``workflow_backup.json``.
        """
        # FIX 2: SOURCE_QUERY_RESULT is now actually used — rows are sourced
        # from it if already loaded, falling back to reading the file.
        rows = []
        if self.SOURCE_QUERY_RESULT:
            rows = self.SOURCE_QUERY_RESULT
        else:
            with open(file_name, "r") as file:
                rows = json.load(file)

        self.generate_query(rows)


def generate_source_data_query(tenant_code, branch_codes, product_codes=None):
    product_codes = product_codes or []
    branch_codes_str = ", ".join([f"'{branch_code}'" for branch_code in branch_codes if branch_code])
    product_codes_str = ", ".join([f"'{product_code}'" for product_code in product_codes if product_code])
    tenant_code_str = f"'{tenant_code}'"
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
                            'workflow_id', w.workflow_id
                        )
                    ) AS result
                    FROM transition t
                    JOIN workflow w 
                        ON w.workflow_id = t.workflow_id
                    JOIN branch_product_module bpm 
                        ON w.branch_product_module_id = bpm.tenant_product_module
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


if __name__ == "__main__":
    tenant_code = input("Enter tenant code: ")
    branch_codes = [code.strip() for code in input(
        "Enter branch code (Multiple supported with comma separation): "
    ).split(",") if code.strip()]
    product_codes = [code.strip() for code in input(
        "Enter Product Codes (Optional, comma-separated): "
    ).split(",") if code.strip()]
    generate_source_data_query(tenant_code, branch_codes, product_codes)

    workflow_sync = WorkflowSync(tenant_code, branch_codes)

    # FIX 3: Wrap user input with json.loads() so the attributes are
    # parsed dicts/lists, not raw strings.
    # Prompt the user to press Enter to continue
    input(
        "Save the Source QUERY result into workflow_backup.json , then press Enter to proceed...\n")

    try:
        # Open the files and load the JSON data
        with open("workflow_backup.json", "r") as source_file_result:
            workflow_sync.SOURCE_QUERY_RESULT = json.load(source_file_result)

        print("Files loaded successfully.")

    except FileNotFoundError as e:
        print(f"Error: One or more files not found: {e}")
    except json.JSONDecodeError as e:
        print(f"Error: Failed to decode JSON: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

    workflow_sync.read_workflow_backup()
