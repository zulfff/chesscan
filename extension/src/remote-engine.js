// Client side of the background engine. Same surface as the local Engine:
// analyze(fen, opts) / stop() / terminate(), with automatic recovery when the
// service worker is torn down mid-search.

const ext = globalThis.browser ?? globalThis.chrome;

export class RemoteEngine {
  constructor({ onError } = {}) {
    this.seq = 0;
    this.job = null;
    this.onError = onError || null;
    this.key = `ck-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    ext.runtime.onMessage.addListener(msg => this.receive(msg));
    setInterval(() => this.heartbeat(), 5000);
  }

  send(msg) {
    try {
      const p = ext.runtime.sendMessage({ ...msg, target: "sw", key: this.key });
      p?.catch?.(() => {});
    } catch {
      /* extension context invalidated */
    }
  }

  analyze(fen, { depth, multipv = 3, onLines, onDone }) {
    this.stop();
    const seq = ++this.seq;
    const jobId = `${this.key}:${seq}`;
    this.job = { jobId, seq, fen, depth, multipv, onLines, onDone, lastSeen: Date.now() };
    this.send({ type: "chesscan:analyze", jobId, seq, fen, depth, multipv });
  }

  receive(msg) {
    const job = this.job;
    if (!job || !msg || typeof msg !== "object" || msg.target !== "cs") return;
    if (msg.jobId !== job.jobId) return;
    job.lastSeen = Date.now();
    if (msg.type === "chesscan:lines") {
      job.onLines(msg.lines || []);
    } else if (msg.type === "chesscan:done") {
      this.job = null;
      job.onDone(msg.lines || []);
    } else if (msg.type === "chesscan:error") {
      this.job = null;
      this.onError?.(new Error(msg.message || "engine error"));
    }
  }

  heartbeat() {
    const job = this.job;
    if (!job) return;
    // A depth-22 lite search can spend a while between info lines, so this is
    // deliberately longer than a normal depth-18 search. If the background
    // really died, the tab waits this long before asking again.
    if (Date.now() - job.lastSeen > 12000) {
      // The worker restarted (or the search died): ask again with a fresh job
      // id and sequence number. The host uses the sequence to reject a stale
      // resend that overtakes a newer one.
      job.seq = ++this.seq;
      job.jobId = `${this.key}:${job.seq}`;
      job.lastSeen = Date.now();
      this.send({
        type: "chesscan:analyze",
        jobId: job.jobId,
        seq: job.seq,
        fen: job.fen,
        depth: job.depth,
        multipv: job.multipv,
      });
    } else {
      this.send({ type: "chesscan:ping" });
    }
  }

  stop() {
    if (!this.job) return;
    this.job = null;
    this.send({ type: "chesscan:stop" });
  }

  terminate() {
    this.stop();
  }
}