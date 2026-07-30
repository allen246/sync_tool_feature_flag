/* ============================================================
 *  data.js — Data handling: validation, JSON auto-repair,
 *  input normalization, file upload, clipboard copy, download.
 *
 *  Public API:
 *    validateFields(fields)
 *    validateJSON(fields)            — also auto-repairs (see repairJson)
 *    repairJson(text)
 *    tryRepairTextarea(el, label)
 *    normTrim(s) / normCSV(s)
 *    normalizeInput(el)              — uses the canonical CSV/PLAIN id sets
 *    wireInputNormalization()        — idempotent; blurs + paste
 *    triggerFileUpload(textarea)
 *    copyText(id) / downloadSqlFromTextarea(id)
 *    downloadBlob(text, filename, mime)
 * ============================================================ */

import { qs, formatBytes } from './dom.js';
import { showToast } from './toast.js';
import { unwrapDumpText } from './json-dump.js';

/* ── Field validation ─────────────────────────────────────── */
export function validateFields(fields) {
  let ok = true; const missing = [];
  fields.forEach(({ el, label }) => {
    if (!el.value.trim()) { el.classList.add('error'); missing.push(label); ok = false; }
    else el.classList.remove('error');
  });
  if (!ok) showToast('Validation Error', `Note: Required — ${missing.join(', ')}.`, 'error');
  return ok;
}

/* ── JSON auto-repair ─────────────────────────────────────── */

/** Every exit from repairJson() goes through here: once the text parses, a
 *  DB-client dump envelope is peeled off it (see lib/json-dump.js). That
 *  makes "paste the raw export file" work in every JSON field at once —
 *  a dump is valid JSON, so nothing else in the chain would notice it. */
function settle(text, fixes) {
  const inner = unwrapDumpText(text);
  if (inner === null) return { text, fixes };
  fixes.push('unwrapped database export envelope');
  return { text: inner, fixes };
}

export function repairJson(raw) {
  const fixes = [];
  if (raw == null) return { text: '', fixes };
  let s = String(raw);
  try { JSON.parse(s); return settle(s, fixes); } catch (_) {}

  if (s.charCodeAt(0) === 0xFEFF) { s = s.slice(1); fixes.push('removed BOM marker'); }
  const trimmed = s.replace(/^\s+|\s+$/g, '');
  if (trimmed !== s) { s = trimmed; fixes.push('trimmed whitespace'); }

  if (/[“”‘’]/.test(s)) {
    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    fixes.push('replaced curly quotes');
  }

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const unwrapped = JSON.parse(s);
      if (typeof unwrapped === 'string') {
        const t = unwrapped.replace(/^\s+|\s+$/g, '');
        if (t.startsWith('{') || t.startsWith('[')) {
          s = t; fixes.push('unwrapped outer-quoted JSON string');
        }
      }
    } catch (_) {}
  }

  if (/\\"|\\n|\\t/.test(s) && /^\s*[\{\[]/.test(s)) {
    const before = s;
    s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
    if (s !== before) fixes.push('unescaped backslash sequences');
  }

  if (/\/\/|\/\*/.test(s)) {
    let stripped = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1');
    if (stripped !== s) { s = stripped; fixes.push('removed comments'); }
  }

  const noTrailing = s.replace(/,\s*([}\]])/g, '$1');
  if (noTrailing !== s) { s = noTrailing; fixes.push('removed trailing commas'); }

  try { JSON.parse(s); return settle(s, fixes); } catch (_) {}
  if (/'[^'\\]*'\s*:/.test(s) || /:\s*'[^'\\]*'/.test(s)) {
    const converted = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_, inner) => '"' + inner.replace(/"/g, '\\"').replace(/\\'/g, "'") + '"');
    try { JSON.parse(converted); s = converted; fixes.push('converted single quotes to double'); } catch (_) {}
  }
  return settle(s, fixes);   // a no-op when s still does not parse
}

export function tryRepairTextarea(el, label) {
  const original = el.value;
  if (!original.trim()) return { ok: false, empty: true };
  // No fast path for already-valid JSON: a dump parses fine and still needs
  // unwrapping. repairJson() returns the text unchanged when there is
  // nothing to do, so a clean paste is never rewritten.
  const { text, fixes } = repairJson(original);
  try {
    JSON.parse(text);
    if (text !== original) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('JSON Auto-Repaired',
        `Note: ${label} was cleaned (${fixes.join(', ') || 'normalized'}).`, 'info');
    }
    return { ok: true, fixes };
  } catch (_) {
    return { ok: false, fixes };
  }
}

export function validateJSON(fields) {
  const bad = [];
  fields.forEach(({ el, label }) => {
    if (!el.value.trim()) { el.classList.add('error'); bad.push(label); return; }
    const result = tryRepairTextarea(el, label);
    if (result.ok) el.classList.remove('error');
    else { el.classList.add('error'); bad.push(label); }
  });
  if (bad.length) { showToast('Invalid JSON', `Note: Fix JSON in — ${bad.join(', ')}.`, 'error'); return false; }
  return true;
}

/* ── Extract a JSON array from a raw text source ────────────
 * DB export tools wrap JSON_ARRAYAGG results in different ways:
 *   · clean array:           [{...},{...}]
 *   · JSON_ARRAYAGG wrapper: [{ "result": "[{...},{...}]" }]
 *   · object wrapper:        {"result":[...]} / {"data":[...]} / {"rows":[...]}
 *   · stringified twice:     "[{...}]"
 *   · single object:         {...}                (wrapped → [{...}])
 *   · raw client dump:       {"SELECT …": [{"result":"[{...}]"}]}
 *                            — the query text is the column name; peeled by
 *                              repairJson via lib/json-dump.js
 *
 * Applies repairJson() first to handle BOM, smart quotes, escaped
 * inner quotes, trailing commas, single-quoted JSON, comments.
 *
 * @param {string} text
 * @returns {{ rows: any[], unwrapped: boolean, fixes: string[] }}
 * @throws Error on parse failure / non-extractable shape
 */
export function extractJsonArray(text) {
  const { text: clean, fixes } = repairJson(text || '');
  let parsed;
  try { parsed = JSON.parse(clean); }
  catch (e) { throw new Error('JSON syntax error: ' + e.message); }

  const originallyArray = Array.isArray(parsed) && !looksLikeWrapper(parsed);
  let unwrapped = false;

  // Up to 5 unwrap passes — guards against pathological nesting
  for (let i = 0; i < 5; i++) {
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); unwrapped = true; continue; }
      catch (_) { break; }
    }
    if (Array.isArray(parsed)) {
      // [{ "result": "..." }] — JSON_ARRAYAGG single-row wrapper
      if (parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object'
          && !Array.isArray(parsed[0]) && looksLikeWrapper(parsed[0])) {
        parsed = unwrapObject(parsed[0]);
        unwrapped = true;
        continue;
      }
      break;
    }
    if (parsed && typeof parsed === 'object') {
      if (looksLikeWrapper(parsed)) {
        parsed = unwrapObject(parsed);
        unwrapped = true;
        continue;
      }
      // Plain single object → wrap as [obj]
      parsed = [parsed];
      unwrapped = true;
      break;
    }
    break;
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Expected an array of rows; got ' + typeof parsed);
  }
  return { rows: parsed, unwrapped: unwrapped && !originallyArray, fixes };
}

/** A wrapper is a single-key object with a known wrapper key whose
 *  value is an array, a stringified array, or another wrapper. */
function looksLikeWrapper(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    // Multi-key objects can still be wrappers if exactly one of these holds an array
    return ['result', 'data', 'rows', 'records', 'results', 'items'].some(k =>
      Array.isArray(obj[k]) || (typeof obj[k] === 'string' && obj[k].trim().startsWith('['))
    ) && keys.length <= 3;
  }
  return ['result', 'data', 'rows', 'records', 'results', 'items'].includes(keys[0]);
}

function unwrapObject(obj) {
  for (const k of ['result', 'data', 'rows', 'records', 'results', 'items']) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (_) { return [obj]; }
      }
      return v;
    }
  }
  return [obj];
}

/* ── RFC 4180 CSV parser ────────────────────────────────────
 * Returns array-of-arrays. Handles:
 *   · Standard commas + LF / CRLF / CR line endings
 *   · Quoted fields with embedded commas / newlines
 *   · Escaped double-quotes inside quoted fields ("" → ")
 *   · BOM stripped automatically
 * No dependency on browser CSV APIs (we want predictable behaviour).
 */
export function parseCSV(text) {
  if (text == null) return [];
  let s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // strip BOM

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; }   // escaped quote
        else                  { inQuotes = false; i++; }
      } else {
        field += ch; i++;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true; i++;
    } else if (ch === ',') {
      row.push(field); field = ''; i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (ch === '\r' && s[i + 1] === '\n') i += 2;
      else i++;
    } else {
      field += ch; i++;
    }
  }
  // Trailing field / row
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop a truly-empty trailing row (file ended with a newline)
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

/* ── Input normalization (trim, CSV) ──────────────────────── */
export function normTrim(s) { return (s == null ? '' : String(s)).replace(/^\s+|\s+$/g, ''); }
export function normCSV(s) {
  if (s == null) return '';
  return String(s).split(',')
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
}

/** Tabs register their input IDs in CSV_INPUT_IDS / PLAIN_INPUT_IDS so
 *  normalization works without each tab calling it manually. */
export const CSV_INPUT_IDS   = new Set();
export const PLAIN_INPUT_IDS = new Set();

export function registerInputs({ csv = [], plain = [] } = {}) {
  csv.forEach(id => CSV_INPUT_IDS.add(id));
  plain.forEach(id => PLAIN_INPUT_IDS.add(id));
}

export function normalizeInput(el) {
  if (!el || !el.value) return;
  const before = el.value;
  const after = CSV_INPUT_IDS.has(el.id) ? normCSV(before)
              : PLAIN_INPUT_IDS.has(el.id) ? normTrim(before)
              : before;
  if (after !== before) {
    el.value = after;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

export function wireInputNormalization() {
  document.querySelectorAll('#content input').forEach(el => {
    if (el.dataset._normWired === '1') return;
    el.dataset._normWired = '1';
    el.addEventListener('blur',  () => normalizeInput(el));
    el.addEventListener('paste', () => setTimeout(() => normalizeInput(el), 0));
  });
}

/* ── File upload ──────────────────────────────────────────── */
export function triggerFileUpload(textarea, opts = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = opts.accept || '.json,.txt,application/json,text/plain';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', function () {
    const file = this.files && this.files[0];
    document.body.removeChild(input);
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      showToast('File Too Large', 'Note: Files must be under 50 MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      textarea.value = String(reader.result || '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('File Loaded', `${file.name} · ${formatBytes(file.size)}`, 'success');
      // A file dropped straight out of a DB client is a dump envelope — unwrap
      // it now so the field shows the payload rather than the query text.
      tryRepairTextarea(textarea, file.name);
    };
    reader.onerror = () => showToast('Read Failed', `Note: Could not read ${file.name}.`, 'error');
    reader.readAsText(file);
  });
  input.click();
}

/* ── Copy / download ──────────────────────────────────────── */
export function copyText(id) {
  const el = document.getElementById(id);
  if (!el || !el.value.trim()) return showToast('Nothing to Copy', 'No SQL has been generated yet.', 'warning');
  navigator.clipboard.writeText(el.value);
  showToast('Copied!', 'SQL copied to clipboard.', 'success');
}

export function downloadSqlFromTextarea(id) {
  const el = document.getElementById(id);
  if (!el || !el.value.trim()) return showToast('Nothing to Download', 'No SQL has been generated yet.', 'warning');
  fetch('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: el.value }) })
    .then(r => r.blob()).then(blob => {
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: 'generated.sql',
      });
      a.click();
      showToast('Downloaded!', 'SQL file saved.', 'success');
    });
}

/** Build & download a Blob from text. Used by CSV/JSON exports. */
export function downloadBlob(text, filename, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
