// ═══════════════════════════════════════════════════════════
// PATCH v59 — Sales Orders, Correction: Sell via POS (real accounting)
// ═══════════════════════════════════════════════════════════
// v58 was architecturally wrong, per direct user feedback: it shipped
// stock via a bare quantity decrement with NO journal entries at all —
// no revenue, no COGS, no AR/cash movement. That's not how this should
// work. The correct model, matching how the rest of this app already
// works: a Sales Order is a reservation/quote. Once the customer agrees,
// the cashier pulls the order up IN POS and completes it exactly like
// any other sale — completeSale() already does all the correct
// accounting (revenue, COGS, AR/cash, stock reduction) untouched. If the
// customer backs out, you just Cancel the order (already existed,
// unaffected) — no accounting ever happens. The existing Delivery Note
// toggle on POS (v52+) keeps working exactly as before on that sale,
// which is the "connection to delivery note" already in place.
//
// This patch:
//   1. Redirects the existing "🚚 Ship" button (from v58) to load the
//      order's outstanding items into the POS cart instead of doing a
//      bare stock decrement. Safe to redo — window.openShipFormV58 was
//      assigned via `window.openShipFormV58 = function(){...}`, never a
//      bare `function openShipFormV58(){}` declaration, so there's no
//      closure-local binding shadowing it anywhere; every caller
//      (including the button v58 already built) resolves the CURRENT
//      value of window.openShipFormV58 at click time, so redefining it
//      here is enough — no need to touch v58's DOM code at all.
//   2. Wraps completeSale() (loaded last, so this sits outermost) to,
//      AFTER the real sale successfully posts, mark the linked Sales
//      Order's lines as fulfilled by whatever was actually sold and
//      recompute its status — no manual stock touch here, completeSale
//      already did that correctly as part of the real sale.
//   3. Bypasses v57's reservation-capping wrap of posAddToCart when
//      loading FROM the order's own reservation — pushes cart items
//      directly. Reasoning: v57's cap checks availableQtyV57(), which
//      sums reservations across ALL open orders INCLUDING this one; if
//      we routed through posAddToCart the order's own reservation would
//      count against itself and could block adding items it already
//      legitimately committed. Verified this reasoning against v57's
//      source before writing this.
//   4. Adds a Reserved / Available column to the Products list so
//      reservations are actually visible somewhere outside the Sales
//      Order screens themselves (the other half of the user's feedback).
//
// IMPORTANT — if any REAL shipment was already completed through v58's
// old flow before this fix, that stock reduction has no matching journal
// entry and the books and Stock Valuation may now disagree with reality.
// This patch cannot safely guess and auto-correct that after the fact —
// check Stock Valuation and the Journal for the affected product/order
// and fix any discrepancy manually if that happened.
// ═══════════════════════════════════════════════════════════

(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function computeSOStatusV59(lines) {
    const totalOrdered = lines.reduce(function (s, l) { return s + (l.quantity_ordered || 0); }, 0);
    const totalShipped = lines.reduce(function (s, l) { return s + (l.quantity_shipped || 0); }, 0);
    if (totalShipped <= 0) return 'Confirmed';
    if (totalShipped >= totalOrdered) return 'Fulfilled';
    return 'Partially_Fulfilled';
  }

  // ── Load a Sales Order's outstanding, currently-reserved items into POS ──
  window.loadSalesOrderIntoPOSV59 = function (so) {
    if (!Array.isArray(window.POS_CART)) return;
    if (POS_CART.length && !window.confirm('This will clear the current cart and load ' + so.order_number + ' instead. Continue?')) return;
    POS_CART.length = 0; // clear in place — POS_CART is declared with `let` elsewhere, so reassigning the bare identifier isn't reliably visible everywhere, but mutating the existing array in place always is

    let addedCount = 0, skippedUnmatched = 0, skippedBackordered = 0;
    (so.lines || []).forEach(function (line) {
      const remaining = (line.quantity_ordered || 0) - (line.quantity_shipped || 0);
      if (remaining <= 0) return;
      if (!line.item_id) { skippedUnmatched++; return; }
      const readyNow = Math.max(0, (line.quantity_reserved || 0) - (line.quantity_shipped || 0));
      const qtyToLoad = Math.min(remaining, readyNow);
      if (qtyToLoad <= 0) { skippedBackordered++; return; }
      const product = (RETAIL_PRODUCTS || []).find(function (p) { return p.id === line.item_id; });
      if (!product) { skippedUnmatched++; return; }
      const existing = POS_CART.find(function (i) { return i.id === product.id; });
      if (existing) { existing.qty += qtyToLoad; }
      else {
        // Price comes from the Sales Order's own quoted unit_price — the
        // price the customer actually agreed to — not today's master
        // rate, which may have moved since the quote was made.
        POS_CART.push({
          id: product.id, name: product.name, sku: product.sku || '',
          sale_price: parseFloat(line.unit_price) || parseFloat(product.sale_price) || 0,
          cost_price: parseFloat(product.cost_price) || 0, qty: qtyToLoad,
          unit: line.unit || product.unit || 'unit', tax_tier_id: product.tax_tier_id || null,
          price_inclusive: !!product.price_inclusive
        });
      }
      addedCount++;
    });

    window._posLinkedSalesOrderIdV59 = so.id;
    if (typeof renderPOSCart === 'function') renderPOSCart();
    nav('pos');

    let msg = '🛒 Loaded ' + addedCount + ' item(s) from ' + so.order_number + '.';
    if (skippedBackordered > 0) msg += ' ' + skippedBackordered + ' line(s) still backordered — not added.';
    if (skippedUnmatched > 0) msg += ' ' + skippedUnmatched + ' line(s) have no matching product — add those separately.';
    msg += ' Complete the sale as normal.';
    if (typeof showToast === 'function') showToast(msg, 6000);
  };

  // ── Redirect v58's existing "Ship" button to this instead ────────────
  window.openShipFormV58 = function (orderId) {
    const so = (DB.salesOrders || []).find(function (o) { return o.id === orderId; });
    if (!so) return;
    if (so.status === 'Cancelled' || so.status === 'Fulfilled') { if (typeof showToast === 'function') showToast('⚠️ Nothing left to sell on this order'); return; }
    loadSalesOrderIntoPOSV59(so);
  };
  // Relabel the already-rendered button from a prior "🚚 Ship" to reflect
  // what it actually does now (cosmetic only — the onclick already
  // resolves openShipFormV58 fresh at click time, so this isn't required
  // for correctness, only clarity).
  function relabelShipButtonsV59() {
    document.querySelectorAll('#so-list-v57 button').forEach(function (btn) {
      if (btn.textContent.indexOf('Ship') !== -1 && btn.textContent.indexOf('🛒') === -1) btn.textContent = '🛒 Sell via POS';
    });
  }
  function observeSOListRelabelV59() {
    const el = document.getElementById('so-list-v57'); if (!el || el._soRelabelObservedV59) return;
    el._soRelabelObservedV59 = true;
    new MutationObserver(relabelShipButtonsV59).observe(el, { childList: true, subtree: true });
    relabelShipButtonsV59();
  }

  // ── Reconcile the linked Sales Order after a real POS sale completes ──
  const _origCompleteSaleV59 = window.completeSale;
  if (typeof _origCompleteSaleV59 === 'function') {
    window.completeSale = async function () {
      const linkedSOId = window._posLinkedSalesOrderIdV59;
      const cartSnapshotForRecon = linkedSOId ? (POS_CART || []).map(function (i) { return { id: i.id, qty: i.qty }; }) : null;
      const beforeLen = (DB && DB.entries) ? DB.entries.length : 0;
      const result = await _origCompleteSaleV59.apply(this, arguments);
      const afterLen = (DB && DB.entries) ? DB.entries.length : 0;
      if (linkedSOId && afterLen > beforeLen && cartSnapshotForRecon) {
        const so = (DB.salesOrders || []).find(function (o) { return o.id === linkedSOId; });
        if (so) {
          cartSnapshotForRecon.forEach(function (item) {
            const line = (so.lines || []).find(function (l) { return l.item_id === item.id && (l.quantity_shipped || 0) < l.quantity_ordered; });
            if (!line) return;
            const applied = Math.min(item.qty, line.quantity_ordered - (line.quantity_shipped || 0));
            line.quantity_shipped = (line.quantity_shipped || 0) + applied;
          });
          so.status = computeSOStatusV59(so.lines);
          if (typeof saveData === 'function') saveData();
          if (typeof showToast === 'function') showToast('✅ ' + so.order_number + ' updated — now ' + so.status.replace(/_/g, ' '));
        }
      }
      window._posLinkedSalesOrderIdV59 = null;
      return result;
    };
  }

  // ── Products list: show what's actually available, not just raw stock ──
  const _origRenderProductsPageV59 = window.renderProductsPage;
  if (typeof _origRenderProductsPageV59 === 'function') {
    window.renderProductsPage = function () {
      const result = _origRenderProductsPageV59.apply(this, arguments);
      const el = document.getElementById('retailProductList'); if (!el) return result;
      const table = el.querySelector('table'); if (!table) return result;
      const headRow = table.querySelector('thead tr');
      if (headRow && !headRow.dataset.v59Augmented) {
        headRow.dataset.v59Augmented = '1';
        const th = document.createElement('th'); th.textContent = 'Reserved / Available'; headRow.insertBefore(th, headRow.lastElementChild);
      }
      const q = (document.getElementById('productSearch') || {}).value || '';
      const items = (RETAIL_PRODUCTS || []).filter(function (p) { return !q || p.name.toLowerCase().indexOf(q.toLowerCase()) !== -1 || (p.sku || '').indexOf(q) !== -1 || (p.barcode || '').indexOf(q) !== -1; });
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(function (row, i) {
        if (row.dataset.v59Augmented) return;
        const product = items[i]; if (!product) return;
        row.dataset.v59Augmented = '1';
        const reserved = (typeof reservedQtyForProductV57 === 'function') ? reservedQtyForProductV57(product.id, null) : 0;
        const avail = (typeof availableQtyV57 === 'function') ? availableQtyV57(product.id, null) : (parseFloat(product.qty) || 0);
        const td = document.createElement('td');
        td.style.fontSize = '10px';
        td.innerHTML = reserved > 0 ? `<span style="color:var(--gold2)">${reserved} reserved</span><br/><span style="color:var(--green3)">${avail} available</span>` : `<span style="color:var(--text3)">${avail} available</span>`;
        const lastCell = row.lastElementChild;
        row.insertBefore(td, lastCell);
      });
      return result;
    };
  }

  // ── Hook into nav to keep the button relabelled as the list re-renders ──
  const _origNavV59 = window.nav;
  if (typeof _origNavV59 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV59(page, el);
      if (page === 'salesorders') observeSOListRelabelV59();
      return result;
    };
  }

  console.log('✅ patch-v59.js loaded — Sales Orders now sell through POS with real accounting (supersedes v58\'s ship-without-journal flow)');
})();
