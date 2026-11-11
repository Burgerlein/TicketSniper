// =============================================================================
// Popup: An/Aus pro Tab (nur auf Saalplan-Seiten) und Einstellungen – jederzeit,
// als Standard oder pro Stadion. Preise kommen aus presets.json + Stadion-Log;
// auf einer Saalplan-Seite werden sie beim Öffnen gescannt und gemerkt.
// =============================================================================

const PAGE_PATTERN = /^https:\/\/www\.ticket-onlineshop\.com\/ols\/bvb\/.*\/areaplan\/venue\/event\//;
const CUSTOM = "custom";

const $ = (id) => document.getElementById(id);
const normalizePrice = (price) => Number(String(price).replace(",", ".")).toFixed(2);
const formatPrice = (price) => normalizePrice(price).replace(".", ",");

let state;      // Antwort von background.js (settingsByVenue, venues, …)
let tab;        // aktiver Tab, falls Saalplan-Seite
let pageVenue;  // Stadion der offenen Seite

/** Läuft in der Seite: Stadion, Spiel und alle Preise mit Kategorienamen. */
function scanPage() {
  const scripts = Array.from(document.scripts).map((s) => s.textContent);
  const field = (name) => {
    const match = scripts.find((t) => t.includes(`"${name}"`))?.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
    return match ? JSON.parse(`"${match[1]}"`) : null;
  };

  const match = scripts.find((t) => t.includes("priceCategoriesByPrices"))?.match(/priceCategoriesByPrices:\s*(\{.*?\})/s);
  const categories = match
    ? Object.entries(JSON.parse(match[1])).map(([price, ids]) => ({
        price,
        names: ids.split(",").map((id) =>
          document.querySelector(`#priceCat_${id} .price-list__name-text`)?.textContent.trim() || id
        ),
      }))
    : [];

  return { venue: field("venue_name"), event: field("item_name"), categories };
}

const selectedVenue = () => $("venue").value;

function settingsFor(venue) {
  return { ...state.settingsByVenue[state.defaultVenue], ...(state.settingsByVenue[venue] || {}) };
}

/** Bekannte Kategorien: für ein Stadion dessen eigene, für "Standard" alle zusammen. */
function knownCategories(venue) {
  const lists = venue === state.defaultVenue
    ? Object.values(state.venues).map((v) => v.categories || [])
    : [state.venues[venue]?.categories || []];

  const byPrice = new Map();
  lists.flat().forEach(({ price, names }) => {
    const key = normalizePrice(price);
    byPrice.set(key, [...new Set([...(byPrice.get(key) || []), ...names])]);
  });
  return [...byPrice].map(([price, names]) => ({ price, names })).sort((a, b) => a.price - b.price);
}

function render() {
  const venue = selectedVenue();
  const isDefault = venue === state.defaultVenue;
  const settings = settingsFor(venue);
  const hasOverride = !isDefault && Boolean(state.settingsByVenue[venue]);
  const categories = knownCategories(venue);

  // Preis-Dropdown: bekannte Preise + "Anderer Preis…"
  $("price-select").replaceChildren(
    ...categories.map(({ price, names }) => new Option(`${formatPrice(price)} € – ${names.join(", ")}`, price)),
    new Option("Anderer Preis…", CUSTOM)
  );
  const price = normalizePrice(settings.price);
  const isKnown = categories.some((c) => c.price === price);
  $("price-select").value = isKnown ? price : CUSTOM;
  $("custom-price").value = isKnown ? "" : formatPrice(settings.price);

  $("price-mode").value = settings.priceMode;
  $("price-mode").options[0].text = categories.length && !isDefault
    ? `Günstigster (hier ${formatPrice(categories[0].price)} €)`
    : "Günstigster";
  $("ticket-count").value = String(settings.ticketCount);
  updateVisibility();

  $("venue-hint").textContent = isDefault
    ? "Gilt für alle Stadien ohne eigene Einstellung."
    : hasOverride ? "Eigene Einstellung für dieses Stadion." : "Verwendet Standard – Änderung legt eigene Einstellung an.";
  // Stadion: eigene Einstellung entfernen · Standard: auf Werkseinstellung (Günstigster, 1 Karte)
  $("reset-venue").hidden = !isDefault && !hasOverride;
  $("reset-venue").textContent = isDefault
    ? "Standard zurücksetzen (Günstigster, 1 Karte)"
    : "Für dieses Stadion wieder Standard verwenden";

  // Übersicht der bekannten Kategorien
  const known = state.venues[venue];
  $("venue-info").hidden = isDefault || !categories.length;
  $("venue-info-title").textContent = `Bekannte Kategorien${known?.lastEvent ? ` (zuletzt: ${known.lastEvent})` : ""}`;
  $("venue-categories").replaceChildren(...categories.map(({ price, names }) => {
    const row = document.createElement("div");
    row.append(Object.assign(document.createElement("span"), { textContent: names.join(", ") }));
    row.append(Object.assign(document.createElement("b"), { textContent: `${formatPrice(price)} €` }));
    return row;
  }));
}

function updateVisibility() {
  const fixed = $("price-mode").value === "fixed";
  $("price-row").hidden = !fixed;
  $("custom-price-row").hidden = !fixed || $("price-select").value !== CUSTOM;
}

function currentSettings() {
  const custom = $("price-select").value === CUSTOM;
  const price = custom ? $("custom-price").value.trim() : $("price-select").value;
  return {
    priceMode: $("price-mode").value,
    price: price || settingsFor(selectedVenue()).price,
    ticketCount: Number($("ticket-count").value),
  };
}

async function refreshState() {
  state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab?.id });
}

async function save() {
  updateVisibility();
  await chrome.runtime.sendMessage({ type: "saveSettings", tabId: tab?.id, venue: selectedVenue(), settings: currentSettings() });
  await refreshState();
  $("status").textContent = state.enabled ? "Gespeichert – Seite lädt neu." : "Gespeichert.";
}

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (PAGE_PATTERN.test(activeTab?.url || "")) {
    tab = activeTab;
    // Preise der offenen Seite scannen und fürs Stadion merken
    const [{ result: scan }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage });
    pageVenue = scan?.venue;
    if (pageVenue && scan.categories.length) {
      await chrome.runtime.sendMessage({ type: "recordVenue", venue: pageVenue, event: scan.event, categories: scan.categories });
    }
  }

  await refreshState();

  $("toggle-row").hidden = !tab;
  $("no-page").hidden = Boolean(tab);
  $("enabled").checked = state.enabled;

  // Stadion-Auswahl: Standard + alle bekannten + das der offenen Seite
  const venueNames = new Set([...Object.keys(state.venues), ...Object.keys(state.settingsByVenue)]);
  if (pageVenue) venueNames.add(pageVenue);
  venueNames.delete(state.defaultVenue);
  $("venue").add(new Option("Standard (alle Stadien)", state.defaultVenue));
  [...venueNames].sort().forEach((name) => $("venue").add(new Option(name === pageVenue ? `${name} (offen)` : name, name)));
  $("venue").value = state.defaultVenue;
  render();

  $("venue").addEventListener("change", render);

  $("enabled").addEventListener("change", async (event) => {
    await chrome.runtime.sendMessage({ type: "setEnabled", tabId: tab.id, enabled: event.target.checked });
    window.close();
  });

  $("price-mode").addEventListener("change", save);
  $("price-select").addEventListener("change", () => {
    updateVisibility();
    if ($("price-select").value === CUSTOM) $("custom-price").focus();
    else save();
  });
  // Eigener Preis: bei jeder Eingabe speichern, damit nichts verloren geht, wenn das Popup schließt
  $("custom-price").addEventListener("input", () => {
    if (/^\d+([.,]\d{1,2})?$/.test($("custom-price").value.trim())) save();
  });
  $("ticket-count").addEventListener("change", save);

  $("reset-venue").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearVenueSettings", tabId: tab?.id, venue: selectedVenue() });
    await refreshState();
    render();
    $("status").textContent = selectedVenue() === state.defaultVenue
      ? "Standard zurückgesetzt."
      : "Stadion verwendet wieder Standard.";
  });
}

init();
