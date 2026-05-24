/* ═══════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════ */

/* ── Toast ──────────────────────────────────────────────────────── */
const ICONS = {
  success: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
  error:   `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
  warning: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>`,
  info:    `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
};

function showToast(title, msg, type) {
  const t = document.getElementById("toast");
  const msgHtml = msg ? `<div class="toast-msg">${msg}</div>` : '';
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.innerHTML = `<div class="toast-inner"><div class="toast-icon">${ICONS[type]||ICONS.info}</div><div class="toast-text"><div class="toast-title">${title}</div>${msgHtml}</div></div>`;
  t.className = "toast " + type;
  t.style.display = "block";
  clearTimeout(t._t);
  t._t = setTimeout(() => t.style.display = "none", 4800);
}

/* ── Loading state (button + global progress bar) ────────────── */
function setLoading(btn, on) {
  if (!btn) return;
  const bar = document.getElementById('progressBar');
  if (on) {
    btn.dataset.loading = 'true';
    btn.setAttribute('aria-busy', 'true');
    if (bar) bar.dataset.loading = 'true';
  } else {
    delete btn.dataset.loading;
    btn.removeAttribute('aria-busy');
    if (bar) {
      // Only clear if no other buttons are loading.
      const stillLoading = document.querySelectorAll('button[data-loading="true"]').length;
      if (!stillLoading) delete bar.dataset.loading;
    }
  }
}

function activeButton() {
  return (typeof event !== 'undefined' && event && event.target)
    ? event.target.closest('button')
    : null;
}

/* ── Input normalization ──────────────────────────────────────
 * Trim outer whitespace and clean comma-separated lists.
 * Examples this handles:
 *   "  TENANT_ACME "         -> "TENANT_ACME"
 *   "ISU ,ERU ,ISLC, ESLC"   -> "ISU, ERU, ISLC, ESLC"
 *   ",, BR001 , , BR002 ,,"  -> "BR001, BR002"
 *   "  multi   line  "       -> "multi line"  (interior collapse for plain fields)
 */
function normTrim(s) {
  return (s == null ? '' : String(s)).replace(/^\s+|\s+$/g, '');
}
function normCSV(s) {
  if (s == null) return '';
  return String(s)
    .split(',')
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
}
const CSV_INPUT_IDS = new Set([
  'bBranches', 'bProducts',
  'wBranches', 'wProducts',
]);
const PLAIN_INPUT_IDS = new Set([
  'bTenant', 'wTenant', 'ffTenant',
]);

function normalizeInput(el) {
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

function wireInputNormalization() {
  document.querySelectorAll('#content input').forEach(el => {
    if (el.dataset._normWired === '1') return;
    el.dataset._normWired = '1';
    // Clean on blur so user sees the canonical form. Don't clean
    // mid-typing — that would steal the user's caret position.
    el.addEventListener('blur', () => normalizeInput(el));
    // Clean on paste so multi-line / messy pastes get fixed immediately.
    el.addEventListener('paste', () => setTimeout(() => normalizeInput(el), 0));
  });
}

/* ── File upload helpers ──────────────────────────────────────── */
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function triggerFileUpload(textarea, opts) {
  opts = opts || {};
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
    reader.onload = function () {
      textarea.value = String(reader.result || '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('File Loaded', `${file.name} · ${formatBytes(file.size)}`, 'success');
    };
    reader.onerror = function () {
      showToast('Read Failed', `Note: Could not read ${file.name}.`, 'error');
    };
    reader.readAsText(file);
  });
  input.click();
}

const UPLOAD_SVG = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-5 5m5-5l5 5M5 21h14"/></svg>`;

function decorateJsonGroups() {
  document.querySelectorAll('.json-group').forEach(group => {
    const textarea = group.querySelector('textarea');
    const labelRow = group.querySelector('.json-label-row');
    if (!textarea || !labelRow) return;
    if (labelRow.querySelector('.json-upload-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'json-upload-btn';
    btn.setAttribute('title', 'Upload from file');
    btn.setAttribute('aria-label', 'Upload from file');
    btn.innerHTML = UPLOAD_SVG + '<span>Upload</span>';
    btn.addEventListener('click', e => {
      e.preventDefault();
      triggerFileUpload(textarea);
    });
    const pill = labelRow.querySelector('.db-pill');
    if (pill) labelRow.insertBefore(btn, pill);
    else labelRow.appendChild(btn);
  });
}

/* ── Modal ──────────────────────────────────────────────────────── */
function showModal(notes) {
  const ul = notes.map(n => `<li>${n.replace(/^Note:\s*/i, '')}</li>`).join('');
  document.getElementById('noteContent').innerHTML = `<ul>${ul}</ul>`;
  document.getElementById('noteModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('noteModal').classList.add('hidden'); }

let workflowGroupRemapResolver = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function getWorkflowGroupCandidates(rows) {
  const groups = new Set();
  rows.forEach(row => {
    const fromGroup = typeof row?.from_group === 'string' ? row.from_group.trim() : '';
    if (fromGroup) groups.add(fromGroup);

    const toGroups = Array.isArray(row?.to_groups) ? row.to_groups : [];
    toGroups.forEach(group => {
      if (typeof group !== 'string') return;
      const normalized = group.trim();
      if (normalized) groups.add(normalized);
    });
  });
  return Array.from(groups).sort((a, b) => a.localeCompare(b));
}

function applyWorkflowGroupRemap(rows, remap) {
  return rows.map(row => ({
    ...row,
    from_group: typeof row?.from_group === 'string' && row.from_group.trim()
      ? remap[row.from_group.trim()]
      : row.from_group,
    to_groups: Array.isArray(row?.to_groups)
      ? row.to_groups.map(group => {
          if (typeof group !== 'string') return group;
          const normalized = group.trim();
          return normalized ? remap[normalized] : group;
        })
      : row.to_groups,
  }));
}

function openWorkflowGroupRemapModal(groups) {
  const modal = document.getElementById('workflowRemapModal');
  const content = document.getElementById('workflowRemapContent');
  content.innerHTML = groups.map(group => `
    <div class="workflow-remap-row">
      <div class="workflow-remap-source">
        <span class="workflow-remap-label">Current Group</span>
        <div class="workflow-remap-value">${escapeHtml(group)}</div>
      </div>
      <div class="workflow-remap-input">
        <label class="workflow-remap-label" for="workflow-remap-${escapeHtml(group)}">New Group Name</label>
        <input
          id="workflow-remap-${escapeHtml(group)}"
          class="workflow-remap-field"
          data-group="${escapeHtml(group)}"
          placeholder="Enter replacement group name"
        >
        <span class="workflow-remap-error hidden">Replacement value is required.</span>
      </div>
    </div>
  `).join('');
  modal.classList.remove('hidden');

  const firstInput = content.querySelector('input');
  if (firstInput) firstInput.focus();

  return new Promise(resolve => {
    workflowGroupRemapResolver = resolve;
  });
}

function closeWorkflowGroupRemap(result) {
  const modal = document.getElementById('workflowRemapModal');
  modal.classList.add('hidden');
  document.getElementById('workflowRemapContent').innerHTML = '';
  if (workflowGroupRemapResolver) {
    workflowGroupRemapResolver(result);
    workflowGroupRemapResolver = null;
  }
}

function cancelWorkflowGroupRemap() {
  closeWorkflowGroupRemap(null);
}

function submitWorkflowGroupRemap() {
  const fields = Array.from(document.querySelectorAll('#workflowRemapContent .workflow-remap-field'));
  const remap = {};
  let hasErrors = false;

  fields.forEach(field => {
    const value = field.value.trim();
    const error = field.parentElement.querySelector('.workflow-remap-error');
    if (!value) {
      field.classList.add('error');
      error.classList.remove('hidden');
      hasErrors = true;
      return;
    }
    field.classList.remove('error');
    error.classList.add('hidden');
    remap[field.dataset.group] = value;
  });

  if (hasErrors) {
    showToast("Validation Error", "Note: Group remapping is mandatory for all listed values.", "error");
    return;
  }

  closeWorkflowGroupRemap(remap);
}

/* ── Copy / Download ────────────────────────────────────────────── */
function copyText(id) {
  const el = document.getElementById(id);
  if (!el || !el.value.trim()) return showToast("Nothing to Copy", "No SQL has been generated yet.", "warning");
  navigator.clipboard.writeText(el.value);
  showToast("Copied!", "SQL copied to clipboard.", "success");
}

function downloadSQL(id) {
  const el = document.getElementById(id);
  if (!el || !el.value.trim()) return showToast("Nothing to Download", "No SQL has been generated yet.", "warning");
  fetch("/download", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({sql: el.value}) })
    .then(r => r.blob()).then(blob => {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "generated.sql" });
      a.click();
      showToast("Downloaded!", "SQL file saved.", "success");
    });
}

/* ── Validation ─────────────────────────────────────────────────── */
function validateFields(fields) {
  let ok = true; const missing = [];
  fields.forEach(({el, label}) => {
    if (!el.value.trim()) { el.classList.add('error'); missing.push(label); ok = false; }
    else el.classList.remove('error');
  });
  if (!ok) showToast("Validation Error", `Note: Required — ${missing.join(', ')}.`, "error");
  return ok;
}

/* ── JSON auto-repair ────────────────────────────────────────
 * Handles common paste-time mangling without changing the data:
 *   1. BOM marker / zero-width characters at start
 *   2. Smart/curly quotes ("Hello" "Hello") → straight quotes
 *   3. Whole document wrapped in quotes:  "{\"k\":\"v\"}"  → unwrap + unescape
 *   4. Backslash-escaped quotes outside a string context: {\"k\":\"v\"} → unescape
 *   5. Trailing commas:  {"a":1,}  →  {"a":1}
 *   6. Single-quoted JSON-ish:  {'k':'v'}  →  {"k":"v"}
 *   7. JS-style comments inside the document
 * Returns { text: string, fixes: string[] } — call JSON.parse(text) after.
 * No fix is applied if the input already parses.
 */
function repairJson(raw) {
  const fixes = [];
  if (raw == null) return { text: '', fixes };
  let s = String(raw);

  // Quick exit — already valid.
  try { JSON.parse(s); return { text: s, fixes }; } catch (_) {}

  // 1. Strip BOM + leading/trailing whitespace
  if (s.charCodeAt(0) === 0xFEFF) { s = s.slice(1); fixes.push('removed BOM marker'); }
  const trimmed = s.replace(/^\s+|\s+$/g, '');
  if (trimmed !== s) { s = trimmed; fixes.push('trimmed whitespace'); }

  // 2. Smart quotes → straight
  if (/[“”‘’]/.test(s)) {
    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    fixes.push('replaced curly quotes');
  }

  // 3. Whole document quoted? e.g.  "{\"a\":1}"  (or with single outer quotes)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const unwrapped = JSON.parse(s);   // gives the inner string
      if (typeof unwrapped === 'string') {
        const t = unwrapped.replace(/^\s+|\s+$/g, '');
        if (t.startsWith('{') || t.startsWith('[')) {
          s = t;
          fixes.push('unwrapped outer-quoted JSON string');
        }
      }
    } catch (_) {}
  }

  // 4. Backslash-escaped quotes without outer wrapper: {\"a\":\"b\"}
  if (/\\"|\\n|\\t/.test(s) && /^\s*[\{\[]/.test(s)) {
    // Heuristic: if document starts with { or [ but contains backslash-quote sequences,
    // un-escape the most common JSON-string-style escapes ONCE.
    const before = s;
    s = s
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');
    if (s !== before) fixes.push('unescaped backslash sequences');
  }

  // 5. Strip JS-style comments (// line and /* block */)
  if (/\/\/|\/\*/.test(s)) {
    let stripped = s.replace(/\/\*[\s\S]*?\*\//g, '');
    stripped = stripped.replace(/(^|[^:"'])\/\/[^\n]*/g, '$1');
    if (stripped !== s) { s = stripped; fixes.push('removed comments'); }
  }

  // 6. Trailing commas before } or ]
  const noTrailing = s.replace(/,\s*([}\]])/g, '$1');
  if (noTrailing !== s) { s = noTrailing; fixes.push('removed trailing commas'); }

  // 7. Single-quoted keys/values → double. Only run if parse still fails AND
  // string contains no unescaped double-quote keys, so we don't corrupt
  // legitimately double-quoted JSON that has interior apostrophes.
  try { JSON.parse(s); return { text: s, fixes }; } catch (_) {}
  if (/'[^'\\]*'\s*:/.test(s) || /:\s*'[^'\\]*'/.test(s)) {
    // Convert single-quoted strings to double-quoted, preserving any interior
    // double quotes by escaping them. Simple-case heuristic — won't perfectly
    // handle escaped apostrophes inside single-quoted strings.
    const converted = s.replace(/'((?:[^'\\]|\\.)*)'/g, (m, inner) => {
      return '"' + inner.replace(/"/g, '\\"').replace(/\\'/g, "'") + '"';
    });
    try {
      JSON.parse(converted);
      s = converted;
      fixes.push('converted single quotes to double');
    } catch (_) {}
  }

  return { text: s, fixes };
}

function tryRepairTextarea(el, label) {
  const original = el.value;
  if (!original.trim()) return { ok: false, empty: true };
  try { JSON.parse(original); return { ok: true, fixes: [] }; } catch (_) {}
  const { text, fixes } = repairJson(original);
  try {
    JSON.parse(text);
    if (text !== original) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      showToast('JSON Auto-Repaired',
        `Note: ${label} was cleaned (${fixes.join(', ') || 'normalized'}).`,
        'info');
    }
    return { ok: true, fixes };
  } catch (_) {
    return { ok: false, fixes };
  }
}

function validateJSON(fields) {
  const bad = [];
  fields.forEach(({el, label}) => {
    if (!el.value.trim()) { el.classList.add('error'); bad.push(label); return; }
    const result = tryRepairTextarea(el, label);
    if (result.ok) el.classList.remove('error');
    else { el.classList.add('error'); bad.push(label); }
  });
  if (bad.length) { showToast("Invalid JSON", `Note: Fix JSON in — ${bad.join(', ')}.`, "error"); return false; }
  return true;
}

/* ── SVG Builders ───────────────────────────────────────────────── */
const COPY_SVG = id => `<svg onclick="copyText('${id}')" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Copy"><rect x="9" y="9" width="13" height="13" rx="2" stroke-width="1.5"/><rect x="2" y="2" width="13" height="13" rx="2" stroke-width="1.5"/></svg>`;
const DL_SVG   = id => `<svg onclick="downloadSQL('${id}')" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="Download"><path stroke-width="1.5" d="M12 3v12m0 0l-4-4m4 4l4-4"/><path stroke-width="1.5" d="M5 21h14"/></svg>`;

/* ── Pull Result Renderer (shared by all 3 tabs) ────────────────── */
/**
 * Render Source/Destination query boxes into a container element.
 * data = { source_query: string, destination_query: string }
 * Boxes that are empty are omitted entirely.
 */
function renderPullResult(containerId, data) {
  const hasSrc  = data.source_query && data.source_query.trim();
  const hasDest = data.destination_query && data.destination_query.trim();

  if (!hasSrc && !hasDest) {
    document.getElementById(containerId).innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:120px;
                  border:1.5px dashed var(--border);border-radius:var(--radius);
                  color:var(--text-muted);font-size:0.85rem;gap:8px;margin-top:14px;">
        No query was generated.
      </div>`;
    return;
  }

  const gridClass = (hasSrc && hasDest) ? 'pull-result-grid' : 'pull-result-grid single';

  let html = `<div class="${gridClass}">`;

  if (hasSrc) {
    html += `
    <div class="pull-result-box">
      <div class="query-section-label">
        <span class="db-pill source">Source DB</span> Run on Source Database
      </div>
      <div class="sql-wrapper">
        <div class="sql-icons">${COPY_SVG('srcQ_'+containerId)}${DL_SVG('srcQ_'+containerId)}</div>
        <textarea id="srcQ_${containerId}" readonly>${hasSrc}</textarea>
      </div>
    </div>`;
  }

  if (hasDest) {
    html += `
    <div class="pull-result-box">
      <div class="query-section-label">
        <span class="db-pill dest">Destination DB</span> Run on Destination Database
      </div>
      <div class="sql-wrapper">
        <div class="sql-icons">${COPY_SVG('destQ_'+containerId)}${DL_SVG('destQ_'+containerId)}</div>
        <textarea id="destQ_${containerId}" readonly>${hasDest}</textarea>
      </div>
    </div>`;
  }

  html += `</div>`;
  document.getElementById(containerId).innerHTML = html;
}

/* ── Flow Ribbon ─────────────────────────────────────────────────
 * Stepper visualisation rendered above each tab's content. Pure
 * presentation: the stepper state is observed from DOM changes
 * (see #flowSync at the bottom of this file), never set by the
 * existing handlers. The flow definitions live in FLOWS below.
 */
const FLOWS = {
  branch: [
    {key: 'configure', glyph: '◐', label: 'Configure'},
    {key: 'emit',      glyph: '⇆', label: 'Pull Queries'},
    {key: 'run',       glyph: '↗', label: 'Run on DBs', external: true},
    {key: 'paste',     glyph: '⇋', label: 'Paste JSON'},
    {key: 'final',     glyph: '▣', label: 'Migration SQL'},
  ],
  workflow: [
    {key: 'configure', glyph: '◐', label: 'Configure'},
    {key: 'emit',      glyph: '⇆', label: 'Pull Query'},
    {key: 'run',       glyph: '↗', label: 'Run on Source', external: true},
    {key: 'paste',     glyph: '⇋', label: 'Paste & Remap'},
    {key: 'final',     glyph: '▣', label: 'Migration SQL'},
  ],
  feature: [
    {key: 'configure', glyph: '◐', label: 'Configure'},
    {key: 'emit',      glyph: '⇆', label: 'Pull Queries'},
    {key: 'run',       glyph: '↗', label: 'Run on DBs', external: true},
    {key: 'paste',     glyph: '⇋', label: 'Paste JSON'},
    {key: 'final',     glyph: '▣', label: 'Migration SQL'},
  ],
  mq: [
    {key: 'paste',  glyph: '⇋', label: 'Paste Source'},
    {key: 'paste2', glyph: '⇋', label: 'Paste Destination'},
    {key: 'run',    glyph: '⚙', label: 'Run Diff'},
    {key: 'review', glyph: '▣', label: 'Review Output'},
  ],
};

function flowRibbon(flowKey) {
  const steps = FLOWS[flowKey] || [];
  const items = steps.map((s, i) => `
    <li class="flow-step${s.external ? ' is-external' : ''}" data-step="${s.key}" data-state="${i === 0 ? 'active' : 'pending'}">
      <span class="flow-step-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="flow-step-glyph" aria-hidden="true">${s.glyph}</span>
      <span class="flow-step-label">${s.label}</span>
      ${s.external ? '<span class="flow-step-meta">offline</span>' : ''}
    </li>
  `).join('<li class="flow-link" aria-hidden="true"></li>');
  return `
    <nav class="flow-ribbon" data-flow="${flowKey}" aria-label="${flowKey} sync flow">
      <ol class="flow-steps">${items}</ol>
    </nav>`;
}

/* ── Offline Operation Callout ───────────────────────────────── */
function offlineCallout(title, body) {
  return `
    <div class="offline-callout" role="note">
      <div class="offline-callout-rule" aria-hidden="true"></div>
      <div class="offline-callout-content">
        <span class="offline-callout-tag">
          <span class="offline-callout-icon" aria-hidden="true">↗</span>
          External Operation
        </span>
        <h4 class="offline-callout-title">${title}</h4>
        <p class="offline-callout-text">${body}</p>
      </div>
      <div class="offline-callout-rule" aria-hidden="true"></div>
    </div>`;
}

/* ── Output Card ─────────────────────────────────────────────── */
function outputCard(title, hint, innerHTML) {
  return `
    <div class="output-card">
      <div class="output-card-head">
        <span class="output-card-tag">— Final Output —</span>
        <h4 class="output-card-title">${title}</h4>
        ${hint ? `<p class="output-card-hint">${hint}</p>` : ''}
      </div>
      <div class="output-card-body">${innerHTML}</div>
    </div>`;
}

/* ── Final SQL Box ──────────────────────────────────────────────── */
function finalSQLBox(id) {
  return `
  <div class="query-section-label" style="margin-top:14px;">
    <span class="db-pill dest">Destination DB</span> Execute on Destination Database
  </div>
  <div class="sql-wrapper">
    <div class="sql-icons">${COPY_SVG(id)}${DL_SVG(id)}</div>
    <textarea id="${id}" readonly placeholder="Generated migration SQL will appear here…"></textarea>
  </div>`;
}

/* ── Generate / Run icons ───────────────────────────────────────── */
const GEN_ICON = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>`;
const FIN_ICON = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/></svg>`;

/* ── Jump-to-tab helper (used by header coverage panel) ─────── */
function goToTab(idx) {
  const btn = document.querySelectorAll('.tabs button')[idx];
  if (btn) btn.click();
  // Smooth-scroll the tab bar into view so the chosen domain is visible.
  const tabs = document.querySelector('.tabs');
  if (tabs && tabs.scrollIntoView) tabs.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── Tab Switcher ───────────────────────────────────────────────── */
function switchTab(t) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  if (t === 'branch') loadBranch();
  else if (t === 'workflow') loadWorkflow();
  else if (t === 'feature') loadFeatureFlag();
  else if (t === 'mq') loadMqComparison();
}

/* ═══════════════════════════════════════════════════════════════════
   BRANCH SYNC
═══════════════════════════════════════════════════════════════════ */
function loadBranch() {
  document.getElementById('content').innerHTML = `
${flowRibbon('branch')}

<div class="section-header"><div class="section-badge">1</div><h3>Configure &amp; Emit Pull Queries</h3></div>
<p class="section-hint">Provide tenant, branches and products. The console emits Source &amp; Destination queries you'll run to capture the current state.</p>

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="bTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
  <div class="form-group">
    <label>Branch Codes <span class="required">*</span></label>
    <input id="bBranches" placeholder="e.g. BR001, BR002">
    <span class="field-hint">Comma-separated branch codes</span>
  </div>
  <div class="form-group">
    <label>Product Codes <span class="required">*</span></label>
    <input id="bProducts" placeholder="e.g. PROD1, PROD2">
    <span class="field-hint">Comma-separated product codes</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="branchPull()">${GEN_ICON} Generate Pull SQL</button>
</div>
<div id="bPullResult"></div>

${offlineCallout('Run each query on the database it targets', 'Copy the Source query to your Source DB tool, run it, save the JSON result. Repeat for the Destination query. Return below with both result-sets.')}

<div class="section-header"><div class="section-badge">2</div><h3>Paste Result-sets</h3></div>
<p class="section-hint">Drop the JSON output of each pull query into the matching slot below.</p>

<div class="json-grid">
  <div class="json-group">
    <div class="json-label-row">
      <label>Source Branch &amp; Product Snapshot <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="bJson1" placeholder="Paste the JSON returned by the Source DB pull query…"></textarea>
  </div>
  <div class="json-group">
    <div class="json-label-row">
      <label>Destination Branch &amp; Product State <span class="required">*</span></label>
      <span class="db-pill dest">DESTINATION</span>
    </div>
    <textarea id="bJson2" placeholder="Paste the JSON returned by the Destination DB pull query…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="branchFinal()">${FIN_ICON} Generate Final SQL</button>
</div>

${outputCard('Migration SQL', 'Generated migration. Review every statement before executing on Destination.', finalSQLBox('bFinal'))}`;
}

function branchPull() {
  const bTenant = document.getElementById('bTenant');
  const bBranches = document.getElementById('bBranches');
  const bProducts = document.getElementById('bProducts');
  [bTenant, bBranches, bProducts].forEach(normalizeInput);
  if (!validateFields([
    {el: bTenant,   label: 'Tenant Code'},
    {el: bBranches, label: 'Branch Codes'},
    {el: bProducts, label: 'Product Codes'},
  ])) return;
  const btn = activeButton(); setLoading(btn, true);

  fetch("/branch/pull", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: bTenant.value, branches: bBranches.value, products: bProducts.value}) })
  .then(r => r.json()).then(data => {
    renderPullResult('bPullResult', data);
    const hasSrc  = data.source_query && data.source_query.trim();
    const hasDest = data.destination_query && data.destination_query.trim();
    const parts = [hasSrc && "Source DB", hasDest && "Destination DB"].filter(Boolean);
    showToast("Pull SQL Generated",
      `Note: ${parts.join(' & ')} quer${parts.length > 1 ? 'ies' : 'y'} ready. Run on the respective database${parts.length > 1 ? 's' : ''}.`,
      "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Pull SQL. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

function branchFinal() {
  normalizeInput(document.getElementById('bTenant'));
  const bJson1 = document.getElementById('bJson1');
  const bJson2 = document.getElementById('bJson2');
  if (!validateJSON([
    {el: bJson1, label: 'Source Branch & Product Snapshot'},
    {el: bJson2, label: 'Destination Branch & Product State'},
  ])) return;
  const btn = activeButton(); setLoading(btn, true);

  fetch("/branch/final", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: document.getElementById('bTenant').value, source_json: bJson1.value, existing_json: bJson2.value}) })
  .then(r => r.json()).then(d => {
    const finalEl = document.getElementById('bFinal');
    finalEl.value = d.result;
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    if (d.notes && d.notes.length) showModal(d.notes);
    const hasSQL = d.result && d.result.trim();
    showToast(
      hasSQL ? "Final SQL Generated" : "No Changes Detected",
      hasSQL ? "Note: Review all statements before executing on Destination DB."
             : "Note: Source and Destination configurations are identical.",
      hasSQL ? "success" : "info"
    );
  }).catch(() => showToast("Server Error", "Note: Failed to generate Final SQL. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

/* ═══════════════════════════════════════════════════════════════════
   WORKFLOW SYNC
═══════════════════════════════════════════════════════════════════ */
function loadWorkflow() {
  document.getElementById('content').innerHTML = `
${flowRibbon('workflow')}

<div class="section-header"><div class="section-badge">1</div><h3>Configure &amp; Emit Pull Query</h3></div>
<p class="section-hint">Tenant is required. Branches and Products narrow the scope — leave blank to capture everything for the tenant.</p>

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="wTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
  <div class="form-group">
    <label>Branch Codes</label>
    <input id="wBranches" placeholder="e.g. BR001, BR002 (optional)">
    <span class="field-hint">Optional — leave blank for all branches</span>
  </div>
  <div class="form-group">
    <label>Product Codes</label>
    <input id="wProducts" placeholder="e.g. PROD_A, PROD_B (optional)">
    <span class="field-hint">Optional — leave blank for all products</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="workflowPull()">${GEN_ICON} Generate Pull SQL</button>
</div>
<div id="wPullResult"></div>

${offlineCallout('Run the pull query on the Source database', 'Copy the Source query above, execute it in your DB tool, and return below with the JSON output. A group-remapping prompt will appear before the migration SQL is built.')}

<div class="section-header"><div class="section-badge">2</div><h3>Paste Source Result-set</h3></div>
<p class="section-hint">Drop the JSON output from the Source DB pull below.</p>

<div class="json-grid single">
  <div class="json-group">
    <div class="json-label-row">
      <label>Source Workflow Configuration <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="wJson" placeholder="Paste the JSON returned by the Source DB pull query…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="workflowFinal()">${FIN_ICON} Generate Final SQL</button>
</div>

${outputCard('Migration SQL', 'Generated migration. Review every statement before executing on Destination.', finalSQLBox('wFinal'))}`;
}

function workflowPull() {
  const wTenant = document.getElementById('wTenant');
  const wBranches = document.getElementById('wBranches');
  const wProducts = document.getElementById('wProducts');
  [wTenant, wBranches, wProducts].forEach(normalizeInput);
  if (!validateFields([{el: wTenant, label: 'Tenant Code'}])) return;
  const btn = activeButton(); setLoading(btn, true);

  fetch("/workflow/pull", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      tenant: wTenant.value,
      branches: document.getElementById('wBranches').value,
      products: document.getElementById('wProducts').value
    }) })
  .then(r => r.json()).then(data => {
    renderPullResult('wPullResult', data);
    const hasSrc = data.source_query && data.source_query.trim();
    showToast("Pull SQL Generated",
      `Note: ${hasSrc ? 'Source DB query ready. Run on Source DB.' : 'No query generated.'}`,
      "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Pull SQL. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

async function workflowFinal() {
  ['wTenant','wBranches','wProducts'].forEach(id => normalizeInput(document.getElementById(id)));
  const wJson = document.getElementById('wJson');
  if (!validateJSON([{el: wJson, label: 'Source Workflow Configuration'}])) return;

  let rows;
  try {
    rows = JSON.parse(wJson.value);
  } catch (e) {
    showToast("Invalid JSON", "Note: Fix the Source Workflow Configuration.", "error");
    return;
  }

  if (!Array.isArray(rows)) {
    showToast("Invalid JSON", "Note: Source Workflow Configuration must be a JSON array.", "error");
    return;
  }

  const groups = getWorkflowGroupCandidates(rows);
  let payloadRows = rows;

  if (groups.length) {
    const remap = await openWorkflowGroupRemapModal(groups);
    if (!remap) {
      showToast("Cancelled", "Note: Final SQL generation was cancelled.", "info");
      return;
    }
    payloadRows = applyWorkflowGroupRemap(rows, remap);
  }

  const btn = activeButton(); setLoading(btn, true);
  fetch("/workflow/final", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      tenant: document.getElementById('wTenant').value,
      branches: document.getElementById('wBranches').value,
      source_json: JSON.stringify(payloadRows)
    }) })
  .then(r => r.json()).then(d => {
    const finalEl = document.getElementById('wFinal');
    finalEl.value = d.result;
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    showToast("Final SQL Generated", "Note: Review and execute on Destination DB.", "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Final SQL. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

/* ═══════════════════════════════════════════════════════════════════
   FEATURE FLAG SYNC
═══════════════════════════════════════════════════════════════════ */
function loadFeatureFlag() {
  document.getElementById('content').innerHTML = `
${flowRibbon('feature')}

<div class="section-header"><div class="section-badge">1</div><h3>Configure &amp; Emit Pull Queries</h3></div>
<p class="section-hint">A tenant code is enough — the console emits both Source and Destination queries to capture the current feature-flag state.</p>

<div class="form-row">
  <div class="form-group">
    <label>Tenant Code <span class="required">*</span></label>
    <input id="ffTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">Organization / tenant identifier</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="featureFlagPull()">${GEN_ICON} Generate Pull SQL</button>
</div>
<div id="ffPullResult"></div>

${offlineCallout('Run each query on the database it targets', 'Copy the Source query to your Source DB tool, run it, save the JSON result. Repeat for the Destination query. Return below with both result-sets.')}

<div class="section-header"><div class="section-badge">2</div><h3>Paste Result-sets</h3></div>
<p class="section-hint">Drop the JSON output of each pull query into the matching slot below.</p>

<div class="json-grid">
  <div class="json-group">
    <div class="json-label-row">
      <label>Source Feature Flags <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="ffJson1" placeholder="Paste the JSON returned by the Source DB pull query…"></textarea>
  </div>
  <div class="json-group">
    <div class="json-label-row">
      <label>Destination Feature Flags <span class="required">*</span></label>
      <span class="db-pill dest">DESTINATION</span>
    </div>
    <textarea id="ffJson2" placeholder="Paste the JSON returned by the Destination DB pull query…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="featureFlagFinal()">${FIN_ICON} Generate Final SQL</button>
</div>

${outputCard('Migration SQL', 'Generated migration. Review every statement before executing on Destination.', finalSQLBox('ffFinal'))}`;
}

function featureFlagPull() {
  const ffTenant = document.getElementById('ffTenant');
  normalizeInput(ffTenant);
  if (!validateFields([{el: ffTenant, label: 'Tenant Code'}])) return;
  const btn = activeButton(); setLoading(btn, true);

  fetch("/feature-flag/pull", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: ffTenant.value}) })
  .then(r => r.json()).then(data => {
    renderPullResult('ffPullResult', data);
    const hasSrc  = data.source_query && data.source_query.trim();
    const hasDest = data.destination_query && data.destination_query.trim();
    const parts = [hasSrc && "Source DB", hasDest && "Destination DB"].filter(Boolean);
    showToast("Pull SQL Generated",
      `Note: ${parts.join(' & ')} quer${parts.length > 1 ? 'ies' : 'y'} ready. Copy each and run on the respective database.`,
      "success");
  }).catch(() => showToast("Server Error", "Note: Failed to generate Pull SQL. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

function featureFlagFinal() {
  normalizeInput(document.getElementById('ffTenant'));
  const ffJson1 = document.getElementById('ffJson1');
  const ffJson2 = document.getElementById('ffJson2');
  if (!validateJSON([
    {el: ffJson1, label: 'Source Feature Flags'},
    {el: ffJson2, label: 'Destination Feature Flags'},
  ])) return;
  const btn = activeButton(); setLoading(btn, true);

  fetch("/feature-flag/final", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({tenant: document.getElementById('ffTenant').value, source_json: ffJson1.value, existing_json: ffJson2.value}) })
  .then(r => r.json()).then(d => {
    const finalEl = document.getElementById('ffFinal');
    finalEl.value = d.result;
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    if (d.notes && d.notes.length) showModal(d.notes);
    const hasSQL = d.result && d.result.trim();
    showToast(
      hasSQL ? "Final SQL Generated" : "No Changes Detected",
      hasSQL ? "Note: Review all statements before executing on Destination DB."
             : "Note: Source and Destination configurations are identical — no SQL generated.",
      hasSQL ? "success" : "info"
    );
  }).catch(() => showToast("Server Error", "Note: Failed to generate Final SQL. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

/* ═══════════════════════════════════════════════════════════════════
   MQ COMPARISON
═══════════════════════════════════════════════════════════════════ */
function loadMqComparison() {
  document.getElementById('content').innerHTML = `
${flowRibbon('mq')}

<div class="section-header"><div class="section-badge">1</div><h3>Paste MQ Definition Exports</h3></div>
<p class="section-hint">Drop the RabbitMQ <code class="inline-code">definitions.json</code> export from each broker. The console identifies missing queues, exchanges and bindings.</p>

<div class="json-grid">
  <div class="json-group">
    <div class="json-label-row">
      <label>Source Broker Definitions <span class="required">*</span></label>
      <span class="db-pill source">SOURCE</span>
    </div>
    <textarea id="mqSourceJson" class="mq-json-input" placeholder="Paste the RabbitMQ definitions.json export from the Source broker…"></textarea>
  </div>
  <div class="json-group">
    <div class="json-label-row">
      <label>Destination Broker Definitions <span class="required">*</span></label>
      <span class="db-pill dest">DESTINATION</span>
    </div>
    <textarea id="mqDestinationJson" class="mq-json-input" placeholder="Paste the RabbitMQ definitions.json export from the Destination broker…"></textarea>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="mqCompare()">${FIN_ICON} Compare MQ JSON</button>
</div>

${outputCard('Comparison Output', 'Queues are grouped with their related exchange details and queue bindings.', '<div id="mqResult" class="mq-result-empty">Run a comparison to view MQ differences.</div>')}`;
}

function mqText(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function mqValue(value) {
  return escapeHtml(mqText(value));
}

function mqCode(value) {
  return `<code class="mq-code">${mqValue(value)}</code>`;
}

function mqCopy(value, label, extraClass = '') {
  const text = mqText(value);
  return `
    <button
      type="button"
      class="mq-copy ${extraClass}"
      data-copy="${escapeHtml(text)}"
      data-copy-label="${escapeHtml(label)}"
      onclick="copyMqText(this, event)"
      aria-label="Copy ${escapeHtml(label)}"
    >${mqValue(value)}</button>`;
}

function mqCopyCode(value, label) {
  return mqCopy(value, label, 'mq-code');
}

function copyMqText(el, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const text = el.dataset.copy || '';
  const label = el.dataset.copyLabel || 'Value';
  if (!text || text === '-') {
    showToast("Nothing to Copy", `No ${label.toLowerCase()} available.`, "warning");
    return;
  }

  const done = () => {
    el.classList.add('copied');
    clearTimeout(el._copiedTimer);
    el._copiedTimer = setTimeout(() => el.classList.remove('copied'), 1100);
    showToast("Copied!", `${label} copied to clipboard.`, "success");
  };
  const fallbackCopy = () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    done();
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

function mqQueueKey(vhost, name) {
  return `${vhost || '/'}::${name || ''}`;
}

function renderMqCountCard(label, counts, tone) {
  return `
    <div class="mq-count-card ${tone || ''}">
      <div class="mq-count-label">${escapeHtml(label)}</div>
      <div class="mq-count-row"><span>Queues</span><strong>${counts.queues || 0}</strong></div>
      <div class="mq-count-row"><span>Exchanges</span><strong>${counts.exchanges || 0}</strong></div>
      <div class="mq-count-row"><span>Bindings</span><strong>${counts.bindings || 0}</strong></div>
    </div>`;
}

/* ── MQ output actions: copy report, copy JSON, download ─────── */
function renderMqActions() {
  return `
    <div class="mq-actions">
      <span class="mq-actions-label">Export Report</span>
      <div class="mq-actions-row">
        <button type="button" class="mq-action" onclick="copyMqReport('text')">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><rect x="9" y="9" width="13" height="13" rx="1.5"/><rect x="2" y="2" width="13" height="13" rx="1.5"/></svg>
          Copy as Text
        </button>
        <button type="button" class="mq-action" onclick="copyMqReport('json')">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-2M16 4l4 4m0 0l-4 4m4-4H10"/></svg>
          Copy as JSON
        </button>
        <button type="button" class="mq-action" onclick="downloadMqReport('text')">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
          Download .txt
        </button>
        <button type="button" class="mq-action" onclick="downloadMqReport('json')">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
          Download .json
        </button>
      </div>
    </div>`;
}

function buildMqTextReport(data) {
  const lines = [];
  const stamp = new Date().toISOString();
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  MQ COMPARISON REPORT');
  lines.push('  Generated: ' + stamp);
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  const s = data.summary || {};
  function counts(label, c) {
    c = c || {};
    lines.push(`  ${label.padEnd(28)}  queues=${c.queues || 0}  exchanges=${c.exchanges || 0}  bindings=${c.bindings || 0}`);
  }
  lines.push('SUMMARY');
  lines.push('---------------------------------------------------------------');
  counts('Source export',          s.source);
  counts('Destination export',     s.destination);
  counts('Missing in Destination', s.missing_in_destination);
  counts('Only in Destination',    s.only_in_destination);
  lines.push('');

  if (!data.has_differences) {
    lines.push('RESULT  ✓  Source and Destination definitions are identical.');
    return lines.join('\n');
  }

  function block(title, grp) {
    lines.push(title);
    lines.push('---------------------------------------------------------------');
    const queues = (grp || {}).queues || [];
    const exchanges = (grp || {}).exchanges || [];
    const bindings = (grp || {}).bindings || [];
    if (!queues.length && !exchanges.length && !bindings.length) {
      lines.push('  (none)');
      lines.push('');
      return;
    }
    if (queues.length) {
      lines.push('  · Queues (' + queues.length + ')');
      queues.forEach(r => {
        const q = r.queue || {};
        lines.push(`      - ${q.vhost || '/'}::${q.name || '?'}  durable=${q.durable}  auto_delete=${q.auto_delete}`);
        (r.bindings || []).forEach(b => {
          lines.push(`          binding: ${b.source || '?'} -[${b.routing_key || ''}]-> ${b.destination || '?'}`);
        });
      });
    }
    if (exchanges.length) {
      lines.push('  · Exchanges (' + exchanges.length + ')');
      exchanges.forEach(e => lines.push(`      - ${e.vhost || '/'}::${e.name || '?'} (${e.type || '-'})  durable=${e.durable}`));
    }
    if (bindings.length) {
      lines.push('  · Standalone Bindings (' + bindings.length + ')');
      bindings.forEach(b => lines.push(`      - ${b.vhost || '/'}: ${b.source || '?'} -[${b.routing_key || ''}]-> ${b.destination || '?'}`));
    }
    lines.push('');
  }
  block('SOURCE ITEMS MISSING IN DESTINATION', data.missing_in_destination);
  block('DESTINATION-ONLY ITEMS',              data.only_in_destination);
  return lines.join('\n');
}

function copyMqReport(format) {
  const data = window.__lastMqComparison;
  if (!data) return showToast('Nothing to Copy', 'Note: Run a comparison first.', 'warning');
  const text = format === 'json' ? JSON.stringify(data, null, 2) : buildMqTextReport(data);
  navigator.clipboard.writeText(text).then(
    () => showToast('Copied!', `Comparison report copied as ${format === 'json' ? 'JSON' : 'text'}.`, 'success'),
    () => showToast('Copy Failed', 'Note: Clipboard access denied.', 'error')
  );
}

function downloadMqReport(format) {
  const data = window.__lastMqComparison;
  if (!data) return showToast('Nothing to Download', 'Note: Run a comparison first.', 'warning');
  const isJson = format === 'json';
  const text = isJson ? JSON.stringify(data, null, 2) : buildMqTextReport(data);
  const blob = new Blob([text], { type: isJson ? 'application/json' : 'text/plain' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `mq-comparison-${ts}.${isJson ? 'json' : 'txt'}`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  showToast('Downloaded!', `Saved as ${a.download}`, 'success');
}

function renderMqSummary(summary) {
  return `
    <div class="mq-summary-grid">
      ${renderMqCountCard('Source Export', summary.source || {}, 'source')}
      ${renderMqCountCard('Destination Export', summary.destination || {}, 'dest')}
      ${renderMqCountCard('Missing in Destination', summary.missing_in_destination || {}, 'warning')}
      ${renderMqCountCard('Only in Destination', summary.only_in_destination || {}, 'muted')}
    </div>`;
}

function renderMqExchangeChips(exchanges) {
  if (!exchanges || !exchanges.length) {
    return `<span class="mq-empty-line">No exchange definition found for these bindings.</span>`;
  }
  return exchanges.map(exchange => `
    <span class="mq-chip">
      ${mqCopy(exchange.name, 'Exchange name', 'mq-chip-name')}
      <small>${mqValue(exchange.type)}</small>
    </span>
  `).join('');
}

function renderMqBindingTable(bindings) {
  if (!bindings || !bindings.length) {
    return `<div class="mq-empty-line">No queue bindings found.</div>`;
  }
  const rows = bindings.map(binding => `
    <tr>
      <td>${mqCopyCode(binding.source, 'Exchange name')}</td>
      <td>${mqCopyCode(binding.routing_key, 'Routing key')}</td>
      <td>${mqCopyCode(binding.destination, 'Queue name')}</td>
      <td>${mqCode(binding.arguments)}</td>
    </tr>
  `).join('');
  return `
    <div class="mq-table-wrap">
      <table class="mq-table">
        <thead>
          <tr>
            <th>Exchange</th>
            <th>Routing Key</th>
            <th>Queue</th>
            <th>Arguments</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderMqQueueReports(title, reports, emptyText) {
  if (!reports || !reports.length) {
    return `
      <details class="mq-panel">
        <summary class="mq-panel-header">
          <h4>${escapeHtml(title)}</h4>
          <span>0</span>
        </summary>
        <div class="mq-empty-line">${escapeHtml(emptyText || 'No queues found.')}</div>
      </details>`;
  }

  const items = reports.map(report => {
    const queue = report.queue || {};
    return `
      <article class="mq-queue-item">
        <div class="mq-queue-head">
          <div>
            ${mqCopy(queue.name, 'Queue name', 'mq-queue-name')}
            <div class="mq-queue-vhost">vhost ${mqValue(queue.vhost || '/')}</div>
          </div>
          <div class="mq-queue-flags">
            <span>durable: ${mqValue(queue.durable)}</span>
            <span>auto delete: ${mqValue(queue.auto_delete)}</span>
          </div>
        </div>
        <dl class="mq-definition-list">
          <div>
            <dt>Queue Arguments</dt>
            <dd>${mqCode(queue.arguments)}</dd>
          </div>
          <div>
            <dt>Exchange</dt>
            <dd><div class="mq-chip-row">${renderMqExchangeChips(report.exchanges || [])}</div></dd>
          </div>
        </dl>
        <div class="mq-subtitle">Bindings</div>
        ${renderMqBindingTable(report.bindings || [])}
      </article>`;
  }).join('');

  return `
    <details class="mq-panel">
      <summary class="mq-panel-header">
        <h4>${escapeHtml(title)}</h4>
        <span>${reports.length}</span>
      </summary>
      <div class="mq-queue-list">${items}</div>
    </details>`;
}

function renderMqResourceTable(title, resources, type, emptyText) {
  const count = resources ? resources.length : 0;
  if (!count) {
    return `
      <details class="mq-panel">
        <summary class="mq-panel-header">
          <h4>${escapeHtml(title)}</h4>
          <span>0</span>
        </summary>
        <div class="mq-empty-line">${escapeHtml(emptyText || 'No items found.')}</div>
      </details>`;
  }

  const rows = resources.map(resource => {
    if (type === 'binding') {
      return `
        <tr>
          <td>${mqCode(resource.vhost || '/')}</td>
          <td>${mqCopyCode(resource.source, 'Exchange name')}</td>
          <td>${mqCopyCode(resource.destination, 'Queue name')}</td>
          <td>${mqCopyCode(resource.routing_key, 'Routing key')}</td>
          <td>${mqCode(resource.arguments)}</td>
        </tr>`;
    }
    return `
      <tr>
        <td>${mqCode(resource.vhost || '/')}</td>
        <td>${mqCopyCode(resource.name, 'Exchange name')}</td>
        <td>${mqCode(resource.type || '-')}</td>
        <td>${mqCode(resource.durable)}</td>
        <td>${mqCode(resource.arguments)}</td>
      </tr>`;
  }).join('');
  const header = type === 'binding'
    ? `<tr><th>Vhost</th><th>Exchange</th><th>Queue</th><th>Routing Key</th><th>Arguments</th></tr>`
    : `<tr><th>Vhost</th><th>Name</th><th>Type</th><th>Durable</th><th>Arguments</th></tr>`;
  return `
    <details class="mq-panel">
      <summary class="mq-panel-header">
        <h4>${escapeHtml(title)}</h4>
        <span>${count}</span>
      </summary>
      <div class="mq-table-wrap">
        <table class="mq-table">
          <thead>${header}</thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

function filterBindingsOutsideQueues(bindings, queueReports) {
  const queueKeys = new Set((queueReports || []).map(report => {
    const queue = report.queue || {};
    return mqQueueKey(queue.vhost, queue.name);
  }));
  return (bindings || []).filter(binding => !queueKeys.has(mqQueueKey(binding.vhost, binding.destination)));
}

function renderMqComparisonGroup(title, group, options = {}) {
  const queues = group.queues || [];
  const standaloneBindings = filterBindingsOutsideQueues(group.bindings || [], queues);
  return `
    <div class="mq-group">
      <div class="mq-group-header">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(options.hint || '')}</p>
      </div>
      ${renderMqQueueReports(options.queueTitle || 'Queues', queues, options.queueEmpty)}
      ${renderMqResourceTable(options.exchangeTitle || 'Exchange Definitions', group.exchanges || [], 'exchange', options.exchangeEmpty)}
      ${renderMqResourceTable(options.bindingTitle || 'Standalone Binding Differences', standaloneBindings, 'binding', options.bindingEmpty)}
    </div>`;
}

function renderMqComparison(data) {
  const result = document.getElementById('mqResult');
  const missing = data.missing_in_destination || {};
  const destinationOnly = data.only_in_destination || {};

  result.className = 'mq-result';
  let html = renderMqActions();
  html += renderMqSummary(data.summary || {});

  if (!data.has_differences) {
    result.innerHTML = html + `<div class="mq-no-diff">Source and Destination MQ definitions are identical for queues, exchanges and bindings.</div>`;
    return;
  }

  html += renderMqComparisonGroup('Source Items Missing in Destination', missing, {
    hint: 'Create or align these items in Destination to match Source.',
    queueTitle: 'Queues with Exchange and Binding Details',
    queueEmpty: 'No source queues are missing in Destination.',
    exchangeTitle: 'Exchange Definitions Missing in Destination',
    exchangeEmpty: 'No exchange definitions are missing in Destination.',
    bindingTitle: 'Bindings Missing for Existing Queues',
    bindingEmpty: 'No standalone binding differences. Queue bindings are shown under each missing queue.',
  });

  const hasDestinationOnly = (destinationOnly.queues || []).length
    || (destinationOnly.exchanges || []).length
    || (destinationOnly.bindings || []).length;
  if (hasDestinationOnly) {
    html += `
      <details class="mq-details">
        <summary>Review destination-only items</summary>
        ${renderMqComparisonGroup('Destination-only Items', destinationOnly, {
          hint: 'These exist in Destination but not in Source.',
          queueTitle: 'Queues Only in Destination',
          queueEmpty: 'No destination-only queues found.',
          exchangeTitle: 'Exchange Definitions Only in Destination',
          exchangeEmpty: 'No destination-only exchange definitions found.',
          bindingTitle: 'Bindings Only in Destination for Existing Queues',
          bindingEmpty: 'No standalone destination-only binding differences.',
        })}
      </details>`;
  }

  result.innerHTML = html;
}

function mqCompare() {
  const sourceJson = document.getElementById('mqSourceJson');
  const destinationJson = document.getElementById('mqDestinationJson');
  if (!validateJSON([
    {el: sourceJson, label: 'Source Broker Definitions'},
    {el: destinationJson, label: 'Destination Broker Definitions'},
  ])) return;
  const btn = activeButton(); setLoading(btn, true);

  fetch("/mq/compare", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({source_json: sourceJson.value, destination_json: destinationJson.value}) })
  .then(r => r.json()).then(data => {
    window.__lastMqComparison = data;
    renderMqComparison(data);
    const missing = data.summary?.missing_in_destination || {};
    const missingCount = (missing.queues || 0) + (missing.exchanges || 0) + (missing.bindings || 0);
    showToast(
      missingCount ? "MQ Differences Found" : "No Source Gaps",
      missingCount ? `Note: ${missingCount} source item${missingCount > 1 ? 's are' : ' is'} missing in Destination.`
                   : "Note: Destination has all Source queues, exchanges and bindings.",
      missingCount ? "warning" : "success"
    );
  }).catch(() => showToast("Server Error", "Note: Failed to compare MQ JSON. Check server logs.", "error"))
   .finally(() => setLoading(btn, false));
}

/* ── Flow stepper sync ──────────────────────────────────────────
 * Observes the DOM after each tab render and updates the ribbon's
 * step states based on what's rendered. This never modifies the
 * existing handlers — it's a passive reflection of real state.
 */
(function flowSync() {
  const TAB_TO_FLOW = { branch: 'branch', workflow: 'workflow', feature: 'feature', mq: 'mq' };

  function setState(prefix, stateMap) {
    const ribbon = document.querySelector(`.flow-ribbon[data-flow="${prefix}"]`);
    if (!ribbon) return;
    Object.keys(stateMap).forEach(stepKey => {
      const el = ribbon.querySelector(`.flow-step[data-step="${stepKey}"]`);
      if (el) el.dataset.state = stateMap[stepKey];
    });
  }

  function syncBranchLike(flow, ids) {
    const pull = document.getElementById(ids.pullResult);
    const final = document.getElementById(ids.final);
    const hasPull = pull && pull.children.length > 0;
    const hasFinal = final && final.value && final.value.trim();
    setState(flow, {
      configure: hasPull ? 'done' : 'active',
      emit:      hasFinal ? 'done' : (hasPull ? 'done' : 'pending'),
      run:       hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      paste:     hasFinal ? 'done' : (hasPull ? 'active' : 'pending'),
      final:     hasFinal ? 'active' : 'pending',
    });
  }

  function syncMq() {
    const src  = document.getElementById('mqSourceJson');
    const dst  = document.getElementById('mqDestinationJson');
    const out  = document.getElementById('mqResult');
    const hasSrc = src && src.value && src.value.trim();
    const hasDst = dst && dst.value && dst.value.trim();
    const hasOut = out && out.classList && !out.classList.contains('mq-result-empty');
    setState('mq', {
      paste:  hasSrc ? 'done' : 'active',
      paste2: hasDst ? 'done' : (hasSrc ? 'active' : 'pending'),
      run:    hasOut ? 'done' : ((hasSrc && hasDst) ? 'active' : 'pending'),
      review: hasOut ? 'active' : 'pending',
    });
  }

  function activeFlow() {
    const active = document.querySelector('.tabs button.active');
    if (!active) return null;
    const onclick = active.getAttribute('onclick') || '';
    const match = onclick.match(/switchTab\('(\w+)'\)/);
    return match ? TAB_TO_FLOW[match[1]] : null;
  }

  function refresh() {
    const flow = activeFlow();
    if (flow === 'branch')   syncBranchLike('branch',   { pullResult: 'bPullResult',  final: 'bFinal'  });
    else if (flow === 'workflow') syncBranchLike('workflow', { pullResult: 'wPullResult',  final: 'wFinal'  });
    else if (flow === 'feature')  syncBranchLike('feature',  { pullResult: 'ffPullResult', final: 'ffFinal' });
    else if (flow === 'mq')   syncMq();
    // Decorate any new .json-group with an upload button & wire input
    // normalization on freshly-rendered inputs. Both are idempotent —
    // they no-op for elements already wired.
    decorateJsonGroups();
    wireInputNormalization();
    // Lock post-step fields (paste textareas + final-SQL button) when the
    // pre-step (pull queries / source paste) hasn't been completed yet.
    gateSteps();
  }

  /* ── Step gating ─────────────────────────────────────────────
   * Post-step fields stay disabled until the pre-step is complete.
   *   Branch/Workflow/Feature Flag: JSON paste + Final-SQL button gated
   *     on the corresponding *PullResult div being populated.
   *   MQ:                        Compare button gated on both source &
   *     destination JSON being non-empty.
   * Passive — uses .disabled on inputs/buttons and a .is-locked class
   * on .json-group for the diagonal-stripe overlay. No handler changes.
   */
  function gateSteps() {
    const groups = [
      { pull: 'bPullResult',  jsons: ['bJson1','bJson2'], submit: 'branchFinal' },
      { pull: 'wPullResult',  jsons: ['wJson'],           submit: 'workflowFinal' },
      { pull: 'ffPullResult', jsons: ['ffJson1','ffJson2'], submit: 'featureFlagFinal' },
    ];
    groups.forEach(g => {
      const pull = document.getElementById(g.pull);
      if (!pull) return;
      const hasPull = pull.children.length > 0;
      g.jsons.forEach(id => {
        const t = document.getElementById(id);
        if (!t) return;
        t.disabled = !hasPull;
        const jg = t.closest('.json-group');
        if (jg) jg.classList.toggle('is-locked', !hasPull);
        // Disable the per-group upload button too — pasting via file
        // when the textarea is locked would feel inconsistent.
        const up = jg && jg.querySelector('.json-upload-btn');
        if (up) up.disabled = !hasPull;
      });
      const btn = document.querySelector(`button.primary[onclick="${g.submit}()"]`);
      if (btn) btn.disabled = !hasPull;
    });

    const mqSrc = document.getElementById('mqSourceJson');
    const mqDst = document.getElementById('mqDestinationJson');
    const mqBtn = document.querySelector('button.primary[onclick="mqCompare()"]');
    if (mqSrc && mqDst && mqBtn) {
      const ok = mqSrc.value.trim() && mqDst.value.trim();
      mqBtn.disabled = !ok;
    }
  }

  // Observe content area for any DOM changes (tab swap, result renders,
  // textarea value mutations via JS) and re-derive step states.
  const content = document.getElementById('content');
  if (content) {
    const obs = new MutationObserver(() => refresh());
    obs.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'value'] });
  }
  // Also observe input events on the content area for paste/typing.
  document.addEventListener('input', e => {
    if (e.target && e.target.closest && e.target.closest('#content')) refresh();
  }, true);
  // First paint
  setTimeout(refresh, 50);
  // Re-run on each tab switch (after switchTab has rebuilt the content)
  document.querySelectorAll('.tabs button').forEach(b => {
    b.addEventListener('click', () => setTimeout(refresh, 30));
  });
})();

/* ── Init ───────────────────────────────────────────────────────── */
loadBranch();
