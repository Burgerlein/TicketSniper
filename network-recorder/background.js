// =============================================================================
// Netzwerk-Rekorder: zeichnet passiv alle Requests, Redirects und Navigationen
// (inkl. pushState-/Hash-Routing) der aktivierten Tabs auf. Greift nicht in die
// Seite ein – kein Content-Script, nichts im Seitenkontext.
// Optional pro Tab: Antwort-Bodies + WebSocket-Frames über die Debugger-API
// (Chrome zeigt dann die Leiste "… debuggt diesen Browser").
// =============================================================================

const MAX_BODY_CHARS = 200_000; // längere Bodies werden abgeschnitten
const FLUSH_DELAY_MS = 1000;    // Puffer spätestens nach 1 s in den Speicher schreiben
// Nur für diese Typen werden Antwort-Bodies geholt (keine Bilder, Fonts, CSS …)
const BODY_TYPES = new Set(["Document", "XHR", "Fetch", "EventSource", "Other"]);

// tabId -> { bodies: boolean }; liegt in storage.session, damit es Neustarts des Workers überlebt
const recTabs = {};
const ready = chrome.storage.session.get("recTabs").then(({ recTabs: saved = {} }) => {
  Object.assign(recTabs, saved);
  // Debugger nach Neustart des Workers wieder anhängen (Fehler "schon angehängt" ist egal)
  Object.entries(recTabs).forEach(([tabId, { bodies }]) => bodies && attachDebugger(Number(tabId)).catch(() => {}));
});

const isRecorded = (tabId) => tabId >= 0 && Boolean(recTabs[tabId]);
const clip = (text) => (text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…[abgeschnitten, ${text.length} Zeichen]` : text);

// ===== Speichern: Puffer → storage.local in nummerierten Chunks =====
let buffer = [];
let flushTimer = null;
let flushing = Promise.resolve();

function record(item) {
  buffer.push(item);
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const items = buffer;
  buffer = [];
  if (!items.length) return flushing;

  flushing = flushing
    .then(async () => {
      const { meta = { chunks: 0, count: 0 } } = await chrome.storage.local.get("meta");
      await chrome.storage.local.set({
        [`chunk_${meta.chunks}`]: items,
        meta: { chunks: meta.chunks + 1, count: meta.count + items.length },
      });
    })
    .catch((e) => console.warn("[Netzwerk-Rekorder] Speichern fehlgeschlagen:", e));
  return flushing;
}

// ===== Aufnahme an/aus =====
async function setRecording(tabId, enabled, bodies) {
  await ready;
  const hadBodies = recTabs[tabId]?.bodies;
  if (enabled) recTabs[tabId] = { bodies };
  else delete recTabs[tabId];
  await chrome.storage.session.set({ recTabs });

  if (enabled && bodies && !hadBodies) await attachDebugger(tabId);
  if ((!enabled || !bodies) && hadBodies) await chrome.debugger.detach({ tabId }).catch(() => {});

  record({ kind: "marker", time: Date.now(), tabId, text: enabled ? `Aufnahme an${bodies ? " (mit Bodies)" : ""}` : "Aufnahme aus" });
  updateBadge(tabId);
}

function updateBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: recTabs[tabId] ? "REC" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d1242f" }).catch(() => {});
}

// ===== webRequest: jeder Request (und jeder Redirect-Schritt) wird ein Eintrag =====
const pending = new Map(); // requestId -> Eintrag in Arbeit

function readRequestBody(body) {
  if (!body) return null;
  if (body.formData) return { formData: body.formData };
  if (body.raw) {
    const decoder = new TextDecoder();
    return { text: clip(body.raw.map((part) => (part.bytes ? decoder.decode(part.bytes) : `[Datei: ${part.file}]`)).join("")) };
  }
  return body.error ? { error: body.error } : null;
}

function finish(details, extra) {
  const entry = pending.get(details.requestId);
  if (!entry) return;
  pending.delete(details.requestId);
  record({
    ...entry,
    end: details.timeStamp,
    status: details.statusCode ?? null,
    statusLine: details.statusLine ?? null,
    responseHeaders: details.responseHeaders ?? entry.responseHeaders ?? null,
    ip: details.ip ?? null,
    fromCache: details.fromCache ?? false,
    ...extra,
  });
}

const filter = { urls: ["<all_urls>"] };

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    ready.then(() => {
      if (!isRecorded(details.tabId)) return;
      pending.set(details.requestId, {
        kind: "request",
        tabId: details.tabId,
        frameId: details.frameId,
        type: details.type,
        method: details.method,
        url: details.url,
        initiator: details.initiator ?? null,
        start: details.timeStamp,
        requestBody: readRequestBody(details.requestBody),
      });
    });
  },
  filter,
  ["requestBody"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    ready.then(() => {
      const entry = pending.get(details.requestId);
      if (entry) entry.requestHeaders = details.requestHeaders;
    });
  },
  filter,
  ["requestHeaders", "extraHeaders"]
);

// Redirect: dieser Schritt ist fertig, der nächste kommt mit derselben requestId über onBeforeRequest
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => ready.then(() => finish(details, { redirectUrl: details.redirectUrl })),
  filter,
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => ready.then(() => finish(details)),
  filter,
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => ready.then(() => finish(details, { error: details.error })),
  filter
);

// ===== webNavigation: Seitenwechsel, Redirect-Ketten, SPA-Routing =====
function recordNavigation(event) {
  return (details) => {
    ready.then(() => {
      if (!isRecorded(details.tabId)) return;
      record({
        kind: "nav",
        event,
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        time: details.timeStamp,
        transitionType: details.transitionType ?? null,
        transitionQualifiers: details.transitionQualifiers ?? null,
        error: details.error ?? null,
      });
    });
  };
}

chrome.webNavigation.onBeforeNavigate.addListener(recordNavigation("beforeNavigate"));
chrome.webNavigation.onCommitted.addListener(recordNavigation("committed"));
chrome.webNavigation.onHistoryStateUpdated.addListener(recordNavigation("historyState")); // pushState/replaceState
chrome.webNavigation.onReferenceFragmentUpdated.addListener(recordNavigation("hash"));
chrome.webNavigation.onCompleted.addListener(recordNavigation("completed"));
chrome.webNavigation.onErrorOccurred.addListener(recordNavigation("error"));

// Neuer Tab/Fenster aus einem aufgezeichneten Tab (z. B. Warteschlange, Checkout) → mit aufzeichnen
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  ready.then(async () => {
    if (!isRecorded(details.sourceTabId)) return;
    record({ kind: "nav", event: "newTab", tabId: details.tabId, sourceTabId: details.sourceTabId, frameId: 0, url: details.url, time: details.timeStamp });
    await setRecording(details.tabId, true, recTabs[details.sourceTabId].bodies);
  });
});

// ===== Debugger: Antwort-Bodies und WebSocket-Frames =====
const cdpRequests = new Map(); // `${tabId}:${requestId}` -> { url, method, type, status, mimeType }

async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxPostDataSize: 65536 });
}

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (!isRecorded(tabId)) return;
  const key = `${tabId}:${params.requestId}`;

  switch (method) {
    case "Network.requestWillBeSent":
      cdpRequests.set(key, { url: params.request.url, method: params.request.method, type: params.type });
      break;

    case "Network.responseReceived": {
      const request = cdpRequests.get(key);
      if (request) Object.assign(request, { status: params.response.status, mimeType: params.response.mimeType });
      break;
    }

    case "Network.loadingFinished": {
      const request = cdpRequests.get(key);
      cdpRequests.delete(key);
      if (!request || !BODY_TYPES.has(request.type)) break;
      const time = Date.now();
      chrome.debugger
        .sendCommand({ tabId }, "Network.getResponseBody", { requestId: params.requestId })
        .then(({ body, base64Encoded }) => record({ kind: "body", tabId, time, ...request, base64Encoded, body: clip(body) }))
        .catch(() => {}); // z. B. Seite schon weiter navigiert
      break;
    }

    case "Network.loadingFailed":
      cdpRequests.delete(key);
      break;

    case "Network.webSocketCreated":
      record({ kind: "ws", event: "open", tabId, time: Date.now(), url: params.url });
      break;

    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived":
      record({
        kind: "ws",
        event: method === "Network.webSocketFrameSent" ? "sent" : "received",
        tabId,
        time: Date.now(),
        data: clip(params.response.payloadData),
      });
      break;
  }
});

// Leiste "Abbrechen" geklickt oder Tab zu → Bodies für den Tab aus, Aufnahme läuft weiter
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  ready.then(async () => {
    if (!recTabs[tabId]?.bodies) return;
    recTabs[tabId].bodies = false;
    await chrome.storage.session.set({ recTabs });
    record({ kind: "marker", time: Date.now(), tabId, text: `Debugger getrennt (${reason}) – Bodies aus` });
  });
});

// ===== Nachrichten aus dem Popup =====
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    await ready;
    switch (message.type) {
      case "getState": {
        const { meta = { count: 0 } } = await chrome.storage.local.get("meta");
        sendResponse({ tab: recTabs[message.tabId] ?? null, recordedTabs: Object.keys(recTabs).length, count: meta.count + buffer.length });
        break;
      }

      case "setRecording":
        await setRecording(message.tabId, message.enabled, message.bodies);
        sendResponse({ ok: true });
        break;

      case "addMarker":
        record({ kind: "marker", time: Date.now(), tabId: message.tabId ?? null, text: message.text });
        sendResponse({ ok: true });
        break;

      case "flush":
        await flush();
        sendResponse({ ok: true });
        break;

      case "clear":
        buffer = [];
        await flush();
        await chrome.storage.local.clear();
        sendResponse({ ok: true });
        break;
    }
  })();
  return true; // Antwort kommt asynchron
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") ready.then(() => updateBadge(tabId)); // Tab-Badges setzt Chrome beim Laden zurück
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    if (!recTabs[tabId]) return;
    delete recTabs[tabId];
    chrome.storage.session.set({ recTabs });
  });
});
