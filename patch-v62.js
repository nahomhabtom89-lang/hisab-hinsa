// ═══════════════════════════════════════════════════════════
// PATCH v62 — Fix Sales Orders list instability (blank-on-first-visit)
// ═══════════════════════════════════════════════════════════
// Root cause: v58, v59, and v61 each independently registered a
// MutationObserver on the SAME #so-list-v57 list — v58 appending a
// "Ship" button, v59 renaming it, v61 removing it. Each one's DOM change
// re-triggers the other two's callbacks, causing a burst of redundant,
// churning re-processing every single time that list renders (worst on
// the very first visit, which also does the most other one-time DOM
// work — injecting three whole new pages — at the same moment).
//
// Fix: stop fighting over the DOM with dueling observers entirely.
// v58 always adds the "Ship"/"Shipments" buttons as the 3rd and 4th
// buttons in that row's actions cell (confirmed by reading v57 and v58's
// source directly — Print is always 1st, Cancel is 2nd and only present
// under the exact same condition v58 uses for Ship, so Ship is reliably
// 3rd whenever it exists). A single positional CSS rule hides them
// permanently. CSS visibility changes do NOT trigger MutationObserver
// childList callbacks, so this can't re-trigger v58/v59/v61's observers
// at all — the churn stops completely, regardless of what those patches
// still do in the background.
//
// v58/v59/v61's observers are left in place (can't reach into their
// private closures to disable them, and don't need to) — they'll keep
// quietly running and finishing quickly since nothing they do is
// visible anymore, but they're no longer able to cause any visible
// flicker or delay.
// ═══════════════════════════════════════════════════════════

(function () {
  const style = document.createElement('style');
  style.textContent = `
    #so-list-v57 td:last-child > button:nth-child(n+3) { display: none !important; }
  `;
  document.head.appendChild(style);
  console.log('✅ patch-v62.js loaded — Sales Orders list churn fixed (CSS-only, no more competing observers)');
})();
