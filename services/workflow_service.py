import io, sys, json, logging
from scripts.workflow_sync import WorkflowSync, generate_source_data_query


def capture(func, *args):
    buf = io.StringIO()
    sys.stdout = buf
    func(*args)
    sys.stdout = sys.__stdout__
    return buf.getvalue()


def _parse_db_queries(raw: str) -> dict:
    """
    Parse stdout that contains 'Source DB query: ...' and optionally
    'Destination DB query: ...' blocks.
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


def generate_pull_sql(t, b, p=None):
    logging.info("Generating workflow pull SQL")
    raw = capture(generate_source_data_query, t, b, p or [])
    return _parse_db_queries(raw)


def generate_final(t, b, s):
    logging.info("Generating workflow final SQL")
    sync = WorkflowSync(t, b)
    sync.SOURCE_QUERY_RESULT = json.loads(s)
    return capture(sync.read_workflow_backup)
