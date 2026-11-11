// =============================================================================
// Zählt freie Steh- und Sitzplätze und zeigt sie in einer kleinen Box an.
// Eigenständig (IIFE), damit sich nichts mit content.js überschneidet.
// Quelle: freie Plätze pro Block aus dem Inline-Script der Seite ("areaList"),
// Kategorie pro Block über die Füllfarbe im Sitzplan + Farben der Preisliste.
// =============================================================================
(() => {
  const STATS = {
    standingPattern: /steh/i,             // Kategorienamen, die als Stehplatz zählen
    activeBlockSelector: "path.bo.has-hover",
    tribuneSelector: "#select-area",
    blockSelector: "#select-subarea",
    seatmapSelector: "#seatMapContainer",
    priceListRowSelector: '[id^="priceCat_"]',
    priceListColorSelector: ".price-list__category",
    priceListNameSelector: ".price-list__name-text",
    maxWaitMs: 20_000,
    observeMs: 2_000,                     // so lange aktive Blöcke einsammeln
  };

  function waitFor(findFn, timeoutMs) {
    return new Promise((resolve) => {
      const found = findFn();
      if (found) return resolve(found);

      const observer = new MutationObserver(() => {
        const result = findFn();
        if (result) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(result);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function normalizeColor(color) {
    const value = String(color || "").trim().toLowerCase();
    const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!rgb) return value;
    return "#" + rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  }

  function decodeHtml(text) {
    const el = document.createElement("textarea");
    el.innerHTML = text;
    return el.value;
  }

  function escapeHtml(text) {
    const el = document.createElement("div");
    el.textContent = text;
    return el.innerHTML;
  }

  /** Tribünen/Blöcke mit freien Plätzen aus dem Inline-Script der Seite. */
  function getAreaList() {
    const script = Array.from(document.scripts).find((s) => s.textContent.includes("areaList:"));
    const match = script?.textContent.match(/areaList:\s*(\[.*?\])\s*,\s*eventId/s);
    return match ? JSON.parse(match[1]) : [];
  }

  /** Farbe → Kategorienamen (mehrere Kategorien können dieselbe Farbe haben). */
  function getCategoryNamesByColor() {
    const byColor = new Map();
    document.querySelectorAll(STATS.priceListRowSelector).forEach((row) => {
      const color = normalizeColor(row.querySelector(STATS.priceListColorSelector)?.style.backgroundColor);
      const name = row.querySelector(STATS.priceListNameSelector)?.textContent.trim();
      if (!color || !name) return;
      byColor.set(color, [...(byColor.get(color) || []), name]);
    });
    return byColor;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** Kategorienamen zur ähnlichsten Farbe der Preisliste (Sitzplan- und Listenfarben können leicht abweichen). */
  function namesForColor(color, namesByColor) {
    if (namesByColor.has(color)) return namesByColor.get(color);
    const [r, g, b] = hexToRgb(color);
    let best = [];
    let bestDistance = Infinity;
    namesByColor.forEach((names, candidate) => {
      const [r2, g2, b2] = hexToRgb(candidate);
      const distance = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = names;
      }
    });
    return best;
  }

  /**
   * Sammelt über `durationMs` alle Blöcke, die irgendwann aktiv waren. Ein einzelner
   * Moment reicht nicht: Navigation/Filter (content.js) graut andere Blöcke danach aus.
   */
  function observeActiveBlocks(durationMs) {
    const colorByBlockId = new Map();
    const record = () => {
      document.querySelectorAll(STATS.activeBlockSelector).forEach((el) => {
        const id = el.id.replace(/^bo/, "");
        if (!colorByBlockId.has(id)) colorByBlockId.set(id, normalizeColor(el.getAttribute("fill")));
      });
    };
    record();

    const observer = new MutationObserver(record);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "fill"] });
    return new Promise((resolve) => setTimeout(() => {
      observer.disconnect();
      record();
      resolve(colorByBlockId);
    }, durationMs));
  }

  function collectStats(colorByBlockId) {
    const namesByColor = getCategoryNamesByColor();

    const totals = { Steher: 0, Sitzer: 0 };
    const byCategory = {};
    const blocks = [];
    let skipped = 0;

    getAreaList().forEach((tribune) => {
      tribune.subAreas.forEach((block) => {
        if (block.freeSeats <= 0) return;

        // Im Sitzplan nicht (mehr) aktiv → Plätze inzwischen vergeben, nicht mitzählen
        const color = colorByBlockId.get(String(block.id));
        if (!color) {
          skipped += block.freeSeats;
          return;
        }

        const names = namesForColor(color, namesByColor);
        const type = names.some((n) => STATS.standingPattern.test(n)) ? "Steher" : "Sitzer";
        const category = names.join(" / ");

        totals[type] += block.freeSeats;
        byCategory[category] = (byCategory[category] || 0) + block.freeSeats;
        blocks.push({ tribuene: decodeHtml(tribune.name), block: block.name, kategorie: category, typ: type, frei: block.freeSeats, tribuneId: tribune.id, blockId: block.id });
      });
    });

    if (skipped) console.info(`[Auswahl-Helfer:Stats] ${skipped} Plätze nicht gezählt (Block im Sitzplan nicht mehr aktiv).`);
    return { totals, byCategory, blocks };
  }

  /** Alle Preise des Spiels mit Kategorienamen: [{ price: "18.50", names: [...] }]. */
  function getPriceCategories() {
    const script = Array.from(document.scripts).find((s) => s.textContent.includes("priceCategoriesByPrices"));
    const match = script?.textContent.match(/priceCategoriesByPrices:\s*(\{.*?\})/s);
    if (!match) return [];
    return Object.entries(JSON.parse(match[1])).map(([price, ids]) => ({
      price,
      names: ids.split(",")
        .map((id) => document.querySelector(`#priceCat_${id} ${STATS.priceListNameSelector}`)?.textContent.trim())
        .filter(Boolean),
    }));
  }

  /** Gesuchte Kategorien aus den Popup-Einstellungen (Preis → Kategorienamen). */
  function getTarget(priceCategories) {
    const settings = globalThis.__auswahlHelferSettings;
    if (!settings) return null;

    const price = Number(String(settings.price).replace(",", ".")).toFixed(2);
    const names = priceCategories.find((c) => c.price === price)?.names || [];
    return { price, names, ticketCount: settings.ticketCount || 1 };
  }

  /**
   * Günstigste Kombination für `ticketCount` Karten ab dem gesuchten Preis, falls kein
   * einzelner Block reicht – z. B. 1× Stehplatz 18,50 € + 1× nächstgünstigere Kategorie.
   */
  function findCheapestCombination(blocks, target, priceCategories) {
    const priceByName = new Map(priceCategories.flatMap((c) => c.names.map((n) => [n, Number(c.price)])));
    const candidates = blocks
      .map((b) => ({ ...b, price: Math.min(...b.kategorie.split(" / ").map((n) => priceByName.get(n) ?? Infinity)) }))
      .filter((b) => Number.isFinite(b.price) && b.price >= Number(target.price))
      .sort((a, b) => a.price - b.price || b.frei - a.frei);

    const picks = [];
    let remaining = target.ticketCount;
    for (const block of candidates) {
      const take = Math.min(block.frei, remaining);
      picks.push({ ...block, take });
      remaining -= take;
      if (!remaining) return picks;
    }
    return null; // nicht genug freie Plätze ab diesem Preis
  }

  /** Stadion-Log: Kategorien/Preise dieses Stadions für Vorschläge im Popup merken. */
  function recordVenue(priceCategories) {
    const venue = globalThis.__auswahlHelferSettings?.venue;
    if (!venue || !priceCategories.length) return;
    const event = Array.from(document.scripts).map((s) => s.textContent)
      .find((t) => t.includes('"item_name"'))?.match(/"item_name":"((?:[^"\\]|\\.)*)"/);
    chrome.runtime.sendMessage({
      type: "recordVenue",
      venue,
      event: event ? JSON.parse(`"${event[1]}"`) : null,
      categories: priceCategories,
    }).catch(() => {});
  }

  /** Blöcke der gesuchten Kategorie mit mindestens `ticketCount` freien Plätzen, meiste zuerst. */
  function findTargetBlocks(blocks, target) {
    if (!target?.names.length) return [];
    return blocks
      .filter((b) => b.kategorie.split(" / ").some((n) => target.names.includes(n)) && b.frei >= target.ticketCount)
      .sort((a, b) => b.frei - a.frei);
  }

  function renderTarget(blocks, priceCategories) {
    const target = getTarget(priceCategories);
    if (!target) return "";

    const formatPrice = (p) => Number(p).toFixed(2).replace(".", ",");
    const label = `${formatPrice(target.price)} €${target.names.length ? ` (${escapeHtml(target.names.join(", "))})` : ""}`;
    const matches = findTargetBlocks(blocks, target);

    let list;
    if (matches.length) {
      list = matches.slice(0, 5).map((b) => `<div>${escapeHtml(b.tribuene)}, Block ${escapeHtml(b.block)}: <b>${b.frei}</b> frei ${gotoButton(b)}</div>`).join("");
    } else {
      // Kein einzelner Block reicht → günstigste Aufteilung auf mehrere Blöcke/Kategorien
      const combination = target.ticketCount > 1 && findCheapestCombination(blocks, target, priceCategories);
      list = combination
        ? `<div>Günstigste Kombination:</div>` + combination.map((b) =>
            `<div>${b.take}× <b>${formatPrice(b.price)} €</b> ${escapeHtml(b.kategorie)} – ${escapeHtml(b.tribuene)}, Block ${escapeHtml(b.block)} ${gotoButton(b)}</div>`
          ).join("")
        : `<div style="color:#666">Keine Blöcke mit ${target.ticketCount}+ freien Plätzen.</div>`;
    }

    return `
      <div style="margin-top:8px;padding-top:6px;border-top:1px solid #ddd">
        <div>Gesucht: <b>${label}</b> · ${target.ticketCount} ${target.ticketCount === 1 ? "Karte" : "Karten"}</div>
        ${list}
      </div>
    `;
  }

  function gotoButton(block) {
    return `<button data-goto-tribune="${block.tribuneId}" data-goto-block="${block.blockId}"
      style="margin-left:4px;padding:0 6px;font:inherit;font-size:11px;cursor:pointer">Hin</button>`;
  }

  function selectValue(selectEl, value) {
    selectEl.value = String(value);
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Navigiert über den Filter "Bereich" zu Tribüne + Block und scrollt zum Sitzplan – wählt keinen Platz aus. */
  async function gotoBlock(tribuneId, blockId) {
    const tribuneEl = document.querySelector(STATS.tribuneSelector);
    console.info("[Auswahl-Helfer:Stats] Hin:", { tribuneId, blockId, tribuneSelectGefunden: Boolean(tribuneEl),
      tribuenen: tribuneEl ? Array.from(tribuneEl.options).map((o) => `${o.value}=${o.textContent.trim()}`) : [] });
    if (!tribuneEl) return;

    // Der Filter "Bereich" ist standardmäßig eingeklappt – aufklappen, damit man ihn sieht
    const filter = tribuneEl.closest(".js-filter");
    if (filter) filter.style.display = "block";

    selectValue(tribuneEl, tribuneId);
    // Die Blöcke der Tribüne werden erst nach der Auswahl eingefügt
    const blockEl = await waitFor(() => {
      const el = document.querySelector(STATS.blockSelector);
      return el && Array.from(el.options).some((opt) => opt.value === String(blockId)) ? el : null;
    }, 5_000);
    if (blockEl) selectValue(blockEl, blockId);
    console.info("[Auswahl-Helfer:Stats] Hin – Tribüne gesetzt:", tribuneEl.value === String(tribuneId),
      "| Block gesetzt:", Boolean(blockEl) && blockEl.value === String(blockId));

    document.querySelector(STATS.seatmapSelector)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderBox({ totals, byCategory, blocks }, priceCategories) {
    document.getElementById("auswahl-helfer-stats")?.remove();

    const box = document.createElement("div");
    box.id = "auswahl-helfer-stats";
    Object.assign(box.style, {
      position: "fixed", top: "12px", right: "12px", zIndex: 2147483647,
      background: "#fff", color: "#000", border: "2px solid #000", borderRadius: "8px",
      padding: "10px 14px", font: "13px/1.4 system-ui, sans-serif", boxShadow: "0 4px 12px rgba(0,0,0,.25)",
    });

    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `<div style="display:flex;justify-content:space-between;gap:16px"><span>${escapeHtml(name)}</span><b>${count}</b></div>`)
      .join("");

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:6px">
        <b>Freie Plätze</b>
        <span style="cursor:pointer" title="Schließen">✕</span>
      </div>
      <div style="font-size:16px">🧍 Steher: <b>${totals.Steher}</b> &nbsp; 💺 Sitzer: <b>${totals.Sitzer}</b></div>
      ${renderTarget(blocks, priceCategories)}
      <details style="margin-top:6px"><summary style="cursor:pointer">Nach Kategorie</summary>${categories || "–"}</details>
    `;
    box.querySelector('[title="Schließen"]').addEventListener("click", () => box.remove());
    box.querySelectorAll("[data-goto-block]").forEach((button) => button.addEventListener("click", () =>
      gotoBlock(button.dataset.gotoTribune, button.dataset.gotoBlock)
    ));
    document.body.appendChild(box);
  }

  async function main() {
    // Erst wenn der Sitzplan die Verfügbarkeit eingefärbt hat, lassen sich Blöcke Kategorien zuordnen
    await waitFor(() => document.querySelector(STATS.activeBlockSelector), STATS.maxWaitMs);
    const colorByBlockId = await observeActiveBlocks(STATS.observeMs);

    const stats = collectStats(colorByBlockId);
    console.info(`[Auswahl-Helfer:Stats] Steher: ${stats.totals.Steher}, Sitzer: ${stats.totals.Sitzer}`);
    console.table(stats.blocks);
    const priceCategories = getPriceCategories();
    renderBox(stats, priceCategories);
    recordVenue(priceCategories);
  }

  main();
})();
