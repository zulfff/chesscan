// Engine host. Runs wherever a Worker constructor exists: the offscreen
// document on Chrome, the background event page on Firefox. Results are handed
// to `deliver`, which routes them back to the tab that asked.

import { Engine } from "./engine.js";

const ENGINE_JS = "dist/engine/stockfish-19-lite-single.js";
const IDLE_MS = 180000;
const ext = globalThis.browser ?? globalThis.chrome;

export function createEngineHost({ deliver }) {
  const sessions = new Map();

  function sessionFor(key) {
    let session = sessions.get(key);
    if (!session) {
      const engine = new Engine({ jsUrl: ext.runtime.getURL(ENGINE_JS) });
      session = { engine, key, jobId: null, seq: 0, replyTab: null, lastUsed: Date.now() };
      engine.onError = err => {
        deliver({
          type: "chesscan:error",
          jobId: session.jobId,
          replyTab: session.replyTab,
          message: err.message,
        });
      };
      sessions.set(key, session);
    }
    session.lastUsed = Date.now();
    return session;
  }

  function handle(msg) {
    const key = msg.key || "default";

    switch (msg.type) {
      case "chesscan:analyze": {
        const session = sessionFor(key);
        const seq = Number.isFinite(msg.seq) ? msg.seq : null;
        if (session.jobId === msg.jobId) return;
        // Older clients do not send seq; do not let an undefined value poison
        // the comparison or reject every later job.
        if (seq !== null && seq <= session.seq) return;
        session.jobId = msg.jobId;
        if (seq !== null) session.seq = seq;
        session.replyTab = msg.replyTab ?? null;
        session.engine.analyze(msg.fen, {
          depth: msg.depth,
          multipv: msg.multipv || 3,
          onLines: lines => {
            if (session.jobId !== msg.jobId) return;
            session.lastUsed = Date.now();
            deliver({ type: "chesscan:lines", jobId: msg.jobId, replyTab: session.replyTab, lines });
          },
          onDone: lines => {
            if (session.jobId !== msg.jobId) return;
            deliver({ type: "chesscan:done", jobId: msg.jobId, replyTab: session.replyTab, lines });
          },
        });
        break;
      }
      case "chesscan:stop": {
        const session = sessions.get(key);
        if (session) {
          session.jobId = null;
          session.engine.stop();
        }
        break;
      }
      case "chesscan:ping": {
        const session = sessions.get(key);
        if (session) session.lastUsed = Date.now();
        break;
      }
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastUsed > IDLE_MS) {
        session.jobId = null;
        session.engine.terminate();
        sessions.delete(key);
      }
    }
  }, 60000);

  return { handle };
}