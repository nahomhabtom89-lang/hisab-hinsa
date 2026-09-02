// ── PATCH v32: Per-product inventory accounting fixes ──────────────────
//
// Fixes three related bugs, all stemming from the same root cause: stock
// PURCHASES post to per-product accounts like "Inventory (Widget A)"
// (via buildIntakeJournalEntry), but stock DECREASES (POS sales, and the
// "opening stock" entry when a product is first created) were posting to
// a single generic "Inventory (Stock)" bucket instead. That bucket only
// ever gets credited, never debited, so it drifts to an ever-larger
// negative number while the real per-product balances (built by
// purchases) never get reduced.
//
// 1) completeSale() — safe-wraps it. The original VAT/COGS/inventory
//    logic runs 100% untouched (same pattern as v24/v31: never redefine
//    completeSale itself). After it returns, we find the COGS entry it
//    just pushed and rewrite its single lump credit line into one credit
//    line per product actually sold, using the same "Inventory (Name)"
//    naming buildIntakeJournalEntry already uses. Any sub-cent rounding
//    remainder is swept into "Inventory (Stock)" so the entry always
//    still balances exactly (verified in simulation, see below).
//
// 2) saveProduct() — safe-wraps it the same way for the "opening stock"
//    entry, so a brand-new product with a starting quantity debits
//    "Inventory (ProductName)" like every other stock movement, instead
//    of the generic bucket.
//
// 3) renderHomeKpis() — this one is a plain function, so per the
//    established pattern it's fully redefined as a superset: identical
//    UI/output to before, except the "Inventory" KPI is now the SUM of
//    every account starting with "Inventory (" instead of reading only
//    "Inventory (Stock)". A new global helper getInventoryTotal(b) is
//    exposed for reuse.
//
// Verified with a Node.js simulation before shipping (per project
// convention): confirmed the COGS split always balances (debits==credits
// within a cent), handles duplicate product names in one cart and
// zero-cost items correctly, and confirmed the dashboard sum correctly
// reflects purchases minus sales at the per-product level.
//
// NOTE: this does not yet cover two lower-stakes spots that read the old
// "Inventory (Stock)" key directly — the Month-End checklist's "Inventory
// balance positive" check, and the AI Advisor's dashboard context string.
// Left alone in this patch to keep scope tight to the three reported
// bugs; flag if you'd like those covered too.

(function () {
  // Shared helper: total inventory value across every per-product
  // (and any leftover generic) inventory account.
  window.getInventoryTotal = function (b) {
    let total = 0;
    Object.keys(b).forEach(function (k) {
      if (k.indexOf('Inventory (') === 0) total += b[k].net;
    });
    return total;
  };

  // ── 1) POS sale COGS → per-product inventory credit ──────────────────
  const _origCompleteSaleV32 = window.completeSale;
  window.completeSale = async function () {
    // Snapshot the cart BEFORE the original clears it at the end.
    const cartSnapshot = POS_CART.map(function (item) {
      return {
        name: item.name,
        cost_price: parseFloat(item.cost_price) || 0,
        qty: parseFloat(item.qty) || 0
      };
    });
    const beforeLen = DB.entries.length;

    await _origCompleteSaleV32.apply(this, arguments);

    // Find the COGS entry the original just pushed and re-target its
    // credit line(s) at the specific products sold.
    let fixed = false;
    for (let i = beforeLen; i < DB.entries.length; i++) {
      const e = DB.entries[i];
      if (e.type === 'COGS' && e.credits && e.credits.length === 1 &&
          e.credits[0].acct === 'Inventory (Stock)') {
        const origAmt = e.credits[0].amt;
        const lines = [];
        cartSnapshot.forEach(function (item) {
          const amt = Math.round(item.cost_price * item.qty * 100) / 100;
          if (amt > 0.001) {
            const acct = `Inventory (${item.name})`;
            const existing = lines.find(function (l) { return l.acct === acct; });
            if (existing) existing.amt = Math.round((existing.amt + amt) * 100) / 100;
            else lines.push({ acct: acct, amt: amt, atype: 'asset' });
          }
        });
        const linesSum = lines.reduce(function (s, l) { return s + l.amt; }, 0);
        const diff = Math.round((origAmt - linesSum) * 100) / 100;
        if (Math.abs(diff) > 0.005) {
          lines.push({ acct: 'Inventory (Stock)', amt: diff, atype: 'asset' });
        }
        if (lines.length) {
          e.credits = lines;
          fixed = true;
        }
        break;
      }
    }

    if (fixed) {
      // The original completeSale() already called saveData() once with
      // the un-fixed entry — persist the corrected version now.
      await saveData();
      renderAll();
    }
  };

  // ── 2) Opening-stock entry → per-product inventory debit ─────────────
  const _origSaveProductV32 = window.saveProduct;
  window.saveProduct = async function () {
    const nameEl = document.getElementById('prd-name');
    const productName = nameEl ? nameEl.value.trim() : '';
    const beforeLen = DB.entries.length;

    await _origSaveProductV32.apply(this, arguments);

    let fixed = false;
    for (let i = beforeLen; i < DB.entries.length; i++) {
      const e = DB.entries[i];
      if (e.type === 'Stock Receipt' && e.desc === `Opening stock: ${productName}` &&
          e.debits && e.debits.length === 1 && e.debits[0].acct === 'Inventory (Stock)') {
        e.debits[0].acct = `Inventory (${productName})`;
        fixed = true;
        break;
      }
    }

    if (fixed) {
      await saveData();
      renderAll();
    }
  };

  // ── 3) Dashboard Inventory KPI → sum all per-product accounts ────────
  window.renderHomeKpis = function () {
    const b = getBal(ACTIVE_PROJECT || undefined), rev = sumByType(b, 'revenue'),
      exp = sumByType(b, 'expense'), net = rev - exp, cash = b['Cash'] ? b['Cash'].net : 0;
    const el = document.getElementById('homeKpis'); if (!el) return;
    if (APP_MODE === 'retail') {
      const inv = getInventoryTotal(b), ap = b['Accounts Payable'] ? b['Accounts Payable'].net : 0,
        cogs = b['Cost of Goods Sold'] ? b['Cost of Goods Sold'].net : 0, gp = rev - cogs;
      const low = RETAIL_PRODUCTS.filter(function (p) { return parseFloat(p.qty) <= parseFloat(p.min_qty) && parseFloat(p.min_qty) > 0; }).length;
      el.innerHTML = `<div class="kpi"><div class="kpi-lbl">Sales</div><div class="kpi-val pos">${fc(rev)}</div></div><div class="kpi"><div class="kpi-lbl">COGS</div><div class="kpi-val neg">${fc(cogs)}</div></div><div class="kpi"><div class="kpi-lbl">Gross Profit</div><div class="kpi-val ${gp >= 0 ? 'pos' : 'neg'}">${fc(gp)}</div></div><div class="kpi"><div class="kpi-lbl">Cash</div><div class="kpi-val ${cash >= 0 ? '' : 'neg'}">${fc(cash)}</div></div><div class="kpi"><div class="kpi-lbl">Inventory</div><div class="kpi-val warn">${fc(inv)}</div></div><div class="kpi"><div class="kpi-lbl">Payables</div><div class="kpi-val neg">${fc(ap)}</div></div>${low ? `<div class="kpi" style="border-color:rgba(224,128,32,.4)"><div class="kpi-lbl" style="color:var(--orange3)">Low Stock</div><div class="kpi-val warn">${low}</div></div>` : ''}`;
    } else {
      const ar = b['Accounts Receivable'] ? b['Accounts Receivable'].net : 0,
        ret = b['Retention Receivable'] ? b['Retention Receivable'].net : 0,
        wip = b['Work in Progress'] ? b['Work in Progress'].net : 0;
      el.innerHTML = `${ACTIVE_PROJECT ? `<div style="grid-column:1/-1;font-size:10px;color:var(--gold3)">📍 "${ACTIVE_PROJECT}" only</div>` : ''}<div class="kpi"><div class="kpi-lbl">Revenue</div><div class="kpi-val pos">${fc(rev)}</div></div><div class="kpi"><div class="kpi-lbl">Expenses</div><div class="kpi-val neg">${fc(exp)}</div></div><div class="kpi"><div class="kpi-lbl">Net Profit</div><div class="kpi-val ${net >= 0 ? 'pos' : 'neg'}">${fc(net)}</div></div><div class="kpi"><div class="kpi-lbl">Cash</div><div class="kpi-val ${cash >= 0 ? '' : 'neg'}">${fc(cash)}</div></div><div class="kpi"><div class="kpi-lbl">AR</div><div class="kpi-val warn">${fc(ar)}</div></div><div class="kpi"><div class="kpi-lbl">Retention</div><div class="kpi-val warn">${fc(ret)}</div></div><div class="kpi"><div class="kpi-lbl">WIP</div><div class="kpi-val">${fc(wip)}</div></div>`;
    }
  };

  console.log('✅ patch-v32.js loaded — per-product inventory accounting fixes');
})();
