// =============================================================================
// An/Aus pro Tab, Einstellungen (Standard + pro Stadion) und Stadion-Log.
// Ist ein Tab aktiviert, werden die Scripts nach jedem (Neu-)Laden eingefügt.
// Deaktivieren lädt den Tab neu, damit nichts mehr weiterläuft.
// =============================================================================

// Nur auf Saalplan-Seiten des Shops (beliebiges Spiel)
const PAGE_PATTERN = /^https:\/\/www\.ticket-onlineshop\.com\/ols\/bvb\/.*\/areaplan\/venue\/event\//;

const DEFAULT_VENUE = "*"; // Schlüssel für die Standard-Einstellungen (alle Stadien)
const DEFAULT_SETTINGS = {
  priceMode: "cheapest", // "cheapest" = günstigster Preis des Spiels, "fixed" = `price`
  price: "18,50",
  ticketCount: 1,        // nur für die Ausgabe: Anzahl gesuchter Karten
};

const storageKey = (tabId) => `tab_${tabId}`;

/** Einstellungen pro Stadion; "*" sind die Standard-Einstellungen und immer vollständig. */
async function getSettingsByVenue() {
  const { settingsByVenue = {} } = await chrome.storage.local.get("settingsByVenue");
  return { ...settingsByVenue, [DEFAULT_VENUE]: { ...DEFAULT_SETTINGS, ...settingsByVenue[DEFAULT_VENUE] } };
}

/** Nur das gespeicherte Stadion-Log (ohne Presets). */
async function getLoggedVenues() {
  const { venues = {} } = await chrome.storage.local.get("venues");
  return venues;
}

/** Voreingestellte Preise aus presets.json. */
async function getPresetVenues() {
  try {
    const response = await fetch(chrome.runtime.getURL("presets.json"));
    return (await response.json()).venues || {};
  } catch (e) {
    console.warn("[Auswahl-Helfer] presets.json nicht lesbar:", e);
    return {};
  }
}

/** Kategorien zusammenführen: gleiche Preise → Namen vereinigen. */
function mergeCategories(...lists) {
  const byPrice = new Map();
  lists.flat().forEach(({ price, names }) => {
    const key = Number(price).toFixed(2);
    byPrice.set(key, [...new Set([...(byPrice.get(key) || []), ...names])]);
  });
  return [...byPrice].map(([price, names]) => ({ price, names })).sort((a, b) => a.price - b.price);
}

/** Stadion-Log + Presets: gescannte Preise ergänzen die voreingestellten. */
async function getVenues() {
  const [logged, presets] = await Promise.all([getLoggedVenues(), getPresetVenues()]);
  const venues = {};
  new Set([...Object.keys(presets), ...Object.keys(logged)]).forEach((name) => {
    venues[name] = {
      ...presets[name],
      ...logged[name],
      categories: mergeCategories(presets[name]?.categories || [], logged[name]?.categories || []),
    };
  });
  return venues;
}

async function isEnabled(tabId) {
  const result = await chrome.storage.session.get(storageKey(tabId));
  return Boolean(result[storageKey(tabId)]);
}

async function setEnabled(tabId, enabled) {
  if (enabled) await chrome.storage.session.set({ [storageKey(tabId)]: true });
  else await chrome.storage.session.remove(storageKey(tabId));
  updateBadge(tabId, enabled);
}

function updateBadge(tabId, enabled) {
  chrome.action.setBadgeText({ tabId, text: enabled ? "AN" : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a7f37" });
}

async function reloadIfEnabled(tabId) {
  if (tabId && (await isEnabled(tabId))) chrome.tabs.reload(tabId);
}

/**
 * Läuft in der Seite (isolierter Kontext): wählt die Einstellungen für das Stadion der Seite
 * und stellt sie content.js/stats.js bereit. "Günstigster" wird aus den Seitendaten ermittelt.
 */
function provideSettings(settingsByVenue, defaultVenue) {
  const scripts = Array.from(document.scripts).map((s) => s.textContent);
  const venueMatch = scripts.find((t) => t.includes('"venue_name"'))?.match(/"venue_name":"((?:[^"\\]|\\.)*)"/);
  const venue = venueMatch ? JSON.parse(`"${venueMatch[1]}"`) : null;

  const settings = { ...settingsByVenue[defaultVenue], ...(settingsByVenue[venue] || {}) };
  let price = settings.price;
  if (settings.priceMode === "cheapest") {
    const match = scripts.find((t) => t.includes("priceCategoriesByPrices"))?.match(/priceCategoriesByPrices:\s*(\{.*?\})/s);
    const prices = match ? Object.keys(JSON.parse(match[1])).map(Number) : [];
    if (prices.length) price = Math.min(...prices).toFixed(2);
  }
  globalThis.__auswahlHelferSettings = { ...settings, price, venue };
}

/** Fügt die Scripts einmal pro geladener Seite ein. */
async function injectScripts(tabId) {
  // Marker im isolierten Kontext verhindert doppeltes Einfügen in dieselbe Seite
  const [{ result: alreadyInjected }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const was = window.__auswahlHelferInjected;
      window.__auswahlHelferInjected = true;
      return Boolean(was);
    },
  });
  if (alreadyInjected) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    func: provideSettings,
    args: [await getSettingsByVenue(), DEFAULT_VENUE],
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["price-filter.js"], world: "MAIN" });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js", "stats.js"] });
}

// Nachrichten aus Popup und stats.js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "getState":
        sendResponse({
          enabled: message.tabId ? await isEnabled(message.tabId) : false,
          settingsByVenue: await getSettingsByVenue(),
          venues: await getVenues(),
          defaultVenue: DEFAULT_VENUE,
        });
        break;

      case "setEnabled":
        await setEnabled(message.tabId, message.enabled);
        if (message.enabled) await injectScripts(message.tabId);
        else chrome.tabs.reload(message.tabId);
        sendResponse({ ok: true });
        break;

      case "saveSettings": {
        const settingsByVenue = await getSettingsByVenue();
        settingsByVenue[message.venue] = message.settings;
        await chrome.storage.local.set({ settingsByVenue });
        await reloadIfEnabled(message.tabId);
        sendResponse({ ok: true });
        break;
      }

      case "clearVenueSettings": {
        const settingsByVenue = await getSettingsByVenue();
        delete settingsByVenue[message.venue];
        await chrome.storage.local.set({ settingsByVenue });
        await reloadIfEnabled(message.tabId);
        sendResponse({ ok: true });
        break;
      }

      case "recordVenue": {
        // Stadion-Log: welche Kategorien/Preise es dort gibt, für Vorschläge beim nächsten Mal
        const venues = await getLoggedVenues();
        venues[message.venue] = {
          categories: mergeCategories(venues[message.venue]?.categories || [], message.categories),
          lastEvent: message.event ?? venues[message.venue]?.lastEvent ?? null,
          lastSeen: Date.now(),
        };
        await chrome.storage.local.set({ venues });
        sendResponse({ ok: true });
        break;
      }
    }
  })();
  return true; // Antwort kommt asynchron
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  const enabled = await isEnabled(tabId);
  updateBadge(tabId, enabled); // Tab-Badges setzt Chrome beim Laden zurück
  if (enabled && PAGE_PATTERN.test(tab.url || "")) {
    injectScripts(tabId).catch((e) => console.warn("[Auswahl-Helfer] Einfügen fehlgeschlagen:", e));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(storageKey(tabId)));
