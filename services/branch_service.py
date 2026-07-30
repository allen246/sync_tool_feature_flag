import json
import logging

from services.common import capture, parse_db_queries, script_module, split_notes


def generate_pull_sql(t, b, p, version=None):
    logging.info("Generating branch pull SQL (schema %s)", version)
    scripts = script_module("branch_product_sync", version)
    raw = capture(scripts.generate_source_destination_initial_data_query, t, b, p)
    return parse_db_queries(raw)


def generate_final(t, s, e, version=None):
    logging.info("Generating branch final SQL (schema %s)", version)
    scripts = script_module("branch_product_sync", version)
    sync = scripts.BranchProductSync(t)
    sync.SOURCE_QUERY_RESULT = json.loads(s)
    sync.EXISTING_CONFIG = json.loads(e)
    return split_notes(capture(sync.read_branch_product_backup_csv))
