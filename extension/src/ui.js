import { CSS } from "./ui.css.js";

const DEPTHS = [12, 14, 16, 18, 20, 22];
const PLAYS = [
  ["off", "off"],
  ["auto", "auto"],
  ["casual", "casual"],
  ["club", "club"],
  ["solid", "solid"],
  ["strongClub", "strong club"],
  ["expert", "expert"],
  ["master", "master"],
  ["max", "max"],
];
const SRCS = [
  ["auto", "auto"],
  ["server", "server"],
  ["local", "local"],
];
const WIDTH = 318;

// Static, compile-time markup: no page or user data is interpolated here.
const MARKUP = `
      <div class="panel" data-collapsed="false" role="complementary" aria-label="chesscan analysis">
        <header class="head" id="drag">
          <span class="grip" aria-hidden="true">&#10303;</span>
          <span class="brand" title="Live analysis of the board you are looking at">chesscan</span>
          <span class="site" id="site"></span>
          <span class="live" id="live" title="searching"></span>
          <span class="prob" id="prob">&mdash;</span>
          <button class="btn icon" id="collapse" aria-label="Collapse panel" title="Collapse">&ndash;</button>
          <button class="btn icon" id="close" aria-label="Close panel" title="Close">&times;</button>
        </header>
        <div class="body">
          <div class="eval" aria-hidden="true"><span class="fill" id="fill"></span><span class="mid"></span></div>
          <ol class="lines" id="lines" style="min-height:78px"></ol>
          <div class="status" id="status" role="status"></div>
          <div class="fen"><code id="fen">&mdash;</code><button class="btn" id="copy" aria-label="Copy FEN">copy</button></div>
          <div class="bar">
            <button class="btn" id="flip" aria-label="Flip side to move" title="Flip side to move">flip <b id="turn">w</b></button>
            <label class="depth">guide<select id="guide" aria-label="Best-move arrow guide" title="Whose moves the arrow guides"></select></label>
            <label class="depth">d<select id="depth" aria-label="Search depth"></select></label>
            <button class="btn" id="pause" aria-pressed="false" title="Pause analysis">pause</button>
          </div>
          <div class="bar sub">
            <label class="depth">play<select id="play" aria-label="How human-like the suggested move should be" title="Pick moves the way a player of this rating would, or max for full engine strength"></select></label>
            <label class="depth">src<select id="src" aria-label="Where the search runs" title="auto: use the server when it answers, otherwise the local engine. server: always ask the server. local: always search in this tab"></select></label>
            <button class="btn icon" id="cfg" aria-label="Server settings" title="Server address and token">&#9881;</button>
            <label class="depth">pv<select id="pv" aria-label="How many plies of the suggested line to draw" title="How many plies of the suggested line to draw on the board"></select></label>
            <span class="why" id="why" aria-live="polite"></span>
          </div>
          <div class="bar sub review">
            <button class="btn" id="review" title="Send the finished game to the server for a full-game review: accuracy and every mistake tagged">review game</button>
            <span class="autoinfo" id="reviewinfo" aria-live="polite"></span>
          </div>
          <div class="bar sub cfg" id="cfgrow" hidden>
            <label class="depth grow">url<input id="serverUrl" type="url" placeholder="http://127.0.0.1:8787" aria-label="Server URL"></label>
            <label class="depth grow">token<input id="serverToken" type="password" placeholder="optional" aria-label="Server token"></label>
          </div>
          <div class="bar sub auto">
            <button class="btn" id="auto" aria-pressed="false" title="Play the suggested move on the board, one move at a time. Testing only: off by default, never remembered, stops when you leave the page.">autoplay</button>
            <span class="autoinfo" id="autoinfo" aria-live="polite"></span>
          </div>
        </div>
      </div>
      <button class="pill" id="pill" hidden><span class="dot"></span>chesscan</button>
`;

export class Panel {
  constructor(handlers) {
    this.h = handlers;
    this.host = null;
    this.pos = null;
    this.fen = "";
    this.mounted = false;
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    const host = document.createElement("div");
    host.id = "chesscan-ext-root";
    host.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;overflow:visible;display:block;";
    document.documentElement.appendChild(host);
    this.host = host;

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const root = document.createElement("div");
    root.innerHTML = MARKUP;
    shadow.append(style, root);

    const $ = id => root.querySelector(`#${id}`);
    this.el = {
      panel: root.querySelector(".panel"),
      drag: $("drag"),
      site: $("site"),
      live: $("live"),
      prob: $("prob"),
      fill: $("fill"),
      lines: $("lines"),
      status: $("status"),
      fen: $("fen"),
      copy: $("copy"),
      flip: $("flip"),
      turn: $("turn"),
      guide: $("guide"),
      depth: $("depth"),
      play: $("play"),
      src: $("src"),
      cfg: $("cfg"),
      cfgrow: $("cfgrow"),
      review: $("review"),
      reviewinfo: $("reviewinfo"),
      serverUrl: $("serverUrl"),
      serverToken: $("serverToken"),
      pv: $("pv"),
      why: $("why"),
      auto: $("auto"),
      autoinfo: $("autoinfo"),
      pause: $("pause"),
      collapse: $("collapse"),
      close: $("close"),
      pill: $("pill"),
    };

    for (const d of DEPTHS) {
      const o = document.createElement("option");
      o.value = String(d);
      o.textContent = String(d);
      this.el.depth.appendChild(o);
    }
    for (const [value, label] of [
      ["auto", "auto"],
      ["white", "white"],
      ["black", "black"],
      ["both", "both"],
      ["off", "off"],
    ]) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      this.el.guide.appendChild(o);
    }

    for (const [value, label] of PLAYS) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      this.el.play.appendChild(o);
    }

    for (const [value, label] of SRCS) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      this.el.src.appendChild(o);
    }

    for (const n of [1, 2, 3]) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = String(n);
      this.el.pv.appendChild(o);
    }

    this.el.close.addEventListener("click", () => this.h.onClose());
    this.el.collapse.addEventListener("click", () => this.h.onCollapse());
    this.el.pill.addEventListener("click", () => this.h.onOpen());
    this.el.flip.addEventListener("click", () => this.h.onFlip());
    this.el.guide.addEventListener("change", () => this.h.onGuide(this.el.guide.value));
    this.el.play.addEventListener("change", () => this.h.onPlay(this.el.play.value));
    this.el.src.addEventListener("change", () => this.h.onSrc(this.el.src.value));
    this.el.cfg.addEventListener("click", () => this.h.onConfigToggle());
    this.el.review.addEventListener("click", () => this.h.onReview?.());
    this.el.serverUrl.addEventListener("change", () => this.h.onServerUrl(this.el.serverUrl.value.trim()));
    this.el.serverToken.addEventListener("change", () => this.h.onServerToken(this.el.serverToken.value.trim()));
    this.el.pv.addEventListener("change", () => this.h.onPv(Number(this.el.pv.value)));
    this.el.pause.addEventListener("click", () => this.h.onPause());
    this.el.auto.addEventListener("click", () => this.h.onAutoplay());
    this.el.copy.addEventListener("click", () => this.h.onCopy(this.fen));
    this.el.depth.addEventListener("change", () => this.h.onDepth(Number(this.el.depth.value)));
    this.el.lines.addEventListener("click", ev => {
      const row = ev.target.closest(".line");
      if (row?.dataset.uci) this.h.onLineClick?.(row.dataset.uci);
    });
    this.el.lines.addEventListener("keydown", ev => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".line");
      if (!row?.dataset.uci) return;
      ev.preventDefault();
      this.h.onLineClick?.(row.dataset.uci);
    });

    this.installDrag();
    this.place(this.pos);
    window.addEventListener("resize", () => this.place(this.pos));
  }

  installDrag() {
    let start = null;
    this.el.drag.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;
      if (ev.target.closest("button, select")) return;
      const rect = this.el.panel.getBoundingClientRect();
      start = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };
      this.el.drag.setPointerCapture(ev.pointerId);
    });
    this.el.drag.addEventListener("pointermove", ev => {
      if (!start) return;
      this.place({
        left: start.left + ev.clientX - start.x,
        top: start.top + ev.clientY - start.y,
      });
    });
    const end = () => {
      if (!start) return;
      start = null;
      const left = parseFloat(this.el.panel.style.left);
      const top = parseFloat(this.el.panel.style.top);
      this.pos = Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
      this.h.onMove(this.pos);
    };
    this.el.drag.addEventListener("pointerup", end);
    this.el.drag.addEventListener("pointercancel", end);
  }

  place(pos) {
    if (!this.mounted) return;
    const maxLeft = Math.max(8, innerWidth - WIDTH - 8);
    const maxTop = Math.max(8, innerHeight - 96);
    // Stored positions can be missing, stale, or NaN after a bad drag. Treat
    // those as "no position" instead of writing NaNpx into the style.
    const valid = pos && Number.isFinite(pos.left) && Number.isFinite(pos.top);
    const left = valid
      ? Math.min(Math.max(8, pos.left), maxLeft)
      : Math.max(8, innerWidth - WIDTH - 16);
    const top = valid ? Math.min(Math.max(8, pos.top), maxTop) : 64;
    this.el.panel.style.left = `${left}px`;
    this.el.panel.style.top = `${top}px`;
  }

  show() {
    this.el.panel.hidden = false;
    this.el.pill.hidden = true;
  }

  hide() {
    this.el.panel.hidden = true;
    this.el.pill.hidden = false;
  }

  setCollapsed(collapsed) {
    this.el.panel.dataset.collapsed = collapsed ? "true" : "false";
    this.el.collapse.textContent = collapsed ? "+" : "\u2013";
    this.el.collapse.setAttribute(
      "aria-label",
      collapsed ? "Expand panel" : "Collapse panel",
    );
  }

  setSite(site) {
    this.el.site.textContent = site === "chesscom" ? "chess.com" : "";
  }

  setTurn(turn) {
    this.el.turn.textContent = turn;
  }

  setDepth(depth) {
    this.el.depth.value = String(depth);
  }

  setGuide(guide) {
    this.el.guide.value = guide;
  }

  setPlayMode(mode) {
    this.el.play.value = mode || "off";
  }

  setSrc(src) {
    this.el.src.value = src || "auto";
  }

  setConfigVisible(visible) {
    this.el.cfgrow.hidden = !visible;
  }

  /** Review button state: idle, running (disabled) with a progress note, or an error note. */
  setReview(on, note) {
    this.el.review.setAttribute("aria-pressed", on ? "true" : "false");
    this.el.review.disabled = !!on;
    this.el.review.textContent = on ? "reviewing…" : "review game";
    this.el.reviewinfo.textContent = note || "";
    this.el.reviewinfo.classList.toggle("stopped", !on && !!note);
  }

  /**
   * The finished report, in the line list: one row per tagged move, the
   * summary line at the top. rows: [{san, tag, loss, accuracy, eval}].
   */
  setReviewReport({ accuracy, counts, game_over: over, rows }) {
    const fmt = n => `${Math.round(n)}%`;
    const head = `accuracy W ${fmt(accuracy.white)} · B ${fmt(accuracy.black)}`;
    const parts = [];
    if (counts.white.blunder + counts.black.blunder) parts.push(`${counts.white.blunder + counts.black.blunder} blunder`);
    if (counts.white.mistake + counts.black.mistake) parts.push(`${counts.white.mistake + counts.black.mistake} mistake`);
    if (counts.white.inaccuracy + counts.black.inaccuracy) parts.push(`${counts.white.inaccuracy + counts.black.inaccuracy} inaccuracy`);
    if (over) parts.push(over.replace("_", " "));
    this.setStatus(parts.length ? `${head} — ${parts.join(", ")}` : head);

    const tagIcon = { best: "★", good: "·", inaccuracy: "?!", mistake: "?", blunder: "??" };
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = `line review-${row.tag}`;
      li.title = `${row.san}: ${row.tag}, ${fmt(row.accuracy)} accuracy`;
      const san = document.createElement("span");
      san.className = "san";
      san.textContent = `${tagIcon[row.tag] || "·"} ${row.san}`;
      const sc = document.createElement("span");
      sc.className = "sc";
      sc.textContent = row.eval;
      li.append(san, sc);
      frag.append(li);
    }
    if (frag.childNodes.length) this.el.lines.replaceChildren(frag);
  }

  setServerConfig({ url, token } = {}) {
    if (url !== undefined) this.el.serverUrl.value = url;
    if (token !== undefined) this.el.serverToken.value = token;
  }

  /** How many plies of the suggested line the arrow chain draws. */
  setPv(n) {
    this.el.pv.value = String(n || 1);
  }

  /** One word for why the highlighted move was picked. */
  setPlay(word) {
    this.el.why.textContent = word || "";
  }

  setPaused(paused) {
    this.el.pause.setAttribute("aria-pressed", paused ? "true" : "false");
    this.el.pause.textContent = paused ? "resume" : "pause";
    if (paused) this.setSearching(false);
  }

  /** Autoplay is armed for this page only; `note` says what it is doing. */
  setAutoplay(on, note) {
    this.el.auto.setAttribute("aria-pressed", on ? "true" : "false");
    this.el.auto.textContent = on ? "autoplay on" : "autoplay";
    this.el.autoinfo.textContent = note || "";
    this.el.autoinfo.classList.toggle("stopped", !on && !!note);
  }

  setSearching(on) {
    this.el.live.classList.toggle("on", !!on);
    this.el.live.title = on ? "searching" : "idle";
  }

  setFen(fen, turn) {
    this.fen = fen;
    this.el.fen.textContent = fen || "\u2014";
    if (turn) this.setTurn(turn);
  }

  setStatus(text) {
    this.el.status.textContent = text || "";
  }

  clear() {
    this.el.lines.replaceChildren();
    this.el.fen.textContent = "\u2014";
    this.fen = "";
    this.el.prob.textContent = "\u2014";
    this.el.fill.style.width = "50%";
    this.setSearching(false);
  }

  /** rows: [{ san, score, chosen, note }] with score already in white's view; whiteWin 0..1 */
  setAnalysis(rows, whiteWin) {
    if (whiteWin === null || whiteWin === undefined) {
      this.el.prob.textContent = "\u2014";
      this.el.fill.style.width = "50%";
    } else {
      this.el.prob.textContent = `${Math.round(whiteWin * 100)}%`;
      this.el.fill.style.width = `${(whiteWin * 100).toFixed(1)}%`;
    }

    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "line placeholder";
      const san = document.createElement("span");
      san.className = "san";
      san.textContent = "no lines yet";
      li.append(san);
      this.el.lines.replaceChildren(li);
      return;
    }

    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const li = document.createElement("li");
      li.className = `line${i === 0 ? " best" : ""}${row.chosen ? " chosen" : ""}${row.pinned ? " pinned" : ""}`;
      if (row.uci) {
        li.dataset.uci = row.uci;
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.setAttribute("aria-pressed", row.pinned ? "true" : "false");
      }
      if (row.chosen && row.note) li.title = `picked: ${row.note}`;
      else if (row.uci) li.title = "click to draw this line on the board";
      const san = document.createElement("span");
      san.className = "san";
      san.title = row.san;
      san.textContent = row.san;
      const sc = document.createElement("span");
      sc.className = "sc";
      sc.textContent = row.score;
      li.append(san, sc);
      frag.append(li);
    });
    this.el.lines.replaceChildren(frag);
  }
}