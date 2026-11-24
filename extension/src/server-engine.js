// Client for the chesscan analysis server.
//
// Same surface as RemoteEngine (analyze / stop / terminate) so the panel does
// not care whether the search ran in a service worker or on our own server.
// The response is newline-delimited JSON: one `info` event per completed
// depth, then a `done` event carrying the lines, the humanised pick and the
// exact-solver verdict.

const DEFAULT_URL = "http://127.0.0.1:8787";

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

export class ServerEngine {
  constructor({ url = DEFAULT_URL, token = "", onError = null } = {}) {
    this.url = trimSlash(url);
    this.token = token;
    this.onError = onError || null;
    this.seq = 0;
    this.job = null;
    this.reviewJob = null;
    // The last `done` payload, kept so autoplay can use the think time the
    // server already worked out for this position.
    this.lastDone = null;
  }

  configure({ url, token } = {}) {
    if (url !== undefined) this.url = trimSlash(url);
    if (token !== undefined) this.token = token;
  }

  /** Cheap liveness probe. Never throws. */
  async ping(timeoutMs = 2500) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${this.url}/v1/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  analyze(fen, { depth, multipv = 4, timeMs, play, seed, history, onLines, onDone } = {}) {
    this.stop();
    const jobId = ++this.seq;
    const ctrl = new AbortController();
    this.job = { jobId, ctrl };

    const headers = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const body = JSON.stringify({
      fen,
      depth,
      multipv,
      time_ms: timeMs,
      play,
      seed,
      history,
    });

    (async () => {
      try {
        const res = await fetch(`${this.url}/v1/analyze`, {
          method: "POST",
          headers,
          body,
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`server answered ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!raw) continue;
            let event;
            try {
              event = JSON.parse(raw);
            } catch {
              continue; // a partial or malformed line is not a reason to abort
            }
            if (event.type === "info") {
              if (jobId !== this.seq) return;
              onLines?.(event.lines || []);
            } else if (event.type === "done") {
              if (jobId !== this.seq) return;
              this.lastDone = event;
              this.job = null;
              onDone?.(event.lines || [], event);
              return;
            } else if (event.type === "error") {
              if (jobId !== this.seq) return;
              this.job = null;
              this.onError?.(new Error(event.message || "server error"));
              return;
            }
          }
        }
        if (jobId === this.seq) this.job = null;
      } catch (err) {
        if (jobId !== this.seq) return;
        this.job = null;
        if (err?.name === "AbortError") return;
        this.onError?.(err);
      }
    })();
  }

  stop() {
    if (!this.job) return;
    this.seq++;
    try {
      this.job.ctrl.abort();
    } catch {
      /* already gone */
    }
    this.job = null;
  }

  /**
   * Post-game review: send a finished game as UCI moves, get one `move` event
   * per ply and a final `done` with accuracies and mistake counts. Runs
   * independently of the live search job, so the panel keeps analysing while
   * the review walks the game.
   */
  review({ start, moves, depth, timeMs, signal, onMove, onDone, onError } = {}) {
    const headers = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const body = JSON.stringify({ start, moves, depth, time_ms: timeMs });

    return (async () => {
      try {
        const res = await fetch(`${this.url}/v1/review`, {
          method: "POST",
          headers,
          body,
          signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`server answered ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!raw) continue;
            let event;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }
            if (event.type === "move") {
              onMove?.(event);
            } else if (event.type === "done") {
              onDone?.(event);
              return event;
            } else if (event.type === "error") {
              const err = new Error(event.message || "server error");
              onError?.(err);
              throw err;
            }
          }
        }
      } catch (err) {
        if (err?.name !== "AbortError") onError?.(err);
        throw err;
      }
    })();
  }

  terminate() {
    this.stop();
  }
}
