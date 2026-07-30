/* ============================================================
 *  main.js — Entry point.
 *
 *  Architecture
 *  ────────────
 *  · /lib        Generic, framework-free primitives. Never imports
 *                from /components, /tabs or /state.
 *  · /components Reusable UI building blocks (templates + decorator).
 *                Imports /lib only.
 *  · /state      Cross-cutting machinery (tab registry, status bar,
 *                flow observer). Imports /lib + /components.
 *  · /tabs       One module per sync domain. Implements the Tab
 *                contract (see state/registry.js). Imports anything.
 *
 *  Adding a new tab
 *  ────────────────
 *  1. Create static/js/tabs/<name>.js exporting a Tab object.
 *  2. Import the tab here and call TabRegistry.register(it).
 *  3. Add a <button data-key="..." onclick="switchTab('<key>')">
 *     to the .tabs nav inside templates/index.html.
 *  4. (Optional) register input ids for normalization, register
 *     a json-group action button for a custom view (e.g. table).
 *
 *  Inline onclick handlers (e.g. onclick="branchPull()") still work
 *  because each tab calls exposeGlobals(…) at module top-level.
 * ============================================================ */

import { openSqlPreview, closeSqlPreview, copySqlPreviewAll, downloadSqlPreviewAll } from './components/sql-preview.js';
import { TabRegistry, switchTab, goToTab } from './state/registry.js';
import { startStatusBar }                  from './state/status-bar.js';
import { startFlowObserver }               from './state/flow-state.js';
import { startSchemaVersion }              from './state/schema-version.js';
import { bindModalEscape, closeModalById, closeNotesModal } from './lib/modal.js';
import {
  closeTableModal,
  requestCloseTableModal,
  resetTableModalFilters,
  downloadTableModalCSV,
  toggleTableEditMode,
  applyTableChanges,
  discardTableChanges,
  applyColumnMultiFilter,
  cancelColumnMultiFilter,
  clearColumnMultiFilter,
  saveTableJsonEditor,
  cancelTableJsonEditor,
  formatTableJsonEditor,
  addTableRow,
  duplicateTableRow,
  clearTableSort,
  revertTableDiff,
  backToTableEdit,
} from './components/table-modal.js';
import { copyText, downloadSqlFromTextarea } from './lib/data.js';
import { exposeGlobals }                   from './lib/dom.js';

import { branchTab }      from './tabs/branch.js';
import { workflowTab }    from './tabs/workflow.js';
import { featureFlagTab } from './tabs/feature-flag.js';
import { mqTab }          from './tabs/mq.js';
import { tenantExportTab } from './tabs/tenant-export.js';

/* Full Tenant Export is built entirely from the v2 registry, so it is only
 * registered on v2. index.html renders its nav button under the same
 * condition — both read the server-rendered schema version. */
const TABS = [branchTab, workflowTab, featureFlagTab, mqTab];
if (document.body.dataset.schemaVersion === 'v2') TABS.push(tenantExportTab);
TABS.forEach(t => TabRegistry.register(t));

/* Inline-onclick globals used from index.html templates */
exposeGlobals({
  switchTab,
  goToTab,
  copyText,
  downloadSqlFromTextarea,
  closeModal:           () => closeModalById('noteModal'),
  closeNotesModal,
  closeTableModal,
  requestCloseTableModal,
  resetTableModalFilters,
  downloadTableModalCSV,
  toggleTableEditMode,
  applyTableChanges,
  discardTableChanges,
  applyColumnMultiFilter,
  cancelColumnMultiFilter,
  clearColumnMultiFilter,
  saveTableJsonEditor,
  cancelTableJsonEditor,
  formatTableJsonEditor,
  addTableRow,
  duplicateTableRow,
  clearTableSort,
  revertTableDiff,
  backToTableEdit,
  openSqlPreview,
  closeSqlPreview,
  copySqlPreviewAll,
  downloadSqlPreviewAll,
});

/* ── Synchronized cursor blink ──────────────────────────────
 * The title cursor and the active-tab cursor both read --cursor-on
 * from :root. A single timer flips that variable so the two indicators
 * always blink in lockstep, even after the user switches tabs (which
 * remounts the tab pseudo-element and would otherwise restart its
 * animation out of phase with the title).
 *
 * Respects prefers-reduced-motion: stays solid on.
 */
(function startCursorTick() {
  const root = document.documentElement;
  root.style.setProperty('--cursor-on', '1');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;   // leave solid on
  let on = true;
  setInterval(() => {
    on = !on;
    root.style.setProperty('--cursor-on', on ? '1' : '0');
  }, 525);   // matches the old 1.05s / steps(2) cadence
})();

/* Bootstrap — runs once on first script execution */
bindModalEscape();
startStatusBar();
startFlowObserver();
startSchemaVersion();

// Initial paint: activate the first registered tab.
TabRegistry.setActive(branchTab.key);
