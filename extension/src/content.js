// Entry point: find a board, turn it into a FEN, ask Stockfish, paint the panel.
// Runs on lichess.org and chess.com; everything stays local to the browser.

import { Chess } from "chess.js";
import { readChesscom } from "./boards/chesscom.js";
import { toFen, plausible, FILES } from "./fen.js";
import { turnFromDiff, turnFromLastMove } from "./turn.js";
import { winProbability, whiteScore, formatScore } from "./engine.js";
import { RemoteEngine } from "./remote-engine.js";
import { Panel } from "./ui.js";

const LOG = "[chesscan]";
const ext = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { depth: 18, guide: "auto", running: true, collapsed: false, pos: null };

const state = {
  settings: null,
  prevPieces: null,
  turn: "w",
  manualTurn: null,
  fen: null,
  rect: null,
  flipped: false,
  boardEl: null,
  bestPv: null,
  searchGen: 0,
  lastUrl: location.href,
  userClosed: false,
};

// --- settings ---------------------------------------------------------------

async function loadSettings() {
  const merge = saved => {
    const settings = { ...DEFAULTS, ...(saved ?? {}) };
    // v0.1 stored a boolean arrow toggle; map it onto the guide selector.
    if (typeof saved?.arrow === "boolean" && saved.guide === undefined) {
      settings.guide = saved.arrow ? "auto" : "off";
    }
    delete settings.arrow;
    return settings;
  };
  try {
    const r = await ext.storage.local.get("settings");
    return merge(r?.settings);
  } catch {
    return new Promise(resolve => {
      try {
        ext.storage.local.get("settings", v => resolve(merge(v?.settings)));
      } catch {
        resolve(merge(null));
      }
    });
  }
}

function saveSettings() {
  const value = { settings: state.settings };
  try {
    const p = ext.storage.local.set(value);
    p?.catch?.(() => {});
  } catch {
    try {
      ext.storage.local.set(value, () => {});
    } catch {
      /* storage unavailable: settings stay in memory */
    }
  }
}

// --- presentation helpers ---------------------------------------------------

function pvToSan(fen, pv, max = 8) {
  const chess = new Chess(fen);
  const parts = [];
  let fullmove = Number(fen.split(" ")[5]) || 1;
  let turn = chess.turn();
  for (let i = 0; i < Math.min(pv.length, max); i++) {
    const uci = pv[i];
    let move;
    try {
      move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
    } catch {
      break;
    }
    if (!move) break;
    if (turn === "w") parts.push(`${fullmove}. ${move.san}`);
    else if (i === 0) parts.push(`${fullmove}... ${move.san}`);
    else parts.push(move.san);
    if (turn === "b") fullmove++;
    turn = turn === "w" ? "b" : "w";
  }
  return parts.join(" ");
}

function uciSquare(uci, offset) {
  const file = FILES.indexOf(uci[offset]);
  const rank = Number(uci[offset + 1]) - 1;
  if (file < 0 || rank < 0 || rank > 7) return null;
  return rank * 8 + file;
}

// --- best-move arrow --------------------------------------------------------

let arrowHost = null;

function arrowLayer() {
  if (!arrowHost) {
    arrowHost = document.createElement("div");
    arrowHost.id = "chesscan-arrow-layer";
    arrowHost.style.cssText =
      "position:fixed;left:0;top:0;pointer-events:none;z-index:2147482999;";
    document.documentElement.appendChild(arrowHost);
  }
  return arrowHost;
}

function hideArrow() {
  if (arrowHost) arrowHost.style.display = "none";
}

function drawArrow(rect, from, to, flipped) {
  const size = rect.width / 8;
  if (!size || from === to) {
    hideArrow();
    return;
  }
  const layer = arrowLayer();
  const center = sq => {
    const file = sq % 8;
    const rank = (sq / 8) | 0;
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return [(col + 0.5) * size, (row + 0.5) * size];
  };
  const [x1, y1] = center(from);
  const [x2, y2] = center(to);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!len) {
    hideArrow();
    return;
  }
  const ux = dx / len;
  const uy = dy / len;
  const head = size * 0.36;
  const half = size * 0.2;
  const sx = x1 + ux * size * 0.18;
  const sy = y1 + uy * size * 0.18;
  const ex = x2 - ux * head * 0.9;
  const ey = y2 - uy * head * 0.9;
  const tipX = x2 - ux * head * 0.12;
  const tipY = y2 - uy * head * 0.12;
  const bx = tipX - ux * head;
  const by = tipY - uy * head;
  const px = -uy;
  const py = ux;
  const width = Math.max(3, size * 0.11);

  layer.style.display = "block";
  layer.style.left = `${rect.left}px`;
  layer.style.top = `${rect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(rect.width));
  svg.setAttribute("height", String(rect.height));
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  svg.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.55))";
  svg.style.opacity = ".92";

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(sx));
  line.setAttribute("y1", String(sy));
  line.setAttribute("x2", String(ex));
  line.setAttribute("y2", String(ey));
  line.setAttribute("stroke", "#d7b061");
  line.setAttribute("stroke-width", String(width));
  line.setAttribute("stroke-linecap", "round");

  const headEl = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  headEl.setAttribute(
    "points",
    `${tipX},${tipY} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`,
  );
  headEl.setAttribute("fill", "#d7b061");

  svg.append(line, headEl);
  layer.replaceChildren(svg);
}

function updateArrow() {
  const s = state.settings;
  const guide = s?.guide ?? "auto";
  if (!s?.running || guide === "off" || !state.rect || !state.bestPv) {
    hideArrow();
    return;
  }
  // "auto" guides the side sitting at the bottom of the board: the player's
  // own colour in a game, white on a spectator/analysis board.
  const guideColor =
    guide === "both" ? null : guide === "auto" ? (state.flipped ? "b" : "w") : guide === "white" ? "w" : "b";
  if (guideColor && state.turn !== guideColor) {
    hideArrow();
    return;
  }
  const from = uciSquare(state.bestPv, 0);
  const to = uciSquare(state.bestPv, 2);
  if (from === null || to === null) {
    hideArrow();
    return;
  }
  drawArrow(state.rect, from, to, state.flipped);
}

function refreshGeometry() {
  if (!state.boardEl || !state.boardEl.isConnected) return;
  const rect = state.boardEl.getBoundingClientRect();
  if (rect.width) state.rect = rect;
  updateArrow();
}

// --- engine -----------------------------------------------------------------

const engine = new RemoteEngine();
engine.onError = err => {
  console.warn(LOG, "engine error", err);
  panel.setStatus(`Engine failed to load: ${err.message}`);
  panel.setSearching(false);
  state.bestPv = null;
  hideArrow();
};

function renderLines(lines, fen, turn) {
  const rows = [];
  let win = null;
  lines.slice(0, 3).forEach((line, i) => {
    const ws = whiteScore(line.score, turn);
    if (i === 0) win = winProbability(line.score, turn);
    rows.push({ san: pvToSan(fen, line.pv) || line.pv.join(" "), score: formatScore(ws) });
  });
  state.bestPv = lines[0]?.pv?.[0] ?? null;
  panel.setAnalysis(rows, win);
  updateArrow();
}

function analyze(fen, turn) {
  const gen = ++state.searchGen;
  panel.setSearching(true);
  engine.analyze(fen, {
    depth: state.settings.depth,
    multipv: 3,
    onLines: lines => {
      if (gen !== state.searchGen) return;
      renderLines(lines, fen, turn);
    },
    onDone: lines => {
      if (gen !== state.searchGen) return;
      panel.setSearching(false);
      renderLines(lines, fen, turn);
    },
  });
}

// --- board loop -------------------------------------------------------------

function detect() {
  return readChesscom();
}

function resetForNavigation() {
  state.lastUrl = location.href;
  state.prevPieces = null;
  state.manualTurn = null;
  state.turn = "w";
  state.fen = null;
  state.bestPv = null;
  state.searchGen++;
}

function tick() {
  if (!state.settings) return;
  if (location.href !== state.lastUrl) resetForNavigation();

  const board = detect();
  if (!board) {
    state.rect = null;
    state.boardEl = null;
    state.prevPieces = null;
    state.fen = null;
    state.bestPv = null;
    engine.stop();
    hideArrow();
    panel.setSite("");
    panel.setStatus("No board detected on this page.");
    panel.clear();
    return;
  }

  if (!state.userClosed) panel.show();
  state.rect = board.rect;
  state.flipped = board.flipped;
  state.boardEl = board.boardEl;

  // Transient states (mid-animation, promotion dialog) keep the last good read.
  if (!plausible(board.pieces)) {
    refreshGeometry();
    return;
  }

  const diff = turnFromDiff(state.prevPieces, board.pieces);
  let turn;
  if (diff) {
    turn = diff;
    state.manualTurn = null;
  } else if (state.manualTurn) {
    turn = state.manualTurn;
  } else {
    turn = turnFromLastMove(board.pieces, board.lastMove) ?? state.turn ?? "w";
  }

  const fen = toFen(board.pieces, turn);
  try {
    new Chess(fen);
  } catch {
    refreshGeometry();
    return;
  }

  state.turn = turn;
  state.prevPieces = board.pieces;
  panel.setSite(board.site);
  panel.setStatus(state.settings.running ? "" : "Paused.");
  panel.setFen(fen, turn);

  if (fen === state.fen) {
    refreshGeometry();
    return;
  }
  state.fen = fen;
  state.bestPv = null;
  updateArrow();

  if (!state.settings.running) {
    panel.setSearching(false);
    return;
  }
  analyze(fen, turn);
}

let debounce = null;
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(tick, 120);
}

const observer = new MutationObserver(mutations => {
  for (const m of mutations) {
    const t = m.target;
    if (t && t.nodeType === 1 && t.closest?.("#chesscan-ext-root, #chesscan-arrow-layer")) return;
  }
  schedule();
});

// --- panel ------------------------------------------------------------------

const panel = new Panel({
  onClose() {
    state.userClosed = true;
    panel.hide();
    engine.stop();
    panel.setSearching(false);
  },
  onOpen() {
    state.userClosed = false;
    panel.show();
    state.fen = null;
    tick();
  },
  onCollapse() {
    state.settings.collapsed = !state.settings.collapsed;
    panel.setCollapsed(state.settings.collapsed);
    saveSettings();
  },
  onFlip() {
    state.manualTurn = state.turn === "w" ? "b" : "w";
    state.fen = null;
    tick();
  },
  onGuide(guide) {
    state.settings.guide = guide;
    panel.setGuide(guide);
    saveSettings();
    updateArrow();
  },
  onPause() {
    state.settings.running = !state.settings.running;
    panel.setPaused(!state.settings.running);
    saveSettings();
    if (state.settings.running) {
      state.fen = null;
      tick();
    } else {
      engine.stop();
      hideArrow();
      panel.setStatus("Paused.");
    }
  },
  onDepth(depth) {
    state.settings.depth = depth;
    saveSettings();
    if (state.settings.running) {
      state.fen = null;
      tick();
    }
  },
  onMove(pos) {
    state.settings.pos = pos;
    saveSettings();
  },
  onCopy(fen) {
    copyText(fen);
  },
});

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* clipboard unavailable */
  }
  ta.remove();
}

// --- boot -------------------------------------------------------------------

async function boot() {
  state.settings = await loadSettings();
  panel.mount();
  panel.setDepth(state.settings.depth);
  panel.setGuide(state.settings.guide);
  panel.setPaused(!state.settings.running);
  panel.setCollapsed(state.settings.collapsed);
  panel.pos = state.settings.pos;
  panel.place(panel.pos);
  panel.hide();

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  let geometryQueued = false;
  const queueGeometry = () => {
    if (geometryQueued) return;
    geometryQueued = true;
    requestAnimationFrame(() => {
      geometryQueued = false;
      refreshGeometry();
    });
  };
  addEventListener("scroll", queueGeometry, { capture: true, passive: true });
  addEventListener("resize", queueGeometry, { passive: true });

  setInterval(() => {
    if (document.hidden) return;
    tick();
  }, 900);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      engine.stop();
      panel.setSearching(false);
    } else {
      state.fen = null;
      tick();
    }
  });

  tick();
  console.info(LOG, "active");
}

boot();