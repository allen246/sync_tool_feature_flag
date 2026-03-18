import io, sys, json, logging
from scripts.feature_flag import FeatureFlags, generate_source_data_query


def capture(func, *args):
    buf = io.StringIO()
    sys.stdout = buf
    func(*args)
    sys.stdout = sys.__stdout__
    return buf.getvalue()


def generate_pull_sql(tenant_code: str):
    """
    Calls generate_source_data_query and captures stdout.
    Returns a dict with 'source_query' and 'destination_query' keys.
    The feature_flag.py prints:
        Source DB query: <sql>
        Destination DB query: <sql>
    We parse those two sections out and return them separately.
    """
    logging.info("Generating feature flag pull SQL")
    raw = capture(generate_source_data_query, tenant_code)

    source_query = ""
    destination_query = ""

    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("Source DB query:"):
            # Collect everything after the prefix as the query
            block = line[len("Source DB query:"):].strip()
            i += 1
            # Accumulate until we hit the next labelled section or end
            while i < len(lines) and not lines[i].startswith("Destination DB query:") and not lines[i].startswith("Source DB query:"):
                block += "\n" + lines[i]
                i += 1
            source_query = block.strip()
        elif line.startswith("Destination DB query:"):
            block = line[len("Destination DB query:"):].strip()
            i += 1
            while i < len(lines) and not lines[i].startswith("Source DB query:") and not lines[i].startswith("Destination DB query:"):
                block += "\n" + lines[i]
                i += 1
            destination_query = block.strip()
        else:
            i += 1

    return {
        "source_query": source_query,
        "destination_query": destination_query
    }


def generate_final(tenant_code: str, source_json: str, existing_json: str):
    """
    Generate the final migration SQL for feature flags.
    Returns dict with 'result' (sql) and 'notes' (list of note strings).
    """
    logging.info("Generating feature flag final SQL")
    ff = FeatureFlags(tenant_code)
    ff.SOURCE_QUERY_RESULT = json.loads(source_json)
    ff.EXISTING_CONFIG = json.loads(existing_json)
    raw = capture(ff.read_features_backup)
    notes = [l for l in raw.splitlines() if l.strip().startswith("Note:")]
    sql_lines = [l for l in raw.splitlines() if not l.strip().startswith("Note:")]
    sql = "\n".join(sql_lines).strip()
    return sql, notes
