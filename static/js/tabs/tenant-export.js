/* ============================================================
 *  tabs/tenant-export.js — Full Tenant Export (v2 schema only).
 *
 *  Exports every configuration table linked to one tenant, compares it
 *  against the destination, and emits INSERT / UPDATE statements. DELETE
 *  is only ever produced for workflow and transition.
 *
 *  Structure
 *  ─────────
 *    · render()            builds the five sections
 *    · analysePasted()     parses both payloads, fills row counts
 *    · table picker        multiselect driving which tables get emitted
 *    · openTablePreview()  per-table table view, editable, writes back
 *    · confirmation gate   mandatory review of environment-specific values
 *    · tenantExportFinal() posts selection + confirmations, renders output
 *
 *  The table list, its columns and which tables count as
 *  environment-specific all come from the backend registry via
 *  /tenant-export/tables — this file never hardcodes a table name.
 * ============================================================ */

import { ICONS, exposeGlobals, escapeHtml } from '../lib/dom.js';
import { showToast } from '../lib/toast.js';
import { showNotesModal } from '../lib/modal.js';
import { setLoading, activeButton } from '../lib/feedback.js';
import { validateFields, normalizeInput, registerInputs, extractJsonArray,
         repairJson, tryRepairTextarea } from '../lib/data.js';
import { flowRibbon, sectionHeader, offlineCallout, outputCard, finalSqlBox, jsonGroup,
         renderPullResult } from '../components/sections.js';
import { openTableModal } from '../components/table-modal.js';
import { collectGroupNames, applyGroupRemap, openGroupRemapModal, remapGroupsInText,
         exposeRemapGlobals } from '../components/group-remap.js';

registerInputs({ plain: ['teTenant'] });

const FLOW = [
  { key: 'configure', glyph: '◐', label: 'Configure' },
  { key: 'emit',      glyph: '⇆', label: 'Pull Queries' },
  { key: 'run',       glyph: '↗', label: 'Run on DBs', external: true },
  { key: 'paste',     glyph: '⇋', label: 'Paste JSON' },
  { key: 'select',    glyph: '☰', label: 'Pick Tables' },
  { key: 'final',     glyph: '▣', label: 'Migration SQL' },
];

/* ── Module state ─────────────────────────────────────────────
 * `meta` is the backend registry description, fetched once.
 * `source` / `destination` are the parsed payloads.
 * `selected` drives which tables are emitted; `confirmed` records the
 * environment-specific tables the user has explicitly signed off. */
const state = {
  meta:        null,
  source:      null,
  destination: null,
  selected:    new Set(),
  confirmed:   new Set(),
};

/* ── Render ───────────────────────────────────────────────── */

function render(host) {
  host.innerHTML = `
${flowRibbon('tenant', FLOW)}

${sectionHeader(1, 'Configure & Emit Pull Queries',
  'One organization code exports the tenant and everything linked to it — branches, products, modules, features, workflows and the catalogue rows they reference. No primary keys are exported; every reference travels as its natural code.')}

<div class="form-row">
  <div class="form-group">
    <label>Tenant Organization Code <span class="required">*</span></label>
    <input id="teTenant" placeholder="e.g. TENANT_ABC">
    <span class="field-hint">tenant.organization_code — the export is scoped to this tenant</span>
  </div>
</div>
<div class="btn-row">
  <button class="primary" onclick="tenantExportPull()">${ICONS.generate} Generate Pull SQL</button>
</div>
<div id="tePullResult"></div>

${offlineCallout('Run each query on the database it targets',
  'The Source query returns the complete tenant configuration as a single JSON document. The Destination query returns the same shape for comparison — if the tenant does not exist there yet it comes back empty, and everything becomes an INSERT.')}

${sectionHeader(2, 'Paste Result-sets',
  'Drop each JSON document into the matching slot. The Destination slot may be left empty for a brand-new tenant.')}

<div class="json-grid">
  ${jsonGroup({ id: 'teSourceJson', label: 'Source Tenant Export', side: 'source' })}
  ${jsonGroup({ id: 'teDestJson',   label: 'Destination Tenant State', side: 'dest',
                placeholder: 'Paste the Destination JSON — or leave empty if this tenant does not exist there yet…' })}
</div>
<div class="btn-row">
  <button class="secondary" onclick="tenantExportAnalyse()">${ICONS.generate} Analyse Pasted Data</button>
</div>

${sectionHeader(3, 'Select Tables to Generate',
  'Tick the tables to include. Unticked tables are skipped entirely — nothing is read from them and no statement is emitted. Open any table to review and edit its rows before generating.')}

<div id="teTablePicker" class="te-picker">
  <p class="te-picker-empty">Paste the Source export above and choose <strong>Analyse Pasted Data</strong> to list the tables.</p>
</div>

<div class="btn-row">
  <button class="primary" onclick="tenantExportFinal()">${ICONS.finish} Generate Final SQL</button>
</div>

<div id="teErrors" class="te-errors hidden" role="alert"></div>
<div id="teStats" class="te-stats hidden"></div>

${outputCard('Tenant Migration SQL',
  'INSERT and UPDATE for every selected table. DELETE appears only for workflow and transition.',
  finalSqlBox('teFinal'))}`;

  // The picker survives a tab switch: re-render it from state if we already
  // have parsed data, so the user does not have to analyse twice.
  if (state.meta && state.source) renderPicker();
}

/* ── Step 1: pull queries ─────────────────────────────────── */

function tenantExportPull() {
  const tenant = document.getElementById('teTenant');
  normalizeInput(tenant);
  if (!validateFields([{ el: tenant, label: 'Tenant Organization Code' }])) return;
  const btn = activeButton();
  setLoading(btn, true, 'building tenant export queries');

  fetch('/tenant-export/pull', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant: tenant.value }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) return showToast('Unavailable', 'Note: ' + data.error, 'error');
    renderPullResult('tePullResult', data);
    showToast('Pull SQL Generated',
      'Note: run the Source query on the source DB and the Destination query on the target DB.',
      'success');
  })
  .catch(() => showToast('Server Error', 'Note: Failed to generate Pull SQL. Check server logs.', 'error'))
  .finally(() => setLoading(btn, false));
}

/* ── Step 2: parse the pasted payloads ────────────────────── */

async function tenantExportAnalyse() {
  const sourceEl = document.getElementById('teSourceJson');
  if (!sourceEl || !sourceEl.value.trim()) {
    return showToast('Nothing to Analyse', 'Note: paste the Source tenant export first.', 'warning');
  }

  const btn = activeButton();
  setLoading(btn, true, 'parsing tenant export');
  try {
    if (!state.meta) state.meta = await fetchMeta();

    // Repair/unwrap in place first: both textareas stay the source of truth
    // for later edits and for the final POST, so a pasted DB dump has to be
    // replaced by the payload it wraps rather than parsed around.
    const destEl = document.getElementById('teDestJson');
    tryRepairTextarea(sourceEl, 'Source Tenant Export');
    if (destEl && destEl.value.trim()) tryRepairTextarea(destEl, 'Destination Tenant State');

    state.source = parsePayload(sourceEl.value, 'Source');
    state.destination = (destEl && destEl.value.trim())
      ? parsePayload(destEl.value, 'Destination')
      : {};
    assertKnownTables(state.source, 'Source');
    assertKnownTables(state.destination, 'Destination');

    // Default the selection to every table that actually carries rows —
    // ticking 41 empty tables by hand is not a decision worth asking for.
    state.selected = new Set(
      state.meta.tables.map(t => t.table).filter(t => rowsFor(t).length));
    state.confirmed = new Set();

    renderPicker();
    const tableCount = state.selected.size;
    const rowCount = state.meta.tables.reduce((n, t) => n + rowsFor(t.table).length, 0);
    showToast('Export Parsed',
      `Note: ${rowCount} row${rowCount === 1 ? '' : 's'} across ${tableCount} table${tableCount === 1 ? '' : 's'}. Review the selection below.`,
      'success');
  } catch (err) {
    showToast('Invalid JSON', 'Note: ' + err.message, 'error');
  } finally {
    setLoading(btn, false);
  }
}

function fetchMeta() {
  return fetch('/tenant-export/tables').then(r => r.json()).then(meta => {
    if (meta.error) throw new Error(meta.error);
    return meta;
  });
}

/** The export is one JSON object keyed by table name. Accept the wrappers a DB
 *  client may add (single-row array, {result: …}, the whole query text as the
 *  column name, double-encoded string) by reusing the same unwrapping the
 *  other tabs rely on. */
function parsePayload(text, label) {
  const { text: clean } = repairJson(text);
  let parsed;
  let parsable = true;
  try {
    parsed = JSON.parse(clean);
  } catch (_) {
    // Still not JSON — fall through so extractJsonArray reports the syntax error.
    parsable = false;
  }

  // An empty result set is legitimate: the tenant is not on that database yet.
  if (parsable && (parsed === null || (Array.isArray(parsed) && !parsed.length))) return {};

  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && !parsed.result) {
    return parsed;
  }

  const { rows } = extractJsonArray(clean);
  const first = rows && rows[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) return first;
  throw new Error(`${label} export is not a tenant export document (expected one JSON object keyed by table name).`);
}

/** A payload that parses but carries no known table name is a paste mistake —
 *  the wrong query, the wrong slot, or half a document. Unchecked it reads as
 *  "this tenant is not on the destination yet", so every row becomes a
 *  NOT EXISTS-guarded INSERT: nothing duplicates, but the differences the
 *  operator came to migrate are silently dropped. Fail loudly instead. */
function assertKnownTables(payload, label) {
  const keys = Object.keys(payload);
  if (!keys.length) return;                       // legitimately empty
  if (state.meta.tables.some(t => t.table in payload)) return;
  throw new Error(`${label} document has no recognised table names (found `
    + `${keys.slice(0, 2).map(k => JSON.stringify(k.slice(0, 40))).join(', ')}`
    + `${keys.length > 2 ? ', …' : ''}). Paste the result of the ${label} pull query.`);
}

function rowsFor(table) {
  const rows = state.source && state.source[table];
  return Array.isArray(rows) ? rows : [];
}

function destRowsFor(table) {
  const rows = state.destination && state.destination[table];
  return Array.isArray(rows) ? rows : [];
}

/* ── Step 3: the table picker ─────────────────────────────── */

function renderPicker() {
  const host = document.getElementById('teTablePicker');
  if (!host || !state.meta) return;

  const groups = state.meta.groups.map(renderGroup).join('');
  host.innerHTML = `
    <div class="te-picker-toolbar">
      <span class="te-picker-summary" id="tePickerSummary"></span>
      <span class="te-picker-toolbar-spacer"></span>
      <button type="button" class="secondary" onclick="tenantExportSelectAll(true)">Select all with rows</button>
      <button type="button" class="secondary" onclick="tenantExportSelectAll(false)">Clear all</button>
    </div>
    ${groups}`;
  updateSummary();
}

function renderGroup(group) {
  const rows = group.tables.map(renderPickerRow).join('');
  const withRows = group.tables.filter(t => rowsFor(t.table).length).length;
  return `
    <section class="te-group" data-group="${escapeHtml(group.group)}">
      <header class="te-group-head">
        <label class="te-group-toggle">
          <input type="checkbox" onchange="tenantExportToggleGroup('${escapeHtml(group.group)}', this.checked)"
                 ${withRows && group.tables.every(t => !rowsFor(t.table).length || state.selected.has(t.table)) ? 'checked' : ''}>
          <span>${escapeHtml(group.group)}</span>
        </label>
        <span class="te-group-count">${withRows} of ${group.tables.length} with rows</span>
      </header>
      <div class="te-group-body">${rows}</div>
    </section>`;
}

function renderPickerRow(table) {
  const count = rowsFor(table.table).length;
  const destCount = destRowsFor(table.table).length;
  const empty = count === 0;
  const badges = [
    table.env ? '<span class="te-badge env" title="Holds environment-specific values or credentials — requires confirmation">ENV</span>' : '',
    table.deletable ? '<span class="te-badge del" title="This table is deleted and re-inserted">REPLACE</span>' : '',
    table.mode === 'insert_only' ? '<span class="te-badge ins" title="Shared catalogue — inserted when missing, never updated">INSERT ONLY</span>' : '',
  ].join('');

  return `
    <label class="te-row${empty ? ' is-empty' : ''}${table.env ? ' is-env' : ''}">
      <input type="checkbox" value="${escapeHtml(table.table)}"
             ${state.selected.has(table.table) ? 'checked' : ''}
             ${empty ? 'disabled' : ''}
             onchange="tenantExportToggleTable(this.value, this.checked)">
      <span class="te-row-label">
        <span class="te-row-name">${escapeHtml(table.label)}</span>
        <code class="te-row-table">${escapeHtml(table.table)}</code>
        ${badges}
      </span>
      <span class="te-row-counts">
        <span class="te-count src" title="Rows in the source export">${count}</span>
        <span class="te-count-sep">→</span>
        <span class="te-count dst" title="Rows currently on the destination">${destCount}</span>
      </span>
      <button type="button" class="te-row-view" ${empty ? 'disabled' : ''}
              onclick="event.preventDefault();tenantExportPreview('${escapeHtml(table.table)}')"
              title="Preview and edit these rows">${ICONS.table} View</button>
    </label>`;
}

function updateSummary() {
  const el = document.getElementById('tePickerSummary');
  if (!el || !state.meta) return;
  const tables = [...state.selected];
  const rows = tables.reduce((n, t) => n + rowsFor(t).length, 0);
  const envSelected = tables.filter(t => tableMeta(t) && tableMeta(t).env);
  el.innerHTML =
    `<strong>${tables.length}</strong> table${tables.length === 1 ? '' : 's'} · `
    + `<strong>${rows}</strong> row${rows === 1 ? '' : 's'} selected`
    + (envSelected.length
        ? ` · <span class="te-summary-env">${envSelected.length} need confirmation</span>`
        : '');
}

function tableMeta(table) {
  return state.meta && state.meta.tables.find(t => t.table === table);
}

function tenantExportToggleTable(table, checked) {
  if (checked) state.selected.add(table);
  else { state.selected.delete(table); state.confirmed.delete(table); }
  updateSummary();
}

function tenantExportToggleGroup(group, checked) {
  const meta = state.meta.groups.find(g => g.group === group);
  if (!meta) return;
  meta.tables.forEach(t => {
    if (!rowsFor(t.table).length) return;   // never select an empty table
    if (checked) state.selected.add(t.table);
    else { state.selected.delete(t.table); state.confirmed.delete(t.table); }
  });
  renderPicker();
}

function tenantExportSelectAll(checked) {
  if (!checked) { state.selected.clear(); state.confirmed.clear(); }
  else state.selected = new Set(
    state.meta.tables.map(t => t.table).filter(t => rowsFor(t).length));
  renderPicker();
}

/* ── Per-table preview / edit ─────────────────────────────── */

/** Open one table's rows in the shared table modal. Edits are written back
 *  into the parsed source *and* re-serialised into the textarea, so the
 *  textarea stays the single source of truth for the next generate. */
function tenantExportPreview(table) {
  const meta = tableMeta(table);
  if (!meta) return;
  const rows = rowsFor(table);
  if (!rows.length) {
    return showToast('Nothing to Show', `Note: ${meta.label} has no rows in the source export.`, 'warning');
  }

  const keyFields = new Set(meta.key);
  const columns = meta.fields.map(field => ({
    key: field,
    label: field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    width: keyFields.has(field) ? 130 : 170,
    // Key fields identify the row on the destination; editing one silently
    // retargets the statement, so they are read-only here.
    editable: !keyFields.has(field),
  }));

  openTableModal({
    title: `${meta.label} — ${table}`,
    filename: table,
    filenamePrefix: () => {
      const v = (document.getElementById('teTenant')?.value || '').trim();
      return v ? v.replace(/[^A-Za-z0-9_.-]+/g, '_') : '';
    },
    columns,
    defaultSort: meta.key.slice(0, 2).map(col => ({ col, dir: 1 })),
    rows,
    onApply: (modifiedRows) => {
      state.source[table] = modifiedRows;
      syncSourceTextarea();
      renderPicker();
      showToast('Rows Updated',
        `Note: ${modifiedRows.length} row${modifiedRows.length === 1 ? '' : 's'} written back to ${table}. Generate Final SQL to use them.`,
        'success');
    },
  });
}

function syncSourceTextarea() {
  const el = document.getElementById('teSourceJson');
  if (!el) return;
  el.value = JSON.stringify(state.source, null, 2);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ── Confirmation gate for environment-specific tables ────── */

/** Which selected tables hold environment-specific values and still need
 *  sign-off. Returns [] when there is nothing to confirm. */
function pendingEnvTables() {
  return [...state.selected]
    .map(tableMeta)
    .filter(t => t && t.env && rowsFor(t.table).length && !state.confirmed.has(t.table));
}

function openEnvGate(onConfirmed) {
  const pending = pendingEnvTables();
  const modal = document.getElementById('tenantEnvModal');
  const body = document.getElementById('tenantEnvBody');
  if (!modal || !body) return onConfirmed();

  body.innerHTML = pending.map(renderEnvBlock).join('');
  envGate.onConfirmed = onConfirmed;
  envGate.tables = pending.map(t => t.table);
  modal.classList.remove('hidden');
  updateEnvGateState();
}

function renderEnvBlock(table) {
  const rows = rowsFor(table.table);
  const required = new Set(table.required);
  const cells = rows.map((row, index) => {
    const fields = table.fields.filter(f => required.has(f) || !isBlank(row[f]));
    const list = fields.map(f => `
      <div class="te-env-field${required.has(f) ? ' is-required' : ''}">
        <span class="te-env-field-name">${escapeHtml(f)}</span>
        <span class="te-env-field-value">${escapeHtml(displayValue(row[f]))}</span>
      </div>`).join('');
    return `<div class="te-env-row"><div class="te-env-row-head">Row ${index + 1}</div>${list}</div>`;
  }).join('');

  return `
    <section class="te-env-block">
      <header class="te-env-head">
        <code>${escapeHtml(table.table)}</code>
        <span class="te-env-label">${escapeHtml(table.label)}</span>
      </header>
      <div class="te-env-rows">${cells}</div>
      <label class="te-env-confirm">
        <input type="checkbox" data-env-table="${escapeHtml(table.table)}"
               onchange="tenantExportEnvChanged()">
        <span>These values are correct for the <strong>destination</strong> environment.</span>
      </label>
    </section>`;
}

const envGate = { onConfirmed: null, tables: [] };

function tenantExportEnvChanged() { updateEnvGateState(); }

function updateEnvGateState() {
  const boxes = [...document.querySelectorAll('#tenantEnvBody input[data-env-table]')];
  const allChecked = boxes.length > 0 && boxes.every(b => b.checked);
  const button = document.getElementById('tenantEnvConfirm');
  if (button) button.disabled = !allChecked;
}

function tenantExportEnvConfirm() {
  const boxes = [...document.querySelectorAll('#tenantEnvBody input[data-env-table]')];
  if (!boxes.every(b => b.checked)) return;
  boxes.forEach(b => state.confirmed.add(b.dataset.envTable));

  // Capture the continuation before closing — closeTenantEnvModal() clears it.
  const proceed = envGate.onConfirmed;
  closeTenantEnvModal();
  updateSummary();
  if (proceed) proceed();
}

function closeTenantEnvModal() {
  const modal = document.getElementById('tenantEnvModal');
  if (modal) modal.classList.add('hidden');
  envGate.onConfirmed = null;
}

/* ── Step 4: generate ─────────────────────────────────────── */

async function tenantExportFinal() {
  const tenant = document.getElementById('teTenant');
  normalizeInput(tenant);
  if (!validateFields([{ el: tenant, label: 'Tenant Organization Code' }])) return;

  if (!state.source) {
    return showToast('Analyse First',
      'Note: choose Analyse Pasted Data so the tables can be listed and selected.', 'warning');
  }
  if (!state.selected.size) {
    return showToast('No Tables Selected', 'Note: tick at least one table to generate.', 'warning');
  }

  // Workflow groups are remapped through the same prompt the Workflow Sync tab
  // uses, before anything is generated — group names are environment-specific
  // and carrying them across unchanged is the mistake that prompt prevents.
  if (!await promptWorkflowGroupRemap()) {
    return showToast('Cancelled', 'Note: Final SQL generation was cancelled.', 'info');
  }

  // Environment-specific tables cannot reach the generator unconfirmed.
  if (pendingEnvTables().length) {
    openEnvGate(() => postFinal(null));
    return;
  }
  postFinal(activeButton());
}

/* ── Workflow group remap ─────────────────────────────────────
 * Reuses components/group-remap.js — the same dialog, validation and
 * semantics as the Workflow Sync tab. Applied to the `transition` rows
 * (which hold from_group / to_groups) and to `workflow.workflow_name`,
 * whose legacy "FROM--TO" naming embeds the same group names.
 *
 * Returns false only when the user cancels. */
async function promptWorkflowGroupRemap() {
  const transitionsSelected = state.selected.has('transition');
  const workflowSelected = state.selected.has('workflow');
  if (!transitionsSelected && !workflowSelected) return true;

  const transitions = rowsFor('transition');
  const groups = collectGroupNames(transitions);
  if (!groups.length) return true;

  const remap = await openGroupRemapModal(groups);
  if (!remap) return false;

  if (transitionsSelected) {
    state.source.transition = applyGroupRemap(transitions, remap);
  }
  if (workflowSelected) {
    state.source.workflow = rowsFor('workflow').map(row => ({
      ...row,
      workflow_name: remapGroupsInText(row.workflow_name, remap),
    }));
  }

  const renamed = Object.keys(remap).filter(k => remap[k] !== k);
  syncSourceTextarea();
  renderPicker();
  showToast('Groups Remapped',
    renamed.length
      ? `Note: ${renamed.length} group${renamed.length === 1 ? '' : 's'} renamed across workflows and transitions.`
      : 'Note: all group names kept unchanged.',
    'success');
  return true;
}

function postFinal(btn) {
  setLoading(btn, true, 'building tenant migration sql');
  fetch('/tenant-export/final', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant:           document.getElementById('teTenant').value,
      source_json:      JSON.stringify(state.source),
      destination_json: JSON.stringify(state.destination || {}),
      tables:           [...state.selected],
      confirmed:        [...state.confirmed],
    }),
  })
  .then(r => r.json())
  .then(renderFinal)
  .catch(() => showToast('Server Error', 'Note: Failed to generate Final SQL. Check server logs.', 'error'))
  .finally(() => setLoading(btn, false));
}

function renderFinal(data) {
  const errorsEl = document.getElementById('teErrors');
  const statsEl = document.getElementById('teStats');
  const finalEl = document.getElementById('teFinal');

  if (data.error) {
    showToast('Unavailable', 'Note: ' + data.error, 'error');
    return;
  }

  if (data.errors && data.errors.length) {
    errorsEl.innerHTML =
      '<h4 class="te-errors-title">Blocked — nothing was generated</h4><ul>'
      + data.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')
      + '</ul>';
    errorsEl.classList.remove('hidden');
    statsEl.classList.add('hidden');
    finalEl.value = '';
    finalEl.dispatchEvent(new Event('input', { bubbles: true }));
    showToast('Validation Failed',
      `Note: ${data.errors.length} item${data.errors.length === 1 ? '' : 's'} must be resolved first.`, 'error');
    return;
  }

  errorsEl.classList.add('hidden');
  renderStats(statsEl, data.stats || {});

  finalEl.value = data.result || '';
  finalEl.dispatchEvent(new Event('input', { bubbles: true }));
  if (data.notes && data.notes.length) showNotesModal(data.notes);

  const hasSQL = data.result && data.result.trim();
  showToast(
    hasSQL ? 'Migration SQL Generated' : 'No Changes Detected',
    hasSQL ? 'Note: review every statement — DELETE appears only for workflow and transition.'
           : 'Note: the selected tables already match the destination.',
    hasSQL ? 'success' : 'info');
}

function renderStats(host, stats) {
  const rows = Object.entries(stats).filter(([, s]) =>
    s.insert || s.update || s.delete || s.reported);
  if (!rows.length) { host.classList.add('hidden'); return; }

  const total = key => rows.reduce((n, [, s]) => n + (s[key] || 0), 0);
  host.innerHTML = `
    <div class="te-stats-head">
      <span class="te-stat"><b>${total('insert')}</b> insert</span>
      <span class="te-stat"><b>${total('update')}</b> update</span>
      <span class="te-stat te-stat-del"><b>${total('delete')}</b> delete</span>
      <span class="te-stat te-stat-skip"><b>${total('unchanged')}</b> unchanged</span>
      ${total('reported') ? `<span class="te-stat te-stat-note"><b>${total('reported')}</b> reported</span>` : ''}
    </div>
    <table class="te-stats-table">
      <thead><tr><th>Table</th><th>Insert</th><th>Update</th><th>Delete</th><th>Unchanged</th></tr></thead>
      <tbody>${rows.map(([table, s]) => `
        <tr>
          <td><code>${escapeHtml(table)}</code></td>
          <td>${s.insert || 0}</td><td>${s.update || 0}</td>
          <td>${s.delete || 0}</td><td>${s.unchanged || 0}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  host.classList.remove('hidden');
}

/* ── Small helpers ────────────────────────────────────────── */

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function displayValue(value) {
  if (isBlank(value)) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

exposeGlobals({
  tenantExportPull,
  tenantExportAnalyse,
  tenantExportFinal,
  tenantExportPreview,
  tenantExportToggleTable,
  tenantExportToggleGroup,
  tenantExportSelectAll,
  tenantExportEnvChanged,
  tenantExportEnvConfirm,
  closeTenantEnvModal,
});
// Shared remap dialog handlers (idempotent — Workflow Sync wires these too).
exposeRemapGlobals();

export const tenantExportTab = {
  key: 'tenant',
  statusKey: 'TENANT_EXPORT',
  endpoints: { src: 'DB', dst: 'DB' },
  render,
  syncStepper({ setState }) {
    const pull = document.getElementById('tePullResult');
    const final = document.getElementById('teFinal');
    const hasPull = !!(pull && pull.children.length > 0);
    const hasParsed = !!state.source;
    const hasSelection = state.selected.size > 0;
    const hasFinal = !!(final && final.value && final.value.trim());
    setState('tenant', {
      configure: hasPull ? 'done' : 'active',
      emit:      hasPull ? 'done' : 'pending',
      run:       hasParsed ? 'done' : (hasPull ? 'active' : 'pending'),
      paste:     hasParsed ? 'done' : (hasPull ? 'active' : 'pending'),
      select:    hasFinal ? 'done' : (hasSelection ? 'active' : 'pending'),
      final:     hasFinal ? 'active' : 'pending',
    });
  },
};
