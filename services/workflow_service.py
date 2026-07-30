import json
import logging

from services.common import capture, parse_db_queries, script_module


def generate_pull_sql(t, b, p=None, version=None):
    logging.info("Generating workflow pull SQL (schema %s)", version)
    scripts = script_module("workflow_sync", version)
    raw = capture(scripts.generate_source_data_query, t, b, p or [])
    return parse_db_queries(raw)


def generate_final(t, b, s, version=None):
    logging.info("Generating workflow final SQL (schema %s)", version)
    scripts = script_module("workflow_sync", version)
    sync = scripts.WorkflowSync(t, b)
    sync.SOURCE_QUERY_RESULT = json.loads(s)
    return capture(sync.read_workflow_backup)
