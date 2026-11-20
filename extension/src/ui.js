import { CSS } from "./ui.css.js";

const DEPTHS = [12, 14, 16, 18, 20, 22];
const WIDTH = 318;

// Static, compile-time markup: no page or user data is interpolated here.
const MARKUP = `
      <div class="panel" data-collapsed="false" role="complementary" aria-label="chesscan analysis">
        <header class="head" id="drag">
          <span class="grip" aria-hidden="true">&#10303;</span>
          <span class="brand" title="Stockfish 19 lite, running locally">chesscan</span>
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

    this.el.close.addEventListener("click", () => this.h.onClose());
    this.el.collapse.addEventListener("click", () => this.h.onCollapse());
    this.el.pill.addEventListener("click", () => this.h.onOpen());
    this.el.flip.addEventListener("click", () => this.h.onFlip());
    this.el.guide.addEventListener("change", () => this.h.onGuide(this.el.guide.value));
    this.el.pause.addEventListener("click", () => this.h.onPause());
    this.el.copy.addEventListener("click", () => this.h.onCopy(this.fen));
    this.el.depth.addEventListener("change", () => this.h.onDepth(Number(this.el.depth.value)));
    this.el.lines.addEventListener("click", ev => {
      const row = ev.target.closest(".line");
      if (row?.dataset.san) this.h.onLineClick?.(row.dataset.san);
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
      this.pos = {
        left: parseFloat(this.el.panel.style.left),
        top: parseFloat(this.el.panel.style.top),
      };
      this.h.onMove(this.pos);
    };
    this.el.drag.addEventListener("pointerup", end);
    this.el.drag.addEventListener("pointercancel", end);
  }

  place(pos) {
    if (!this.mounted) return;
    const maxLeft = Math.max(8, innerWidth - WIDTH - 8);
    const maxTop = Math.max(8, innerHeight - 96);
    const left = pos
      ? Math.min(Math.max(8, pos.left), maxLeft)
      : Math.max(8, innerWidth - WIDTH - 16);
    const top = pos ? Math.min(Math.max(8, pos.top), maxTop) : 64;
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

  setPaused(paused) {
    this.el.pause.setAttribute("aria-pressed", paused ? "true" : "false");
    this.el.pause.textContent = paused ? "resume" : "pause";
    if (paused) this.setSearching(false);
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

  /** rows: [{ san, score, best }] with score already in white's view; whiteWin 0..1 */
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
      li.className = `line${i === 0 ? " best" : ""}`;
      li.dataset.san = row.san;
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