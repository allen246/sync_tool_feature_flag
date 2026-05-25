/* ============================================================
 *  registry.js — The Tab extension point.
 *
 *  To add a new sync domain:
 *  ─────────────────────────
 *  1. Create static/js/tabs/<your-tab>.js exporting a Tab object.
 *  2. Import it in main.js and call TabRegistry.register(tab).
 *  3. Add a <button data-key="..." onclick="switchTab('...')"> to
 *     the .tabs nav in index.html (or templates that render tabs).
 *
 *  Tab contract
 *  ────────────
 *  {
 *    key:        'branch',                        // unique
 *    statusKey:  'BRANCH',                        // shown in status bar
 *    endpoints:  { src: 'DB', dst: 'DB' },        // null on either side hides that pill
 *    render(host):     void,                      // host = #content element
 *    syncStepper(ribbon, helpers): void,          // called after each DOM change
 *  }
 *
 *  syncStepper helpers:
 *    helpers.setState(map)  — assigns data-state on .flow-step elements
 *    helpers.gateFields()   — locks paste fields until pull-result populated
 *                             (most tabs delegate to the default impl)
 * ============================================================ */

const tabs = new Map();
let activeKey = null;

export const TabRegistry = {
  register(tab) {
    if (!tab || !tab.key) throw new Error('Tab must have a .key');
    tabs.set(tab.key, tab);
  },
  get(key)    { return tabs.get(key); },
  all()       { return Array.from(tabs.values()); },
  activeKey() { return activeKey; },
  activeTab() { return activeKey ? tabs.get(activeKey) : null; },
  setActive(key) {
    activeKey = key;
    const tab = tabs.get(key);
    if (tab && typeof tab.render === 'function') {
      const host = document.getElementById('content');
      if (host) tab.render(host);
    }
  },
};

/** switchTab is invoked from inline onclick on tab buttons. It also
 *  drives the visual active state via the same DOM the original
 *  implementation relied on. */
export function switchTab(key) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  if (typeof event !== 'undefined' && event && event.target) {
    event.target.classList.add('active');
  } else {
    const btn = document.querySelector(`.tabs button[data-key="${tabs.get(key)?.statusKey || ''}"]`);
    if (btn) btn.classList.add('active');
  }
  TabRegistry.setActive(key);
}

/** Helper for header coverage panel or any other "jump to tab" UI. */
export function goToTab(idx) {
  const btn = document.querySelectorAll('.tabs button')[idx];
  if (btn) btn.click();
  const tabsEl = document.querySelector('.tabs');
  if (tabsEl && tabsEl.scrollIntoView) tabsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
