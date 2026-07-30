"""Small SQL text helpers shared by the v2 generators.

Deliberately tiny: this tool emits SQL as text for a human to review and run,
it never opens a database connection, so there is no driver to delegate
quoting to.
"""

import json

# Values that mean "absent" once a row has been through JSON export, a CSV
# round-trip, or a hand edit in the table preview.
_BLANKS = ("", "none", "null")


def is_blank(value) -> bool:
    """True when a value should be treated as SQL NULL."""
    return value is None or str(value).strip().lower() in _BLANKS


def literal(value) -> str:
    """Quote a Python value as a SQL literal, mapping blanks onto bare NULL.

    Dicts and lists are JSON-encoded, because the v2 schema stores them in
    longtext columns with a json_valid() CHECK constraint.
    """
    if is_blank(value):
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (dict, list)):
        return escape(json.dumps(value, sort_keys=True))
    return escape(str(value))


def escape(text: str) -> str:
    """Single-quote a string, escaping quotes and backslashes."""
    return "'{0}'".format(str(text).replace("\\", "\\\\").replace("'", "''"))


# Column names in the v2 schema that collide with SQL keywords.
_RESERVED = {"condition", "trigger", "value", "sequence", "status", "priority",
             "module", "key", "order", "default", "group"}


def quote_identifier(column: str) -> str:
    """Backtick a column name when it would otherwise parse as a keyword."""
    return f"`{column}`" if column in _RESERVED else column


def indent(lines, spaces: int) -> str:
    """Join fragment lines at a fixed indentation.

    The first line is left unpadded because it lands wherever the template's
    placeholder already sits.
    """
    return ("\n" + " " * spaces).join(l for l in lines if l)


def comparable(value) -> str:
    """Normalise a value for cross-environment comparison.

    Source and destination JSON come from different databases, so the same
    logical value can arrive as 1 vs "1", or as JSON with different key order
    or whitespace. Comparing the normalised form avoids emitting UPDATE
    statements that would change nothing.
    """
    if is_blank(value):
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    text = str(value).strip()
    # A JSON string column may arrive already serialised; re-encode it so key
    # order and spacing cannot cause a false difference.
    if text[:1] in ("{", "["):
        try:
            return json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))
        except (ValueError, TypeError):
            return text
    # 1 / 1.0 / "1" all mean the same thing in a tinyint or int column.
    try:
        number = float(text)
        return str(int(number)) if number.is_integer() else str(number)
    except ValueError:
        return text
