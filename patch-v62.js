// ═══════════════════════════════════════════════════════════
// PATCH v61 — Move "Load Sales Order" into POS itself + fix a real bug
// ═══════════════════════════════════════════════════════════
// Two things:
//
// 1. BUG FIX: v59's loadSalesOrderIntoPOSV59() opened with
//    `if (!Array.isArray(window.POS_CART)) return;` — POS_CART is
//    declared with `let` in index.html, so window.POS_CART is ALWAYS
//    undefined regardless of the real cart, exactly the same mistake
//    already documented and fixed in patch-v52 (and referenced in v59's
//    own file header!) — just reintroduced here in a fresh spot. That
//    guard silently killed the whole function on every single click,
//    which is why "Sell via POS" appeared to do nothing. Fixed by
//    checking the bare identifier instead.
//
// 2. UX CHANGE (per direct request): the cashier works in POS, not on
//    the Sales Orders page, so the trigger belongs in POS. This patch:
//      - Adds a "📋 Load Sales Order into Cart" dropdown right at the
//        top of the POS cart panel, listing open (Confirmed /
//        Partially_Fulfilled) orders. Picking one loads its available
//        items into the cart (same loadSalesOrderIntoPOSV59 as before,
//        now fixed) — the cashier then completes the sale normally,
//        Delivery Note toggle and all, exactly as already described.
//      - Removes the "Sell via POS" button v58/v59 added to the Sales
//        Orders list (Print and Cancel stay — only the sell trigger
//        moves). Same MutationObserver technique already proven
//        reliable for this list in v58/v59, since editing v58's own
//        button-building code directly isn't possible from here without
//        reaching into its private closure.
// ═══════════════════════════════════════════════════════════

(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function fmtMoney(n) { return (typeof fc === 'function') ? fc(n) : '$' + (parseFloat(n) || 0).toFixed(2); }

  // ── Fixed redefinition (see file header) ─────────────────────────────
  window.loadSalesOrderIntoPOSV59 = function (so) {
    if (typeof POS_CART === 'undefined' || !Array.isArray(POS_CART)) return;
    if (POS_CART.length && !window.confirm('This will clear the current cart and load ' + so.order_number + ' instead. Continue?')) return;
    POS_CART.length = 0;

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

    let msg = '🛒 Loaded ' + addedCount + ' item(s) from ' + so.order_number + '.';
    if (skippedBackordered > 0) msg += ' ' + skippedBackordered + ' line(s) still backordered — not added.';
    if (skippedUnmatched > 0) msg += ' ' + skippedUnmatched + ' line(s) have no matching product — add those separately.';
    msg += ' Complete the sale as normal.';
    if (typeof showToast === 'function') showToast(msg, 6000);
  };

  // ── "Load Sales Order" picker, inside POS itself ─────────────────────
  function eligibleOpenOrdersV61() {
    return (DB.salesOrders || []).filter(function (so) {
      return so.status === 'Confirmed' || so.status === 'Partially_Fulfilled';
    }).sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
  }

  window.onPOSLoadSalesOrderV61 = function (orderIdStr) {
    if (!orderIdStr) return;
    const so = (DB.salesOrders || []).find(function (o) { return String(o.id) === String(orderIdStr); });
    const sel = document.getElementById('pos-so-select-v61'); if (sel) sel.value = '';
    if (!so) return;
    loadSalesOrderIntoPOSV59(so);
  };

  function refreshPOSSOPickerV61() {
    const sel = document.getElementById('pos-so-select-v61'); if (!sel) return;
    const orders = eligibleOpenOrdersV61();
    sel.innerHTML = '<option value="">📋 Load a Sales Order into cart...</option>' + orders.map(function (so) {
      return `<option value="${so.id}">${esc(so.order_number)} — ${esc(so.customerName)} (${fmtMoney(so.total_amount)})</option>`;
    }).join('');
  }

  function injectPOSSOPickerV61() {
    if (document.getElementById('pos-so-select-v61')) { refreshPOSSOPickerV61(); return; }
    const cartEl = document.getElementById('pos-cart-items'); if (!cartEl) return;
    const html = `<select id="pos-so-select-v61" onchange="onPOSLoadSalesOrderV61(this.value)" style="width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text);outline:none;margin-bottom:8px">
      <option value="">📋 Load a Sales Order into cart...</option>
    </select>`;
    cartEl.insertAdjacentHTML('beforebegin', html);
    refreshPOSSOPickerV61();
  }

  const _origInjectRetailPagesV61 = window.injectRetailPages;
  if (typeof _origInjectRetailPagesV61 === 'function') {
    window.injectRetailPages = function () {
      const result = _origInjectRetailPagesV61.apply(this, arguments);
      injectPOSSOPickerV61();
      return result;
    };
  }

  const _origNavV61 = window.nav;
  if (typeof _origNavV61 === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV61(page, el);
      if (page === 'pos') injectPOSSOPickerV61();
      return result;
    };
  }

  // ── Remove the sell/ship button from the Sales Orders list ──────────
  function removeSOSellButtonV61() {
    document.querySelectorAll('#so-list-v57 button').forEach(function (btn) {
      const t = btn.textContent || '';
      if (t.indexOf('Ship') !== -1 || t.indexOf('Sell via POS') !== -1) btn.remove();
    });
  }
  function observeSOListRemovalV61() {
    const el = document.getElementById('so-list-v57'); if (!el || el._soRemoveObservedV61) return;
    el._soRemoveObservedV61 = true;
    new MutationObserver(removeSOSellButtonV61).observe(el, { childList: true, subtree: true });
    removeSOSellButtonV61();
  }
  const _origNavV61c = window.nav;
  if (typeof _origNavV61c === 'function') {
    window.nav = async function (page, el) {
      const result = await _origNavV61c(page, el);
      if (page === 'salesorders') observeSOListRemovalV61();
      return result;
    };
  }

  console.log('✅ patch-v61.js loaded — Sales Order picker moved into POS, sell-button removed from Sales Orders list, POS_CART bug fixed');
})();
