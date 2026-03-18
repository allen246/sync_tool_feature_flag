
from flask import Flask, render_template, request, jsonify, send_file
from config import Config, configure_logging
from services import branch_service, workflow_service, feature_flag_service
import io

app = Flask(__name__)
app.config.from_object(Config)
configure_logging(app)


@app.route("/")
def index():
    return render_template("index.html")


# ── Branch ──────────────────────────────────────────────────────────────── #

@app.route("/branch/pull", methods=["POST"])
def branch_pull():
    d = request.json
    # Returns {source_query, destination_query} — return directly, no wrapper
    result = branch_service.generate_pull_sql(
        d["tenant"],
        d["branches"].split(",") if d["branches"] else [],
        d["products"].split(",") if d["products"] else []
    )
    return jsonify(result)


@app.route("/branch/final", methods=["POST"])
def branch_final():
    d = request.json
    sql, notes = branch_service.generate_final(d["tenant"], d["source_json"], d["existing_json"])
    return jsonify({"result": sql, "notes": notes})


# ── Workflow ─────────────────────────────────────────────────────────────── #

@app.route("/workflow/pull", methods=["POST"])
def workflow_pull():
    d = request.json
    # Returns {source_query, destination_query} — return directly, no wrapper
    result = workflow_service.generate_pull_sql(
        d["tenant"],
        [code.strip() for code in d["branches"].split(",")] if d["branches"] else [],
        [code.strip() for code in d.get("products", "").split(",")] if d.get("products") else []
    )
    return jsonify(result)


@app.route("/workflow/final", methods=["POST"])
def workflow_final():
    d = request.json
    r = workflow_service.generate_final(
        d["tenant"],
        d["branches"].split(",") if d["branches"] else [],
        d["source_json"]
    )
    return jsonify({"result": r})


# ── Feature Flag ─────────────────────────────────────────────────────────── #

@app.route("/feature-flag/pull", methods=["POST"])
def feature_flag_pull():
    d = request.json
    result = feature_flag_service.generate_pull_sql(d["tenant"])
    return jsonify(result)


@app.route("/feature-flag/final", methods=["POST"])
def feature_flag_final():
    d = request.json
    sql, notes = feature_flag_service.generate_final(
        d["tenant"], d["source_json"], d["existing_json"]
    )
    return jsonify({"result": sql, "notes": notes})


# ── Download ─────────────────────────────────────────────────────────────── #

@app.route("/download", methods=["POST"])
def download():
    sql = request.json["sql"]
    buf = io.BytesIO(sql.encode())
    return send_file(buf, as_attachment=True, download_name="generated.sql", mimetype="text/sql")


if __name__ == "__main__":
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG)
