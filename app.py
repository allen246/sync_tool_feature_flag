

from flask import Flask, render_template, request, jsonify, send_file
from config import Config, configure_logging
from services import (branch_service, workflow_service, feature_flag_service, mq_service,
                      tenant_export_service)
from services.common import SCHEMA_VERSION_COOKIE, V2, normalize_version
import io

app = Flask(__name__)
app.config.from_object(Config)
configure_logging(app)


def schema_version():
    """The schema version the caller is on, taken from the version cookie.

    Absent or unrecognised values normalize to v1, so an untouched browser —
    and anything that never learns about the switch — keeps the legacy schema.
    """
    return normalize_version(request.cookies.get(SCHEMA_VERSION_COOKIE))


@app.route("/")
def index():
    # Rendered into <body data-schema-version> so the banner paints in the
    # correct state on first frame instead of flashing after JS reads the cookie.
    return render_template("index.html", schema_version=schema_version())


# ── Branch ──────────────────────────────────────────────────────────────── #

@app.route("/branch/pull", methods=["POST"])
def branch_pull():
    d = request.json
    # Returns {source_query, destination_query} — return directly, no wrapper
    result = branch_service.generate_pull_sql(
        d["tenant"],
        [c.strip() for c in d["branches"].split(",")] if d["branches"] else [],
        [c.strip() for c in d["products"].split(",")] if d["products"] else [],
        schema_version()
    )
    return jsonify(result)


@app.route("/branch/final", methods=["POST"])
def branch_final():
    d = request.json
    sql, notes = branch_service.generate_final(
        d["tenant"], d["source_json"], d["existing_json"], schema_version()
    )
    return jsonify({"result": sql, "notes": notes})


# ── Workflow ─────────────────────────────────────────────────────────────── #

@app.route("/workflow/pull", methods=["POST"])
def workflow_pull():
    d = request.json
    # Returns {source_query, destination_query} — return directly, no wrapper
    result = workflow_service.generate_pull_sql(
        d["tenant"],
        [code.strip() for code in d["branches"].split(",")] if d["branches"] else [],
        [code.strip() for code in d.get("products", "").split(",")] if d.get("products") else [],
        schema_version()
    )
    return jsonify(result)


@app.route("/workflow/final", methods=["POST"])
def workflow_final():
    d = request.json
    r = workflow_service.generate_final(
        d["tenant"],
        [c.strip() for c in d["branches"].split(",")] if d["branches"] else [],
        d["source_json"],
        schema_version()
    )
    return jsonify({"result": r})


# ── Feature Flag ─────────────────────────────────────────────────────────── #

@app.route("/feature-flag/pull", methods=["POST"])
def feature_flag_pull():
    d = request.json
    result = feature_flag_service.generate_pull_sql(d["tenant"], schema_version())
    return jsonify(result)


@app.route("/feature-flag/final", methods=["POST"])
def feature_flag_final():
    d = request.json
    sql, notes = feature_flag_service.generate_final(
        d["tenant"], d["source_json"], d["existing_json"], schema_version()
    )
    return jsonify({"result": sql, "notes": notes})


# ── MQ Comparison ───────────────────────────────────────────────────────── #

@app.route("/mq/compare", methods=["POST"])
def mq_compare():
    d = request.json
    result = mq_service.compare_definitions(d["source_json"], d["destination_json"])
    return jsonify(result)


# ── Full Tenant Export (v2 schema only) ─────────────────────────────────── #

def _require_v2():
    """Guard the tenant-export endpoints.

    The export is built entirely from the v2 registry, so there is nothing
    meaningful it could emit against the legacy schema. Returning an error is
    clearer than silently producing v1-shaped SQL.
    """
    if schema_version() != V2:
        return jsonify({
            "error": "Full Tenant Export requires the multi-tenant (v2) schema. "
                     "Switch version from the header, then retry."
        }), 400
    return None


@app.route("/tenant-export/tables")
def tenant_export_tables():
    guard = _require_v2()
    if guard:
        return guard
    return jsonify(tenant_export_service.table_metadata())


@app.route("/tenant-export/pull", methods=["POST"])
def tenant_export_pull():
    guard = _require_v2()
    if guard:
        return guard
    d = request.json
    return jsonify(tenant_export_service.generate_pull_sql(d["tenant"]))


@app.route("/tenant-export/final", methods=["POST"])
def tenant_export_final():
    guard = _require_v2()
    if guard:
        return guard
    d = request.json
    try:
        result = tenant_export_service.generate_final(
            d["tenant"],
            d.get("source_json"),
            d.get("destination_json"),
            tables=d.get("tables"),
            confirmed=d.get("confirmed"),
        )
    except ValueError as exc:
        return jsonify({"result": "", "notes": [], "stats": {}, "errors": [str(exc)]})
    return jsonify(result)


# ── Download ─────────────────────────────────────────────────────────────── #

@app.route("/download", methods=["POST"])
def download():
    sql = request.json["sql"]
    buf = io.BytesIO(sql.encode())
    return send_file(buf, as_attachment=True, download_name="generated.sql", mimetype="text/sql")


if __name__ == "__main__":
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG)
