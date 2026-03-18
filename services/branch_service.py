import io, sys, json, logging
from scripts.branch_product_sync import BranchProductSync, generate_source_destination_initial_data_query


def capture(func, *args):
    buf = io.StringIO()
    sys.stdout = buf
    func(*args)
    sys.stdout = sys.__stdout__
    return buf.getvalue()


def _parse_db_queries(raw: str) -> dict:
    """
    Parse stdout that contains 'Source DB query: ...' and optionally
    'Destination DB query: ...' blocks. Returns dict with source_query
    and destination_query keys (empty string if absent).
    """
    source_query = ""
    destination_query = ""
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("Source DB query:"):
            block = line[len("Source DB query:"):].strip()
            i += 1
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
    return {"source_query": source_query, "destination_query": destination_query}


def generate_pull_sql(t, b, p):
    logging.info("Generating branch pull SQL")
    raw = capture(generate_source_destination_initial_data_query, t, b, p)
    return _parse_db_queries(raw)


def generate_final(t, s, e):
    logging.info("Generating branch final SQL")
    sync = BranchProductSync(t)
    sync.SOURCE_QUERY_RESULT = json.loads(s)
    sync.EXISTING_CONFIG = json.loads(e)
    result = capture(sync.read_branch_product_backup_csv)
    notes = [l for l in result.split("\n") if l.startswith("Note:")]
    sql = "\n".join([l for l in result.split("\n") if not l.startswith("Note:")])
    return sql, notes
