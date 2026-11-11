// =============================================================================
// Konfiguration – hier für die Zielseite anpassen
// =============================================================================
const CONFIG = {
  // Button, der nach dem Laden erst den Sitzplan öffnet
  openSeatmapSelector: "#choose-seat-button",

  // Gesuchter Preis. Daraus ermittelt das Script selbst die Preiskategorien
  // (hier "Stehplatz" und "Stehplatz Nord BVB") und deren Farben im Sitzplan.
  price: globalThis.__auswahlHelferSettings?.price || "18,50", // wird im Popup eingestellt
  setPriceFilter: true,      // Preis-Slider zusätzlich auf genau diesen Preis stellen (nur optisch)
  afterFilterDelayMs: 0,     // Zeit, die die Seite nach dem Filtern zum Aktualisieren bekommt

  // Sitzplan: Blöcke mit freien Plätzen haben "has-hover" und sind in der
  // Farbe ihrer Preiskategorie gefüllt, ausverkaufte Blöcke sind grau.
  seatmap: {
    containerSelector: "#seatMapContainer",
    activeBlockSelector: "path.bo.has-hover",
    blockOutlineSelector: "path.bo",
    // Nach dem Hineinzoomen: freie Reihen/Plätze (ebenfalls "has-hover", in Kategoriefarbe)
    freeSeatSelector: ".has-hover:not(.bo)",
  },
  priceList: {
    rowSelector: (categoryId) => `#priceCat_${categoryId}`,
    colorSelector: ".price-list__category",
    nameSelector: ".price-list__name-text",
  },

  // Bei Treffer zum Block mit den meisten freien Plätzen navigieren (Tribüne + Block
  // im Filter "Bereich" wählen, der Sitzplan zoomt dorthin). Es wird KEIN Platz gewählt.
  focusBlock: true,
  // Danach per Mausrad-Simulation zur ersten freien Reihe zoomen, bis einzelne Plätze sichtbar sind
  zoomToFirstSeat: true,
  zoomMaxSteps: 8,             // max. Anzahl Zoom-Schritte
  zoomStepDelayMs: 1,         // Pause zwischen zwei Zoom-Schritten in ms
  zoomDeltaY: -45000,           // Zoom pro Schritt (Mausrad); negativer = größerer Sprung
  areaFilter: {
    tribuneSelector: "#select-area",
    blockSelector: "#select-subarea",
  },

  // Prüfintervall und Neuladen
  checkIntervalMs: 120_000,    // alle 2 Minuten prüfen
  maxWaitForElementMs: 15_000, // wie lange nach dem Laden auf Sitzplan & Preisliste gewartet wird

  // Benachrichtigung
  notify: {
    backgroundColor: "#c8f7c5",
    playSound: true,
  },

  // Schlüssel, um den Helfer per Konsole zu pausieren:
  // sessionStorage.setItem("auswahlHelferPaused", "1")
  pauseKey: "auswahlHelferPaused",
};

// ===== Auswahl-Helfer: Outline + Sitz klicken =====
const KLICK_DELAY_MS = 10;      // Wartezeit vor dem Outline-Klick
const REAKTION_TIMEOUT_MS = 2000; // so lange auf eine Reaktion des Saalplans warten
const SITZ_DELAY_MS = 1000;       // Wartezeit nach dem Outline-Klick, bis Sitze da sind
const SITZ_TIMEOUT_MS = 3000;     // so lange auf "selected" warten

const warte = ms => new Promise(r => setTimeout(r, ms));

async function klickeElement(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const base = {
    bubbles: true, cancelable: true, view: window, button: 0,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  const feuer = (type, extra = {}) => {
    const Ev = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ev(type, { ...base, ...pointer, ...extra }));
  };

  // Hover wie bei einer echten Maus
  ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]
    .forEach(t => feuer(t));
  await warte(100);

  // Klick
  feuer("pointerdown", { buttons: 1 });
  feuer("mousedown", { buttons: 1 });
  await warte(50);
  feuer("pointerup", { buttons: 0 });
  feuer("mouseup", { buttons: 0 });
  feuer("click", { buttons: 0 });
}

function warteAufReaktion(root, timeout) {
  return new Promise(resolve => {
    const obs = new MutationObserver(() => { obs.disconnect(); clearTimeout(t); resolve(true); });
    obs.observe(root, { childList: true, subtree: true });
    const t = setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
  });
}

async function klickeOutline(outlineId) {
  const selector =
    `polyline[data-seatGroupOutlineId="${outlineId}"], polyline[data-seatgroupoutlineid="${outlineId}"]`;

  console.info(`[Auswahl-Helfer] Warte ${KLICK_DELAY_MS} ms vor dem Klick …`);
  await warte(KLICK_DELAY_MS);

  const el = document.querySelector(selector);
  if (!el) {
    console.warn("[Auswahl-Helfer] Element nach Delay nicht gefunden:", outlineId);
    return false;
  }

  const root = el.ownerSVGElement || document.body;
  const reaktion = warteAufReaktion(root, REAKTION_TIMEOUT_MS);
  await klickeElement(el);

  if (await reaktion) {
    console.info("[Auswahl-Helfer] ✅ Outline geklickt, Saalplan hat reagiert:", outlineId);
    return true;
  }
  console.warn("[Auswahl-Helfer] ⚠️ Outline geklickt, aber keine Reaktion:", outlineId);
  return false;
}

async function warteAufSelected(sitzId, timeout) {
  const ende = Date.now() + timeout;
  while (Date.now() < ende) {
    const el = document.getElementById(sitzId);
    if (el?.classList.contains("selected")) return true;
    await warte(100);
  }
  return false;
}

async function klickeSitz() {
  console.info(`[Auswahl-Helfer] Warte ${SITZ_DELAY_MS} ms auf Sitze …`);
  await warte(SITZ_DELAY_MS);

  const sitz = document.querySelector("circle.s.has-hover:not(.selected)");
  if (!sitz) {
    console.warn("[Auswahl-Helfer] Kein freier Sitz gefunden");
    return false;
  }

  await klickeElement(sitz);

  if (await warteAufSelected(sitz.id, SITZ_TIMEOUT_MS)) {
    console.info("[Auswahl-Helfer] ✅ Sitz ausgewählt:", sitz.id);
    return true;
  }
  console.warn("[Auswahl-Helfer] ⚠️ Sitz geklickt, aber nicht ausgewählt:", sitz.id);
  return false;
}

const geklickteOutlines = new Set();

function klickeOutlineEinmal(outlineId) {
  if (geklickteOutlines.has(outlineId)) return;
  geklickteOutlines.add(outlineId);
  (async () => {
    const ok = (await klickeOutline(outlineId)) && (await klickeSitz());
    if (!ok) geklickteOutlines.delete(outlineId); // bei Misserfolg späteren Versuch erlauben
  })();
}


// =============================================================================
// Hilfsfunktionen
// =============================================================================

/** Wartet, bis `findFn` etwas liefert (für Seiten, die Inhalte nachladen). */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalisiert Preise wie "18,50 EUR" / "18.50" zu "18.50". */
function normalizePrice(text) {
  const match = String(text).replace(",", ".").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]).toFixed(2) : null;
}

/** Normalisiert Farben ("#FFD503", "#ffd503", "rgb(255, 213, 3)") zu "#ffd503". */
function normalizeColor(color) {
  const value = String(color || "").trim().toLowerCase();
  const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!rgb) return value;
  return "#" + rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

// =============================================================================
// Preis → Preiskategorien → Farben
// =============================================================================

/** Liest die Zuordnung Preis → Kategorie-IDs aus dem Inline-Script der Seite. */
function getCategoryIdsForPrice(price) {
  const script = Array.from(document.scripts).find((s) => s.textContent.includes("priceCategoriesByPrices"));
  const match = script?.textContent.match(/priceCategoriesByPrices:\s*(\{.*?\})/s);
  if (!match) return [];

  const byPrice = JSON.parse(match[1]); // z. B. { "18.50": "p686891,p686888", ... }
  return (byPrice[normalizePrice(price)] || "").split(",").filter(Boolean);
}

/** Liefert für jede Kategorie-ID Name und Farbe aus der Preisliste. */
function getCategories(categoryIds) {
  const { rowSelector, colorSelector, nameSelector } = CONFIG.priceList;
  return categoryIds
    .map((id) => {
      const row = document.querySelector(rowSelector(id));
      const swatch = row?.querySelector(colorSelector);
      if (!swatch) return null;
      return {
        id,
        name: row.querySelector(nameSelector)?.textContent.trim() || id,
        color: normalizeColor(swatch.style.backgroundColor),
      };
    })
    .filter(Boolean);
}

/** Aktive Blöcke im Sitzplan, deren Füllfarbe zu einer der Kategorien passt. */
function findAvailableBlocks(categories) {
  const colors = new Set(categories.map((c) => c.color));
  return Array.from(document.querySelectorAll(CONFIG.seatmap.activeBlockSelector))
    .filter((el) => colors.has(normalizeColor(el.getAttribute("fill"))));
}

/** Liest die Tribünen/Blöcke mit freien Plätzen aus dem Inline-Script der Seite. */
function getAreaList() {
  const script = Array.from(document.scripts).find((s) => s.textContent.includes("areaList:"));
  const match = script?.textContent.match(/areaList:\s*(\[.*?\])\s*,\s*eventId/s);
  return match ? JSON.parse(match[1]) : [];
}

/** Sucht zu den gefundenen Block-Outlines ("bo7518558") Tribüne und Block; der mit den meisten freien Plätzen zuerst. */
function resolveBlocks(blockEls) {
  const ids = new Set(blockEls.map((el) => el.id.replace(/^bo/, "")));
  return getAreaList()
    .flatMap((tribune) => tribune.subAreas.map((block) => ({ tribune, block })))
    .filter(({ block }) => ids.has(String(block.id)))
    .sort((a, b) => b.block.freeSeats - a.block.freeSeats);
}

/** Setzt ein natives <select> auf `value` und informiert die Seite darüber. */
function selectValue(selectEl, value) {
  selectEl.value = String(value);
  selectEl.dispatchEvent(new Event("input", { bubbles: true }));
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Navigiert über den Filter "Bereich" zu Tribüne und Block – wählt keinen Platz aus. */
async function focusBlock({ tribune, block }) {
  const { tribuneSelector, blockSelector } = CONFIG.areaFilter;
  const tribuneEl = document.querySelector(tribuneSelector);
  if (!tribuneEl) return false;

  // Der Filter "Bereich" ist standardmäßig eingeklappt – aufklappen, damit man ihn sieht
  const filter = tribuneEl.closest(".js-filter");
  if (filter) filter.style.display = "block";

  selectValue(tribuneEl, tribune.id);

  // Die Blöcke der Tribüne werden erst nach der Auswahl eingefügt
  const blockEl = await waitFor(() => {
    const el = document.querySelector(blockSelector);
    return el && Array.from(el.options).some((opt) => opt.value === String(block.id)) ? el : null;
  }, 5_000);
  if (blockEl) selectValue(blockEl, block.id);

  console.info(`[Auswahl-Helfer] Navigiert zu ${tribuneEl.selectedOptions[0]?.textContent.trim()}, Block ${block.name} (${block.freeSeats} frei).`);
  return true;
}

/** Simuliert einen Mausrad-Schritt über `el` – der Sitzplan zoomt zur Mausposition hin. */
function wheelZoomAt(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const target = document.elementFromPoint(x, y) || el;
  target.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: CONFIG.zoomDeltaY, deltaMode: 0,
  }));
}

/** Zoomt schrittweise zum ersten freien Element, bis statt Reihen einzelne Plätze gezeichnet werden. */
async function zoomToFirstSeat(categories) {
  document.querySelector(CONFIG.seatmap.containerSelector)?.scrollIntoView({ block: "center" });

  for (let step = 0; step < CONFIG.zoomMaxSteps; step++) {
    const first = findFreeSeats(categories)[0];
    if (!first) break;
    if (first.tagName.toLowerCase() !== "polyline") return first; // einzelner Platz statt Reihe
    wheelZoomAt(first);
    await sleep(CONFIG.zoomStepDelayMs);
  }
  return findFreeSeats(categories)[0] || null;
}

/** Bittet price-filter.js (Seitenkontext) den Slider zu setzen; wiederholt, bis der Slider bereit ist. */
function requestPriceFilter(price, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let retry;

    function onMessage(event) {
      if (event.source !== window || event.data?.type !== "auswahlHelfer:setPriceResult") return;
      if (!event.data.ok && Date.now() < deadline) {
        retry = setTimeout(send, 500);
        return;
      }
      window.removeEventListener("message", onMessage);
      clearTimeout(retry);
      resolve(event.data);
    }

    function send() {
      window.postMessage({ type: "auswahlHelfer:setPrice", price }, "*");
    }

    window.addEventListener("message", onMessage);
    send();
  });
}

// =============================================================================
// Benachrichtigung
// =============================================================================

/** Freie Plätze/Reihen im gezoomten Sitzplan, deren Farbe zu einer der Kategorien passt. */
function findFreeSeats(categories) {
  const { containerSelector, freeSeatSelector } = CONFIG.seatmap;
  const colors = new Set(categories.map((c) => c.color));
  return Array.from(document.querySelectorAll(`${containerSelector} ${freeSeatSelector}`)).filter((el) =>
    colors.has(normalizeColor(el.getAttribute("fill"))) || colors.has(normalizeColor(el.getAttribute("stroke")))
  );
}

function notifyUser(blocks, categories) {
  const { backgroundColor, playSound } = CONFIG.notify;

  document.body.style.backgroundColor = backgroundColor;
  document.title = "✅ BEREIT – " + document.title;

  document.querySelector(CONFIG.seatmap.containerSelector)?.scrollIntoView({ behavior: "smooth", block: "center" });

  if (playSound) beep();
  const names = categories.map((c) => c.name).join(", ");
  console.info(`[Auswahl-Helfer] Plätze verfügbar: ${names} (${blocks.length} Block/Blöcke)`);
}

/** Kurzer Signalton über die Web Audio API (kein Audio-File nötig). */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {
    // Browser blockiert Audio ohne vorherige Nutzerinteraktion – dann eben ohne Ton
  }
}

// =============================================================================
// Ablauf
// =============================================================================

function scheduleReload() {
  console.info(`[Auswahl-Helfer] Noch nicht verfügbar – Neuladen in ${CONFIG.checkIntervalMs / 1000}s.`);
  setTimeout(() => location.reload(), CONFIG.checkIntervalMs);
}

async function main() {
  if (sessionStorage.getItem(CONFIG.pauseKey)) {
    console.info("[Auswahl-Helfer] Pausiert.");
    return;
  }

  const openButton = await waitFor(
    () => document.querySelector(CONFIG.openSeatmapSelector),
    CONFIG.maxWaitForElementMs
  );
  if (openButton) {
    console.info("[Auswahl-Helfer] Öffne Sitzplan.");
    openButton.click();
  }

  const categoryIds = getCategoryIdsForPrice(CONFIG.price);
  if (!categoryIds.length) {
    console.warn(`[Auswahl-Helfer] Keine Preiskategorie zum Preis ${CONFIG.price} gefunden.`);
    return scheduleReload();
  }

  const categories = await waitFor(() => {
    const found = getCategories(categoryIds);
    return found.length ? found : null;
  }, CONFIG.maxWaitForElementMs);
  if (!categories) {
    console.warn("[Auswahl-Helfer] Preisliste nicht gefunden.", categoryIds);
    return scheduleReload();
  }
  console.info("[Auswahl-Helfer] Gesuchte Kategorien:", categories);

  // Sitzplan fertig gezeichnet?
  const outlines = await waitFor(
    () => document.querySelector(CONFIG.seatmap.blockOutlineSelector),
    CONFIG.maxWaitForElementMs
  );
  if (!outlines) {
    // Z. B. Warteraum, Fehlerseite oder Sitzplan nicht geladen – später erneut versuchen
    console.warn("[Auswahl-Helfer] Sitzplan nicht gefunden.");
    return scheduleReload();
  }

  // Die Verfügbarkeit wird erst nach dem Zeichnen nachgeladen – auf aktive Blöcke warten.
  // Prüfung bewusst VOR dem Preisfilter, da der Filter andere Blöcke ausgrauen kann.
  await waitFor(
    () => document.querySelector(CONFIG.seatmap.activeBlockSelector),
    CONFIG.maxWaitForElementMs
  );

  const activeCount = document.querySelectorAll(CONFIG.seatmap.activeBlockSelector).length;
  const blocks = findAvailableBlocks(categories);
  console.info(`[Auswahl-Helfer] Aktive Blöcke gesamt: ${activeCount}, davon passend: ${blocks.length}.`);

  if (!blocks.length) return scheduleReload();

  if (CONFIG.setPriceFilter) {
    const filter = await requestPriceFilter(CONFIG.price, CONFIG.maxWaitForElementMs);
    if (filter.ok) {
      console.info(`[Auswahl-Helfer] Preisfilter gesetzt auf ${filter.value}.`);
      await sleep(CONFIG.afterFilterDelayMs);
    } else {
      console.warn(`[Auswahl-Helfer] Preisfilter nicht gesetzt: ${filter.reason}`, filter.values || "");
    }
  }

  console.info("[Auswahl-Helfer] Verfügbar!", blocks);

  if (CONFIG.focusBlock) {
    const [best] = resolveBlocks(blocks);
    if (best) await focusBlock(best);
    else console.warn("[Auswahl-Helfer] Block nicht in der Bereichsliste gefunden – keine Navigation.");
  }

  // Auf die erste freie Reihe warten (die Blöcke werden nach der Navigation neu gezeichnet)
  let first = await waitFor(() => findFreeSeats(categories)[0], 5_000);
  if (first && CONFIG.zoomToFirstSeat) first = (await zoomToFirstSeat(categories)) || first;

  notifyUser(blocks, categories);

  first = first || blocks[0];
  // Element selbst mitloggen: in der Konsole aufklappbar, Rechtsklick → "In Elementen anzeigen"
  console.info("[Auswahl-Helfer] Erstes gefundenes Element:", first.outerHTML.slice(0, 300), first);

  const outlineId =
    first.getAttribute("data-seatGroupOutlineId") ?? first.getAttribute("data-seatgroupoutlineid");
  klickeOutlineEinmal(outlineId);
}

main();
