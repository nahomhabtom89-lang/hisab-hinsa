// ═══════════════════════════════════════════════════════════
// PATCH v60 — Reserved/Available visibility directly in POS
// ═══════════════════════════════════════════════════════════
// v59 added a Reserved/Available column on the Products page, but per
// the user's feedback: cashiers sell from the POS Register screen, not
// the Products page — they shouldn't have to go check a separate page to
// know an item is already committed to a Sales Order. This adds the
// same information directly onto each POS product tile.
//
// Same safe pattern already confirmed working for the Products page fix:
// renderPOSProductGrid() is a plain top-level function declaration in
// index.html's own (non-IIFE) main script, called elsewhere via bare
// identifier from that same script — reassigning window.renderPOSProductGrid
// is genuinely picked up by those call sites, unlike the earlier
// RETAIL_NAV/renderSalesOrdersListV57 cases where a PATCH's own IIFE
// created a shadowing local binding. Confirmed no other patch touches
// this function before writing this one.
// ═══════════════════════════════════════════════════════════

(function () {
  const _origRenderPOSProductGridV60 = window.renderPOSProductGrid;
  if (typeof _origRenderPOSProductGridV60 === 'function') {
    window.renderPOSProductGrid = function () {
      const result = _origRenderPOSProductGridV60.apply(this, arguments);
      const el = document.getElementById('pos-product-grid'); if (!el) return result;
      const tiles = el.querySelectorAll('.pos-product-btn');
      tiles.forEach(function (tile, i) {
        const product = (RETAIL_PRODUCTS || [])[i]; if (!product) return;
        const reserved = (typeof reservedQtyForProductV57 === 'function') ? reservedQtyForProductV57(product.id, null) : 0;
        if (reserved <= 0) return; // nothing reserved — tile already shows plain stock, no change needed
        const avail = (typeof availableQtyV57 === 'function') ? availableQtyV57(product.id, null) : (parseFloat(product.qty) || 0);
        const badge = document.createElement('div');
        badge.style.cssText = "font-size:8px;font-family:'JetBrains Mono',monospace;color:var(--gold2);margin-top:1px";
        badge.textContent = '🔒 ' + reserved + ' reserved · ' + avail + ' avail';
        tile.appendChild(badge);
      });
      return result;
    };
  }

  console.log('✅ patch-v60.js loaded — Reserved/Available shown directly on POS product tiles');
})();
