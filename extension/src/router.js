// Background routing.
//
// Content scripts can only be reached with tabs.sendMessage, so every engine
// reply is addressed to "sw", mapped back to the requesting tab by jobId, and
// re-sent as "cs". Chrome forwards engine work to an offscreen document;
// Firefox calls the embedded host directly.

const ext = globalThis.browser ?? globalThis.chrome;
const OFFSCREEN_URL = "dist/offscreen.html";
let creating = null;

async function ensureOffscreen() {
  if (!ext.offscreen) return;
  if (creating) {
    await creating.catch(() => {});
    return;
  }
  creating = (async () => {
    const url = ext.runtime.getURL(OFFSCREEN_URL);
    const existing = await ext.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    if (existing.length > 0) return;
    await ext.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run the Stockfish WASM engine for board analysis",
    });
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}

function forwardToEngine(msg) {
  if (!ext.offscreen) return;
  const send = () => {
    try {
      const p = ext.runtime.sendMessage(msg);
      p?.catch?.(() => {});
    } catch {
      /* no receiver */
    }
  };
  (async () => {
    await ensureOffscreen().catch(err => console.warn("[chesscan] offscreen", err));
    send();
    // The document may still have been loading when the first copy arrived.
    // The host ignores duplicate jobIds and stale seq numbers.
    setTimeout(send, 800);
  })();
}

export function startRouter({ host }) {
  const routes = new Map(); // jobId -> tabId

  function deliver(payload) {
    // replyTab travels with the job so routing survives a service-worker
    // restart; the in-memory map is only a fallback for older messages.
    const tabId = payload.replyTab ?? routes.get(payload.jobId);
    if (tabId === undefined || tabId === null) return;
    if (payload.type === "chesscan:done" || payload.type === "chesscan:error") {
      routes.delete(payload.jobId);
    }
    try {
      const p = ext.tabs.sendMessage(tabId, { ...payload, target: "cs" });
      p?.catch?.(() => {});
    } catch {
      /* tab closed */
    }
  }

  ext.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || typeof msg !== "object" || msg.target !== "sw") return;

    if (msg.type === "chesscan:analyze") {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) routes.set(msg.jobId, tabId);
      const routed = { ...msg, replyTab: tabId ?? msg.replyTab ?? null };
      if (host) host.handle(routed);
      else forwardToEngine({ ...routed, target: "engine" });
      return;
    }

    if (
      msg.type === "chesscan:lines" ||
      msg.type === "chesscan:done" ||
      msg.type === "chesscan:error"
    ) {
      deliver(msg);
      return;
    }

    // stop / ping
    if (host) host.handle(msg);
    else forwardToEngine({ ...msg, target: "engine" });
  });

  // Only keep the map bounded if a tab disappears without a done message.
  setInterval(() => {
    if (routes.size > 200) routes.clear();
  }, 120000);

  return { deliver };
}