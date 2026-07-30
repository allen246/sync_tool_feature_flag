/* ============================================================
 *  json-dump.js — Peel the envelope a DB client wraps a result
 *  set in, so every JSON field in the tool accepts a raw dump.
 *
 *  DBeaver / DataGrip / Workbench "export result set as JSON"
 *  name the column after the whole query text:
 *
 *    { "SELECT JSON_OBJECT(\n  'tenant', …": [
 *        { "result": "{\"tenant\":[…],\"branch\":[…]}" } ] }
 *
 *  That is valid JSON, so nothing complains — the payload just
 *  silently reads as empty. unwrapDbDump() digs the payload back
 *  out; anything that is not an envelope is returned untouched.
 * ============================================================ */

/** Column / field names a result set is commonly wrapped in. */
const ENVELOPE_KEYS = new Set([
  'result', 'results', 'data', 'rows', 'records', 'items', 'payload', 'json_object',
]);

/** A dump names its single column after the query that produced it. */
const QUERY_KEY = /^\s*(select|with|show|call)\b/i;

const MAX_DEPTH = 6;   // deeper than any real client nests

/** The wrapped value of `obj`, or undefined when `obj` is not an envelope.
 *  Only single-key objects qualify — a tenant payload is keyed by table
 *  name and has many, so it can never be mistaken for a wrapper. */
function envelopeValue(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  return (ENVELOPE_KEYS.has(key.trim().toLowerCase()) || QUERY_KEY.test(key))
    ? obj[key]
    : undefined;
}

/** @param {any} value  Already-parsed JSON. @returns {any} the payload. */
export function unwrapDbDump(value) {
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let next;
    if (typeof value === 'string') {
      const text = value.trim();
      // A string that does not open a JSON container is data, not an envelope.
      if (!/^[{[]/.test(text)) return value;
      try { next = JSON.parse(text); } catch (_) { return value; }
    } else if (Array.isArray(value)) {
      // A single-row result set may itself be the envelope; a multi-row one
      // is the payload and must survive intact.
      if (value.length !== 1) return value;
      next = envelopeValue(value[0]);
    } else {
      next = envelopeValue(value);
    }
    if (next === undefined) return value;
    value = next;
  }
  return value;
}

/** Text in, text out. Returns null when `text` is not a dump (or not JSON),
 *  so callers can tell "nothing to do" from "unwrapped". */
export function unwrapDumpText(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return null; }
  const inner = unwrapDbDump(parsed);
  return inner === parsed ? null : JSON.stringify(inner, null, 2);
}
