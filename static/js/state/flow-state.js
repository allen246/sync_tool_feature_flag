/* ============================================================
 *  flow-state.js — Passive observer that keeps the flow ribbon
 *  state and JSON-group lock state in sync with the rendered DOM.
 *
 *  Why an observer (not direct calls from handlers)?
 *  ─────────────────────────────────────────────────
 *  Tab handlers stay free of presentational concerns. They just
 *  render results to the DOM; this module observes those renders
 *  and updates UI accordingly. Means a new tab's flow ribbon
 *  "just works" if it follows the same DOM contract.
 *
 *  Contract a tab must follow for auto-stepper:
 *    · #content contains a .flow-ribbon[data-flow=<key>]
 *    · pull queries are rendered into #<key>PullResult
 *    · final SQL is in a textarea #<key>Final
 *  See tabs/registry for endpoint customization.
 * ============================================================ */

import { TabRegistry } from './registry.js';
import { decorateJsonGroups } from '../components/json-group.js';
import { wireInputNormalization } from '../lib/data.js';

/** A tab may set its own custom syncer. Default below covers the
 *  three "pull → paste → final" tabs and MQ-style "paste-only". */
export function startFlowObserver() {
  const content = document.getElementById('content');
  if (!content) return;

  const obs = new MutationObserver(() => refresh());
  obs.observe(content, { childList: true, subtree: true, characterData: true,
                         attributes: true, attributeFilter: ['class', 'value'] });
  document.addEventListener('input', e => {
    if (e.target && e.target.closest && e.target.closest('#content')) refresh();
  }, true);

  // Re-derive state after each tab switch (a small delay covers the
  // synchronous innerHTML repaint inside switchTab).
  document.querySelectorAll('.tabs button').forEach(b => {
    b.addEventListener('click', () => setTimeout(refresh, 30));
  });
  setTimeout(refresh, 50);

  function refresh() {
    const tab = TabRegistry.activeTab();
    if (tab && typeof tab.syncStepper === 'function') {
      tab.syncStepper({ setState, gateFields: defaultGateFields });
    }
    // Decoration + input wiring are always idempotent and cheap.
    decorateJsonGroups();
    wireInputNormalization();
  }
}

/** Set data-state on flow ribbon steps. */
function setState(flowKey, stateMap) {
  const ribbon = document.querySelector(`.flow-ribbon[data-flow="${flowKey}"]`);
  if (!ribbon) return;
  Object.keys(stateMap).forEach(stepKey => {
    const el = ribbon.querySelector(`.flow-step[data-step="${stepKey}"]`);
    if (el) el.dataset.state = stateMap[stepKey];
  });
}

/** Standard gating: paste textareas + final button locked until
 *  pull-result is populated. MQ-style tabs implement their own. */
export function defaultGateFields({ pullId, jsonIds, submitFn, hasPull }) {
  jsonIds.forEach(id => {
    const t = document.getElementById(id);
    if (!t) return;
    t.disabled = !hasPull;
    const jg = t.closest('.json-group');
    if (jg) jg.classList.toggle('is-locked', !hasPull);
    ['.json-upload-btn', '.json-table-btn'].forEach(sel => {
      const b = jg && jg.querySelector(sel);
      if (b) b.disabled = !hasPull;
    });
  });
  const btn = document.querySelector(`button.primary[onclick="${submitFn}()"]`);
  if (btn) btn.disabled = !hasPull;
}
