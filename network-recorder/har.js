// =============================================================================
// Baut aus den aufgezeichneten Einträgen eine HAR-Datei (in Chrome DevTools →
// Network per Drag & Drop importierbar). Navigationen, Marker und WebSocket-Frames
// stehen in den HAR-Zusatzfeldern "_navigations", "_markers" und "_websockets".
// =============================================================================

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name)?.value;

/** Bodies aus dem Debugger den Requests zuordnen: gleiche URL + Methode, zeitlich nächster. */
function matchBodies(requests, bodies) {
  const byKey = new Map();
  bodies.forEach((body) => {
    const key = `${body.tabId} ${body.method} ${body.url}`;
    byKey.set(key, [...(byKey.get(key) || []), body]);
  });

  const matched = new Map();
  requests.forEach((request) => {
    const candidates = byKey.get(`${request.tabId} ${request.method} ${request.url}`);
    if (!candidates?.length) return;
    const end = request.end ?? request.start;
    let best = 0;
    candidates.forEach((c, i) => { if (Math.abs(c.time - end) < Math.abs(candidates[best].time - end)) best = i; });
    if (Math.abs(candidates[best].time - end) > 10_000) return; // zu weit weg → gehört nicht dazu
    matched.set(request, candidates.splice(best, 1)[0]);
  });
  return matched;
}

function postData(request) {
  const body = request.requestBody;
  if (!body) return undefined;
  const mimeType = header(request.requestHeaders, "content-type") || "";
  if (body.formData) {
    const params = Object.entries(body.formData).flatMap(([name, values]) => values.map((value) => ({ name, value })));
    return { mimeType: mimeType || "application/x-www-form-urlencoded", params, text: new URLSearchParams(params.map((p) => [p.name, p.value])).toString() };
  }
  return { mimeType, text: body.text ?? `[${body.error}]` };
}

function toHarEntry(request, body) {
  const [httpVersion = "", , ...statusText] = (request.statusLine || "").split(" ");
  const time = Math.max(0, (request.end ?? request.start) - request.start);
  return {
    startedDateTime: new Date(request.start).toISOString(),
    time,
    request: {
      method: request.method,
      url: request.url,
      httpVersion,
      headers: request.requestHeaders || [],
      queryString: [...new URL(request.url).searchParams].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: -1,
      postData: postData(request),
    },
    response: {
      status: request.status ?? 0,
      statusText: statusText.join(" ") || request.error || "",
      httpVersion,
      headers: request.responseHeaders || [],
      cookies: [],
      content: {
        size: body?.body.length ?? 0,
        mimeType: body?.mimeType || header(request.responseHeaders, "content-type") || "",
        text: body?.body,
        encoding: body?.base64Encoded ? "base64" : undefined,
      },
      redirectURL: request.redirectUrl || "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    serverIPAddress: request.ip || undefined,
    _resourceType: request.type,
    _initiator: request.initiator,
    _tabId: request.tabId,
    _frameId: request.frameId,
    _fromCache: request.fromCache,
    _error: request.error,
  };
}

function buildHar(items) {
  const requests = items.filter((i) => i.kind === "request").sort((a, b) => a.start - b.start);
  const bodies = matchBodies(requests, items.filter((i) => i.kind === "body"));
  return {
    log: {
      version: "1.2",
      creator: { name: "Netzwerk-Rekorder", version: chrome.runtime.getManifest().version },
      pages: [],
      entries: requests.map((r) => toHarEntry(r, bodies.get(r))),
      _navigations: items.filter((i) => i.kind === "nav"),
      _markers: items.filter((i) => i.kind === "marker"),
      _websockets: items.filter((i) => i.kind === "ws"),
    },
  };
}
