/* ============================================================
 *  sql-preview.js — Rich SQL preview for the Final SQL output.
 *
 *  Replaces the plain <textarea> dump with a statement-segmented
 *  view: each `;`-terminated query becomes its own card with a
 *  type badge, target-table chip, copy button, inline syntax
 *  highlighting, and any detected issues called out at the top.
 *
 *  The textarea is preserved as the canonical value holder (other
 *  code reads `.value` for download / copy-all), but hidden by
 *  default. A "Raw" toggle swaps the views.
 *
 *  Issue detection
 *  ───────────────
 *  · UPDATE / DELETE without WHERE      (error — affects all rows)
 *  · DROP / TRUNCATE / DROP DATABASE     (warn  — destructive)
 *  · No terminating semicolon            (info  — likely truncated)
 * ============================================================ */

import { escapeHtml, qs } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { copyText, downloadSqlFromTextarea } from '../lib/data.js';

/* ── Keyword table for syntax highlight ───────────────────── */
const SQL_KEYWORDS = new Set([
  'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE',
  'JOIN','INNER','LEFT','RIGHT','OUTER','FULL','CROSS','ON','USING','AS',
  'AND','OR','NOT','NULL','IS','IN','EXISTS','BETWEEN','LIKE','ILIKE',
  'GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','UNION','ALL','INTERSECT','EXCEPT',
  'DISTINCT','CASE','WHEN','THEN','ELSE','END','IF','IFNULL','COALESCE',
  'CREATE','TABLE','INDEX','VIEW','PROCEDURE','FUNCTION','TRIGGER','SEQUENCE',
  'DROP','TRUNCATE','ALTER','ADD','MODIFY','COLUMN','RENAME','CONSTRAINT',
  'PRIMARY','FOREIGN','KEY','REFERENCES','UNIQUE','DEFAULT','CHECK','AUTO_INCREMENT',
  'WITH','RECURSIVE','BEGIN','COMMIT','ROLLBACK','START','TRANSACTION','SAVEPOINT',
  'TRUE','FALSE','RETURNING','DESC','ASC','UNSIGNED','CHARACTER','SET',
]);

const TYPE_LABELS = {
  insert:   'INSERT',
  update:   'UPDATE',
  delete:   'DELETE',
  select:   'SELECT',
  create:   'CREATE',
  drop:     'DROP',
  alter:    'ALTER',
  truncate: 'TRUNCATE',
  txn:      'TXN',
  other:    'SQL',
};

/* ── Statement splitter (semicolon-aware, string-safe) ─────── */
function parseStatements(text) {
  const stmts = [];
  let cur = '', i = 0;
  let inString = false, sq = null;
  let inLine = false, inBlock = false;
  while (i < text.length) {
    const ch = text[i];
    if (inLine) {
      cur += ch;
      if (ch === '\n') inLine = false;
      i++; continue;
    }
    if (inBlock) {
      cur += ch;
      if (text.startsWith('*/', i)) { cur += '/'; inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (inString) {
      cur += ch;
      if (ch === sq) {
        if (text[i + 1] === sq) { cur += sq; i += 2; continue; }   // escaped
        inString = false;
      }
      i++; continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true; sq = ch; cur += ch; i++; continue;
    }
    if (text.startsWith('--', i)) { inLine = true; cur += '--'; i += 2; continue; }
    if (text.startsWith('/*', i)) { inBlock = true; cur += '/*'; i += 2; continue; }
    if (ch === ';') {
      cur += ';';
      const s = cur.trim();
      if (s) stmts.push(s);
      cur = '';
      i++; continue;
    }
    cur += ch; i++;
  }
  const tail = cur.trim();
  if (tail) stmts.push(tail);   // unterminated tail captured for issue-flagging
  return stmts;
}

/* ── Type / target / issue inspectors ─────────────────────── */
function stripComments(s) {
  return s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function detectType(stmt) {
  const u = stripComments(stmt).trim().toUpperCase();
  if (u.startsWith('INSERT'))    return 'insert';
  if (u.startsWith('UPDATE'))    return 'update';
  if (u.startsWith('DELETE'))    return 'delete';
  if (u.startsWith('SELECT'))    return 'select';
  if (u.startsWith('CREATE'))    return 'create';
  if (u.startsWith('DROP'))      return 'drop';
  if (u.startsWith('ALTER'))     return 'alter';
  if (u.startsWith('TRUNCATE'))  return 'truncate';
  if (/^(BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT)/.test(u)) return 'txn';
  return 'other';
}

function detectTarget(stmt) {
  const s = stripComments(stmt);
  const re = (pat) => { const m = s.match(pat); return m ? m[1].replace(/[`"]/g, '') : null; };
  return (
    re(/INSERT\s+INTO\s+([A-Za-z_][\w.]*|`[^`]+`|"[^"]+")/i) ||
    re(/UPDATE\s+([A-Za-z_][\w.]*|`[^`]+`|"[^"]+")/i) ||
    re(/DELETE\s+FROM\s+([A-Za-z_][\w.]*|`[^`]+`|"[^"]+")/i) ||
    re(/FROM\s+([A-Za-z_][\w.]*|`[^`]+`|"[^"]+")/i) ||
    re(/(?:DROP|ALTER|TRUNCATE)\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w.]*|`[^`]+`|"[^"]+")/i) ||
    null
  );
}

function detectIssues(stmt, type) {
  const issues = [];
  const u = stripComments(stmt).toUpperCase();
  // UPDATE without WHERE — extremely risky
  if (type === 'update' && !/\bWHERE\b/.test(u)) {
    issues.push({ level: 'error', msg: 'UPDATE without WHERE — will affect every row in the target table.' });
  }
  // DELETE without WHERE
  if (type === 'delete' && !/\bWHERE\b/.test(u)) {
    issues.push({ level: 'error', msg: 'DELETE without WHERE — will remove every row in the target table.' });
  }
  // Destructive DDL
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)/.test(u)) {
    issues.push({ level: 'warn', msg: 'Destructive operation: DROP. Verify before executing.' });
  }
  if (type === 'truncate') {
    issues.push({ level: 'warn', msg: 'Destructive operation: TRUNCATE. All rows in the target will be removed.' });
  }
  // Missing terminating semicolon
  if (!stmt.trim().endsWith(';')) {
    issues.push({ level: 'info', msg: 'No terminating semicolon — statement may have been truncated.' });
  }
  return issues;
}

/* ── Tokeniser / highlighter ──────────────────────────────── */
function highlight(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // Line comment
    if (text.startsWith('--', i)) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(`<span class="sql-cmt">${escapeHtml(text.slice(i, j))}</span>`);
      i = j; continue;
    }
    // Block comment
    if (text.startsWith('/*', i)) {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out.push(`<span class="sql-cmt">${escapeHtml(text.slice(i, j))}</span>`);
      i = j; continue;
    }
    // String literal — single or double-quoted, '' escape
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1;
      while (j < n) {
        if (text[j] === q) {
          if (text[j + 1] === q) { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      out.push(`<span class="sql-str">${escapeHtml(text.slice(i, j))}</span>`);
      i = j; continue;
    }
    // Backticked identifier
    if (ch === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') j++;
      if (j < n) j++;
      out.push(`<span class="sql-ident">${escapeHtml(text.slice(i, j))}</span>`);
      i = j; continue;
    }
    // Number
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.]/.test(text[j])) j++;
      out.push(`<span class="sql-num">${escapeHtml(text.slice(i, j))}</span>`);
      i = j; continue;
    }
    // Identifier / keyword
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      const isKw = SQL_KEYWORDS.has(word.toUpperCase());
      out.push(`<span class="${isKw ? 'sql-kw' : 'sql-id'}">${escapeHtml(word)}</span>`);
      i = j; continue;
    }
    // Punctuation
    if (/[(),;]/.test(ch)) { out.push(`<span class="sql-pun">${escapeHtml(ch)}</span>`); i++; continue; }
    // Operator
    if (/[=<>!+\-*/%]/.test(ch)) { out.push(`<span class="sql-op">${escapeHtml(ch)}</span>`); i++; continue; }
    out.push(escapeHtml(ch));
    i++;
  }
  return out.join('');
}

/* ── Render ───────────────────────────────────────────────── */
export function renderSqlPreview(text) {
  const raw = (text || '').trim();
  if (!raw) {
    return `<div class="sql-preview-empty">
      <span class="sqp-empty-glyph">▤</span>
      <div class="sqp-empty-text">No migration SQL yet — fill the inputs above and press <kbd>Generate Final SQL</kbd>.</div>
    </div>`;
  }
  const stmts = parseStatements(raw);
  if (!stmts.length) {
    return `<div class="sql-preview-empty"><span class="sqp-empty-glyph">◇</span>
      <div class="sqp-empty-text">No executable statements found.</div></div>`;
  }

  // Parse + aggregate
  const counts = Object.create(null);
  let totalIssues = 0;
  let maxLevel = 'ok';
  const cards = stmts.map((stmt, idx) => {
    const type   = detectType(stmt);
    const target = detectTarget(stmt);
    const issues = detectIssues(stmt, type);
    counts[type] = (counts[type] || 0) + 1;
    totalIssues += issues.length;
    if (issues.some(i => i.level === 'error') && maxLevel !== 'error') maxLevel = 'error';
    else if (issues.some(i => i.level === 'warn') && maxLevel === 'ok')  maxLevel = 'warn';
    return renderStatementCard({ stmt, type, target, issues, num: idx + 1 });
  });

  const typeChips = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<span class="sqp-type sqp-t-${k}">${n} ${TYPE_LABELS[k] || k.toUpperCase()}</span>`)
    .join('');

  const banner =
    maxLevel === 'error' ? `<span class="sqp-warn sqp-w-error">⚠ ${totalIssues} blocking issue${totalIssues === 1 ? '' : 's'}</span>`
    : maxLevel === 'warn' ? `<span class="sqp-warn sqp-w-warn">⚠ ${totalIssues} warning${totalIssues === 1 ? '' : 's'}</span>`
    : totalIssues          ? `<span class="sqp-warn sqp-w-info">${totalIssues} note${totalIssues === 1 ? '' : 's'}</span>`
    :                        `<span class="sqp-warn sqp-w-ok">✓ Looks safe</span>`;

  return `
    <div class="sql-preview" data-issues="${maxLevel}">
      <div class="sql-preview-head">
        <div class="sqp-stat"><strong>${stmts.length}</strong> statement${stmts.length === 1 ? '' : 's'}</div>
        <div class="sqp-types">${typeChips}</div>
        <div class="sqp-banner">${banner}</div>
      </div>
      <div class="sql-preview-body">${cards.join('')}</div>
    </div>`;
}

function renderStatementCard({ stmt, type, target, issues, num }) {
  const worst = issues.find(i => i.level === 'error') ? 'error'
              : issues.find(i => i.level === 'warn')  ? 'warn'
              : issues.length                          ? 'info'
              :                                           'ok';
  const hl = highlight(stmt);
  return `
    <div class="sql-stmt sqp-t-${type}" data-level="${worst}">
      <div class="sql-stmt-head">
        <span class="sql-stmt-num">${String(num).padStart(2, '0')}</span>
        <span class="sql-stmt-type sqp-t-${type}">${TYPE_LABELS[type] || type.toUpperCase()}</span>
        ${target ? `<span class="sql-stmt-target">${escapeHtml(target)}</span>` : ''}
        ${issues.length ? `<span class="sql-stmt-issues sqp-w-${worst}">${issues.length} ${worst === 'error' ? 'issue' : (worst === 'warn' ? 'warning' : 'note')}${issues.length === 1 ? '' : 's'}</span>` : ''}
        <button class="sql-stmt-copy" type="button" title="Copy this statement"
                data-text="${escapeHtml(stmt)}">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6">
            <rect x="9" y="9" width="13" height="13" rx="1.5"/><rect x="2" y="2" width="13" height="13" rx="1.5"/>
          </svg>
        </button>
      </div>
      ${issues.length ? `<ul class="sql-stmt-issue-list">${issues.map(i =>
        `<li class="sqp-w-${i.level}"><span>${i.level === 'error' ? '×' : i.level === 'warn' ? '!' : '·'}</span>${escapeHtml(i.msg)}</li>`).join('')}</ul>` : ''}
      <pre class="sql-stmt-code">${hl}</pre>
    </div>`;
}

/* ── Modal-based preview ───────────────────────────────────
 * Single shared modal (#sqlPreviewModal) shows the preview for
 * whichever textarea was clicked last. Source textarea ID is held
 * in module state so Copy-All / Download route back to it.
 */
let currentSourceId = null;

export function openSqlPreview(textareaId) {
  const t = document.getElementById(textareaId);
  if (!t) return;
  if (!t.value || !t.value.trim()) {
    return showToast('Nothing to Preview', 'Note: Generate Final SQL first.', 'warning');
  }
  currentSourceId = textareaId;
  const body = qs('#sqlPreviewBody');
  if (body) body.innerHTML = renderSqlPreview(t.value);

  // Quick-look meta — appears in the modal title bar
  const meta = qs('#sqlPreviewMeta');
  if (meta) {
    const stmts = parseStatements(t.value);
    meta.textContent = `${stmts.length} statement${stmts.length === 1 ? '' : 's'} · ${t.value.length.toLocaleString()} chars`;
  }

  const modal = qs('#sqlPreviewModal');
  if (modal) modal.classList.remove('hidden');
}

export function closeSqlPreview() {
  const modal = qs('#sqlPreviewModal');
  if (modal) modal.classList.add('hidden');
  currentSourceId = null;
}

export function copySqlPreviewAll() {
  if (!currentSourceId) return;
  copyText(currentSourceId);
}

export function downloadSqlPreviewAll() {
  if (!currentSourceId) return;
  downloadSqlFromTextarea(currentSourceId);
}

/* Per-statement copy — works whether the preview is open or not
 * (the cards live inside the singleton modal body). */
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest && e.target.closest('.sql-stmt-copy');
  if (!copyBtn) return;
  e.preventDefault();
  const text = copyBtn.dataset.text || '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(
    () => showToast('Copied', 'Statement copied to clipboard.', 'success'),
    () => showToast('Copy Failed', 'Clipboard access denied.', 'error')
  );
  copyBtn.classList.add('is-flash');
  setTimeout(() => copyBtn.classList.remove('is-flash'), 700);
});

/* Esc closes the SQL Preview modal */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = qs('#sqlPreviewModal');
  if (modal && !modal.classList.contains('hidden')) closeSqlPreview();
});
