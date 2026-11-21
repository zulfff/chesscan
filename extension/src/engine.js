// Stockfish over UCI, running in a Web Worker from an extension URL.
// Single-threaded lite build: no SharedArrayBuffer, no cross-origin isolation.

export const WIN_K = 0.00368208;

export function winProbability(score, turn) {
  if (!score) return 0.5;
  if (score.type === "mate") {
    const value = turn === "w" ? score.value : -score.value;
    return value > 0 ? 1 : 0;
  }
  const cp = turn === "w" ? score.value : -score.value;
  return 1 / (1 + Math.exp(-WIN_K * cp));
}

/** Convert a side-to-move score to the white-perspective convention UIs use. */
export function whiteScore(score, turn) {
  if (!score) return null;
  const sign = turn === "w" ? 1 : -1;
  return { type: score.type, value: score.value * sign };
}

export function formatScore(score) {
  if (!score) return "\u2014";
  if (score.type === "mate") return `#${score.value}`;
  const pawns = score.value / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function parseInfo(line) {
  if (!line.startsWith("info ") || !line.includes(" pv ")) return null;
  const tok = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let score = null;
  let pv = [];
  for (let i = 0; i < tok.length; i++) {
    switch (tok[i]) {
      case "depth":
        depth = Number(tok[++i]) || 0;
        break;
      case "multipv":
        multipv = Number(tok[++i]) || 1;
        break;
      case "score": {
        const kind = tok[++i];
        const value = Number(tok[++i]);
        if (kind === "cp") score = { type: "cp", value };
        else if (kind === "mate") score = { type: "mate", value };
        break;
      }
      case "pv":
        pv = tok.slice(i + 1);
        i = tok.length;
        break;
    }
  }
  if (!score || pv.length === 0) return null;
  return { depth, multipv, score, pv };
}

function lineSignature(lines) {
  return lines
    .map(l => `${l.multipv}:${l.depth}:${l.score.type}${l.score.value}:${l.pv.join(" ")}`)
    .join("|");
}

export class Engine {
  constructor({ jsUrl }) {
    this.jsUrl = jsUrl;
    this.worker = null;
    this.ready = null;
    this.gen = 0;
    this.job = null;
    this.watchdog = null;
    this.onError = null;
    // A stopped search still emits its final info lines and one bestmove.
    // Those belong to the old position and must not touch the new job.
    this.searchActive = false;
    this.staleBestmoves = 0;
  }

  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        settle(reject, new Error("engine did not answer uci within 15s"));
        this.terminate();
      }, 15000);

      let worker;
      try {
        // Runs in the extension's own origin (background), so the worker is
        // same-origin and the glue finds stockfish.wasm next to itself.
        worker = new Worker(this.jsUrl);
      } catch (err) {
        settle(reject, err);
        return;
      }
      this.worker = worker;

      worker.onmessage = event => {
        const data = event.data;
        if (typeof data !== "string") return; // download-progress objects
        if (data === "uciok") {
          worker.postMessage("setoption name Hash value 32");
          worker.postMessage("setoption name Ponder value false");
          worker.postMessage("isready");
        } else if (data === "readyok") {
          settle(resolve);
        } else if (data.startsWith("info ")) {
          this.onInfo(data);
        } else if (data.startsWith("bestmove")) {
          if (this.staleBestmoves > 0) {
            this.staleBestmoves--;
            return;
          }
          this.searchActive = false;
          this.finish();
        }
      };
      worker.onerror = event => {
        const err = new Error(event.message || "engine worker failed");
        settle(reject, err);
        this.fail(err);
      };
      worker.postMessage("uci");
    });
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  onInfo(line) {
    const job = this.job;
    if (!job || this.staleBestmoves > 0) return;
    const info = parseInfo(line);
    if (!info) return;
    const prev = job.lines.get(info.multipv);
    if (!prev || prev.depth <= info.depth) job.lines.set(info.multipv, info);
    this.emit(job);
  }

  emit(job, force = false) {
    if (this.job !== job) return;
    const now = performance.now();
    if (!force && now - job.lastEmit < 80) return;
    job.lastEmit = now;
    const lines = [...job.lines.values()].sort((a, b) => a.multipv - b.multipv);
    job.signature = lineSignature(lines);
    job.onLines(lines);
  }

  analyze(fen, { depth, multipv = 3, onLines, onDone }) {
    const job = {
      lines: new Map(),
      onLines,
      onDone,
      lastEmit: 0,
    };
    this.stop();
    job.gen = ++this.gen;
    this.job = job;

    this.ensure()
      .then(() => {
        if (this.job !== job) return;
        this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
        this.worker.postMessage(`position fen ${fen}`);
        this.worker.postMessage(`go depth ${depth}`);
        this.searchActive = true;
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => {
          if (this.job !== job) return;
          this.stop();
          this.finishJob(job);
        }, 25000);
      })
      .catch(err => {
        if (this.job === job) this.job = null;
        this.fail(err);
      });
  }

  finish() {
    const job = this.job;
    if (!job) return;
    this.job = null;
    this.finishJob(job);
  }

  finishJob(job) {
    clearTimeout(this.watchdog);
    this.watchdog = null;
    const lines = [...job.lines.values()].sort((a, b) => a.multipv - b.multipv);
    // emit() has usually delivered this exact set already; painting it twice
    // makes the panel re-render every PV at the end of each search.
    if (lineSignature(lines) !== job.signature) job.onLines(lines);
    job.onDone(lines);
  }

  stop() {
    this.gen++;
    clearTimeout(this.watchdog);
    this.watchdog = null;
    if (this.job) this.job = null;
    if (this.searchActive) {
      this.searchActive = false;
      this.staleBestmoves++;
      if (this.worker) this.worker.postMessage("stop");
    }
  }

  fail(err) {
    this.stop();
    // A worker that failed to initialise cannot be reused. Drop it so the next
    // analyze() starts a clean one instead of leaking the dead instance.
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = null;
    if (this.onError) this.onError(err);
  }

  terminate() {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = null;
  }
}