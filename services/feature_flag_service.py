import json
import logging

from services.common import capture, parse_db_queries, script_module, split_notes


def generate_pull_sql(tenant_code: str, version=None):
    """Generate the source and destination feature-flag pull queries.

    Both are emitted by the generator as labelled stdout sections; v1 and v2
    print the same two labels, so the parsing is version-independent.
    """
    logging.info("Generating feature flag pull SQL (schema %s)", version)
    scripts = script_module("feature_flag", version)
    raw = capture(scripts.generate_source_data_query, tenant_code)
    return parse_db_queries(raw)


def generate_final(tenant_code: str, source_json: str, existing_json: str, version=None):
    """Generate the final migration SQL for feature flags.

    Returns ``(sql, notes)``.
    """
    logging.info("Generating feature flag final SQL (schema %s)", version)
    scripts = script_module("feature_flag", version)
    ff = scripts.FeatureFlags(tenant_code)
    ff.SOURCE_QUERY_RESULT = json.loads(source_json)
    ff.EXISTING_CONFIG = json.loads(existing_json)
    return split_notes(capture(ff.read_features_backup))
