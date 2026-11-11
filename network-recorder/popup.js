// =============================================================================
// Popup: Aufnahme pro Tab an/aus, Marker setzen, Export als JSON/HAR, Löschen.
// =============================================================================

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let tab;

async function refresh() {
  const state = await send({ type: "getState", tabId: tab.id });
  $("enabled").checked = Boolean(state.tab);
  $("bodies").checked = Boolean(state.tab?.bodies);
  $("count").textContent = `${state.count} Einträge gespeichert · ${state.recordedTabs} Tab(s) in Aufnahme`;
}

function setStatus(text) {
  $("status").textContent = text;
}

/** Alle Chunks aus dem Speicher in Reihenfolge lesen. */
async function loadItems() {
  await send({ type: "flush" });
  const { meta = { chunks: 0 } } = await chrome.storage.local.get("meta");
  const keys = Array.from({ length: meta.chunks }, (_, i) => `chunk_${i}`);
  const chunks = await chrome.storage.local.get(keys);
  return keys.flatMap((key) => chunks[key] || []);
}

async function download(data, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  await chrome.downloads.download({ url, filename: `netzwerk-rekorder/aufnahme-${stamp}.${extension}`, saveAs: false });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function setRecording() {
  await send({ type: "setRecording", tabId: tab.id, enabled: $("enabled").checked, bodies: $("bodies").checked });
  await refresh();
}

$("enabled").addEventListener("change", setRecording);
$("bodies").addEventListener("change", () => {
  if ($("bodies").checked) $("enabled").checked = true; // Bodies ohne Aufnahme ergibt keinen Sinn
  setRecording().catch((e) => setStatus(`Debugger: ${e.message}`));
});

$("add-marker").addEventListener("click", async () => {
  const text = $("marker-text").value.trim() || "Marker";
  await send({ type: "addMarker", tabId: tab.id, text });
  $("marker-text").value = "";
  setStatus(`Marker „${text}“ gesetzt`);
  await refresh();
});
$("marker-text").addEventListener("keydown", (e) => e.key === "Enter" && $("add-marker").click());

$("export-json").addEventListener("click", async () => {
  const items = await loadItems();
  await download({ exportedAt: new Date().toISOString(), items }, "json");
  setStatus(`${items.length} Einträge als JSON exportiert`);
});

$("export-har").addEventListener("click", async () => {
  const har = buildHar(await loadItems());
  await download(har, "har");
  setStatus(`${har.log.entries.length} Requests als HAR exportiert`);
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Alle aufgezeichneten Daten löschen?")) return;
  await send({ type: "clear" });
  setStatus("Gelöscht");
  await refresh();
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
})();
