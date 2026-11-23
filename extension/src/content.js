// Entry point: find a board, turn it into a FEN, ask Stockfish, paint the panel.
// Runs on chess.com; everything stays local to the browser.

import { Chess } from "chess.js";
import { readChesscom } from "./boards/chesscom.js";
import {
  toFen,
  inferCastling,
  plausible,
  opponentInCheck,
  successorOf,
  reachableIn,
  FILES,
} from "./fen.js";
import { turnFromDiff, turnFromLastMove } from "./turn.js";
import { winProbability, whiteScore, formatScore } from "./engine.js";
import { RemoteEngine } from "./remote-engine.js";
import { ServerEngine } from "./server-engine.js";
import { Humanizer, Form, SKILL, thinkTime } from "./humanize.js";
import { legalMove, playMoveHuman, promoteQueen } from "./autoplay.js";
import { Panel } from "./ui.js";

const LOG = "[chesscan]";
const ext = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = {
  depth: 18,
  guide: "auto",
  play: "off",
  pv: 2,
  running: true,
  collapsed: false,
  pos: null,
  // "auto" uses the server when it answers, else the local engine.
  src: "auto",
  serverUrl: "",
  serverToken: "",
};

const state = {
  settings: null,
  prevPieces: null,
  turn: "w", // the side the panel is showing (a manual flip changes this)
  realTurn: "w", // the side actually to move, never overridden by a flip
  manualTurn: null,
  fen: null, // the FEN being shown/analysed
  anchorFen: null, // last accepted real position; the only base for the next move
  candidateKey: null, // a changed board waiting to prove it is not a frame
  candidateHits: 0,
  rect: null,
  flipped: false,
  boardEl: null,
  pvUci: null,
  searchGen: 0,
  lastUrl: location.href,
  userClosed: false,
  human: null, // { fen, profile, pick, model } for the position being played
  form: null, // auto mode's session form, advanced once per position
  castling: null, // tracked rights; inferred only on the first read or a jump
  enPassant: null, // target square index after a double pawn push
  engineError: null, // survives the tick loop until a search succeeds
  ply: null, // zero-based ply from chess.com's move list
  linePick: null, // PV the user pinned by clicking a line
  lastRender: null, // { lines, fen, turn } from the last paint, for line clicks
  settled: false, // the search finished; intermediate info lines are not a pick
  // Autoplay. Deliberately not in settings: arming lives and dies with this
  // page, so a reload, a navigation or a closed panel always leaves it off.
  armed: false,
  autoMoves: 0,
  autoTimer: null,
  autoWatch: null,
  autoPromo: null,
  autoBusy: false,
  playedFor: null, // FEN a move was already dispatched for
  autoPrevPlay: null, // play mode borrowed for the session, given back on disarm
  positionAt: 0, // when the current position appeared: thinking starts here
  lastMove: null, // highlighted squares of the move just played
  server: null, // ServerEngine, created at boot
  serverHealthy: null, // null = not probed yet
  recentFens: [], // recent accepted positions, for threefold repetition
};

// A testing harness, not a ladder bot: one arming plays at most this many moves.
const AUTOPLAY_MAX_MOVES = 120;
// How long to wait for the board to accept a dispatched move before giving up.
const AUTOPLAY_ACCEPT_MS = 6000;

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
  // The play mode autoplay borrows is session-only, like the arming itself.
  // Whatever else saves while it is borrowed must not persist it.
  const settings =
    state.autoPrevPlay !== null ? { ...state.settings, play: state.autoPrevPlay } : state.settings;
  const value = { settings };
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

// --- move arrows ------------------------------------------------------------
// The top line is drawn as a chain, not a single pointer: your move, the reply
// it invites, and the follow-up. Each ply is its own arrow, quieter and thinner
// than the one before, so the chain reads as one idea instead of three hints.

// Gold for the move you play, then cooler tones for the continuation.
const PV_COLORS = ["#d7b061", "#7f9cc0", "#5a7183"];
const PV_MAX = 3;

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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Draw the chain. `moves` is [{ from, to, color, opacity, scale }], in board
 * square indices; anything with a bad square is dropped rather than drawn.
 */
function drawArrows(rect, moves, flipped) {
  const size = rect.width / 8;
  if (!size) {
    hideArrow();
    return;
  }
  const center = sq => {
    const file = sq % 8;
    const rank = (sq / 8) | 0;
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return [(col + 0.5) * size, (row + 0.5) * size];
  };

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(rect.width));
  svg.setAttribute("height", String(rect.height));
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  svg.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.55))";

  let drawn = 0;
  for (const move of moves) {
    const { from, to, color } = move;
    if (from === null || to === null || from === to) continue;

    const scale = move.scale ?? 1;
    const [x1, y1] = center(from);
    const [x2, y2] = center(to);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!len) continue;

    const ux = dx / len;
    const uy = dy / len;
    const head = size * 0.36 * scale;
    const half = size * 0.2 * scale;
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

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("opacity", String(move.opacity ?? 0.92));

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(sx));
    line.setAttribute("y1", String(sy));
    line.setAttribute("x2", String(ex));
    line.setAttribute("y2", String(ey));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", String(Math.max(3, size * 0.11 * scale)));
    line.setAttribute("stroke-linecap", "round");

    const headEl = document.createElementNS(SVG_NS, "polygon");
    headEl.setAttribute(
      "points",
      `${tipX},${tipY} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`,
    );
    headEl.setAttribute("fill", color);

    g.append(line, headEl);
    svg.append(g);
    drawn++;
  }

  if (!drawn) {
    hideArrow();
    return;
  }

  const layer = arrowLayer();
  layer.style.display = "block";
  layer.style.left = `${rect.left}px`;
  layer.style.top = `${rect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;
  layer.replaceChildren(svg);
}

/**
 * The side the panel is guiding: "both" for every move, null when the guide is
 * off. Autoplay plays exactly this side, so the arrow and the move always agree.
 */
function guidedSide() {
  const guide = state.settings?.guide ?? "auto";
  if (guide === "off") return null;
  if (guide === "both") return "both";
  // "auto" guides the side sitting at the bottom of the board: the player's
  // own colour in a game, white on a spectator/analysis board.
  return guide === "auto" ? (state.flipped ? "b" : "w") : guide === "white" ? "w" : "b";
}

function updateArrow() {
  const s = state.settings;
  const side = guidedSide();
  if (!s?.running || side === null || !state.rect || !state.pvUci?.length) {
    hideArrow();
    return;
  }
  if (side !== "both" && state.turn !== side) {
    hideArrow();
    return;
  }

  const plies = Math.max(1, Math.min(PV_MAX, Number(s.pv) || 1));
  const moves = state.pvUci.slice(0, plies).map((uci, i) => ({
    from: uciSquare(uci, 0),
    to: uciSquare(uci, 2),
    color: PV_COLORS[i],
    opacity: i === 0 ? 0.94 : i === 1 ? 0.62 : 0.44,
    scale: i === 0 ? 1 : 0.78,
  }));
  drawArrows(state.rect, moves, state.flipped);
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
  state.engineError = `Engine failed to load: ${err.message}`;
  panel.setStatus(state.engineError);
  panel.setSearching(false);
  state.pvUci = null;
  hideArrow();
};

const server = new ServerEngine();
server.onError = err => {
  console.warn(LOG, "server error", err);
  state.engineError = `Server: ${err.message}`;
  panel.setStatus(state.engineError);
  panel.setSearching(false);
  state.pvUci = null;
  hideArrow();
  // A dead server should not be retried on every tick in auto mode.
  state.serverHealthy = false;
};

function useServer() {
  const src = state.settings?.src ?? "auto";
  if (src === "server") return true;
  if (src === "local") return false;
  return state.serverHealthy === true;
}

/** The humaniser parameters the server should use, if any. */
function playRequest() {
  const key = state.settings?.play ?? "off";
  if (key === "max" || key === "off") return { mode: key };
  const profile = state.human?.profile;
  return {
    mode: key,
    elo: profile?.elo,
    aggression: profile?.aggression,
    brilliancy: profile?.brilliancy,
    mistake: profile?.mistake,
  };
}

function rememberFen(fen) {
  const list = state.recentFens;
  if (list[list.length - 1] === fen) return;
  list.push(fen);
  if (list.length > 60) list.shift();
}

// --- human-like move selection ---------------------------------------------

// Four candidates, because a person is usually choosing between three or four
// ideas, not the top three engine lines.
const HUMAN_MULTIPV = 4;
// Commit once the search has thought for a moment. Before that there is no
// "glance" to compare against, and after it the arrow would keep twitching.
const HUMAN_COMMIT_DEPTH = 8;
// Auto mode's centre: the form wanders around this, not around a preset.
const AUTO_BASE = 1500;
// Full-strength mode: no humanizer, one line, the deepest the panel allows.
const MAX_MULTIPV = 1;
const MAX_DEPTH = 22;
const REASON = { temperature: "natural", mistake: "slip", brilliant: "find", forced: "forced" };

/** Full engine strength: MultiPV 1, no ceiling, no randomness. */
function maxStrength() {
  return (state.settings?.play ?? "off") === "max";
}

/** True when the selector asks for a rating-driven pick at all. */
function hasProfile() {
  const key = state.settings?.play ?? "off";
  return key !== "off" && key !== "max";
}

/**
 * The model for this position. One per FEN, because it has to remember the
 * shallow evaluations and the committed pick. In auto mode this is also where
 * the session form takes its next step.
 */
function humanModel(fen) {
  const h = state.human;
  if (h && h.fen === fen) return h;

  const key = state.settings?.play ?? "off";
  let profile;
  if (key === "auto") {
    if (!state.form) state.form = new Form({ base: AUTO_BASE });
    profile = state.form.next();
  } else {
    profile = SKILL[key] ?? SKILL.club;
  }
  state.human = { fen, profile, pick: null, model: new Humanizer({ ...profile }) };
  return state.human;
}

/** Returns the committed pick for this position, or null while it is still thinking. */
function pickMove(lines, fen, turn) {
  if (!hasProfile()) return null;
  const h = humanModel(fen);
  h.model.observe(lines, turn);
  if (h.pick) return h.pick;

  const depth = Math.max(0, ...lines.map(line => line.depth || 0));
  if (depth < Math.min(HUMAN_COMMIT_DEPTH, state.settings.depth)) return null;
  try {
    h.pick = h.model.choose(lines, turn);
  } catch (err) {
    console.warn(LOG, "humanizer failed", err);
    h.pick = null;
  }
  return h.pick;
}

function renderLines(lines, fen, turn, pickOverride = null) {
  state.engineError = null;
  state.lastRender = { lines, fen, turn };
  let pick = pickOverride;
  if (pick) {
    // The server already chose; keep the display model in step with it.
    state.human = { fen, profile: { elo: pick.elo }, pick };
  }
  pick = pick ?? pickMove(lines, fen, turn);
  const rows = [];
  let win = null;
  const count = maxStrength() ? MAX_MULTIPV : hasProfile() ? HUMAN_MULTIPV : 3;
  lines.slice(0, count).forEach((line, i) => {
    const ws = whiteScore(line.score, turn);
    if (i === 0) win = winProbability(line.score, turn);
    const uci = line.pv?.[0] ?? null;
    const chosen = !!pick && pick.uci === uci;
    rows.push({
      uci,
      san: pvToSan(fen, line.pv) || line.pv.join(" "),
      score: formatScore(ws),
      chosen,
      pinned: !!uci && uci === state.linePick,
      note: chosen ? REASON[pick.reason] ?? pick.reason : "",
    });
  });
  // A clicked line pins the arrow chain to that line until it is clicked again
  // or the position changes. Otherwise follow the move actually being suggested,
  // which is not necessarily the engine's first when a play profile picked it.
  const pinned = state.linePick
    ? lines.find(line => line.pv?.[0] === state.linePick)
    : null;
  const shown = pinned ?? (pick ? lines.find(line => line.pv?.[0] === pick.uci) ?? lines[0] : lines[0]);
  state.pvUci = shown?.pv ?? null;
  panel.setAnalysis(rows, win);
  // In auto mode show where the form sits right now; it is the whole point of
  // the mode, and hiding it would just make the drift look like a bug.
  let why = pick ? REASON[pick.reason] ?? pick.reason : maxStrength() ? "max" : "";
  const elo = state.human?.profile?.elo;
  if (why && pick && (state.settings?.play ?? "") === "auto" && elo) why += ` ${elo}`;
  panel.setPlay(why);
  updateArrow();
  maybeAutoplay();
}

function analyze(fen, turn) {
  const gen = ++state.searchGen;
  state.settled = false;
  panel.setSearching(true);
  rememberFen(fen);

  if (useServer()) {
    server.lastDone = null;
    server.analyze(fen, {
      depth: maxStrength() ? Math.max(state.settings.depth, MAX_DEPTH) : state.settings.depth,
      multipv: maxStrength() ? MAX_MULTIPV : hasProfile() ? HUMAN_MULTIPV : 3,
      timeMs: 4000,
      play: playRequest(),
      seed: `${fen}:${state.ply ?? 0}`,
      history: state.recentFens.slice(-40),
      onLines: lines => {
        if (gen !== state.searchGen) return;
        renderLines(lines, fen, turn);
      },
      onDone: (lines, meta) => {
        if (gen !== state.searchGen) return;
        state.settled = true;
        panel.setSearching(false);
        renderLines(lines, fen, turn, meta?.pick ?? null);
      },
    });
    return;
  }

  engine.analyze(fen, {
    depth: maxStrength() ? Math.max(state.settings.depth, MAX_DEPTH) : state.settings.depth,
    multipv: maxStrength() ? MAX_MULTIPV : hasProfile() ? HUMAN_MULTIPV : 3,
    onLines: lines => {
      if (gen !== state.searchGen) return;
      renderLines(lines, fen, turn);
    },
    onDone: lines => {
      if (gen !== state.searchGen) return;
      state.settled = true;
      panel.setSearching(false);
      renderLines(lines, fen, turn);
    },
  });
}

// --- autoplay ---------------------------------------------------------------
// Plays the move the panel is already showing, on the guided side only. Every
// dispatch is re-checked against the FEN that was actually read, because a
// click cannot be taken back and the board may have moved on since the search.

/** Stop, and say why. Safe to call when already disarmed. */
function disarm(note) {
  clearTimeout(state.autoTimer);
  clearInterval(state.autoWatch);
  clearInterval(state.autoPromo);
  state.autoTimer = null;
  state.autoWatch = null;
  state.autoPromo = null;
  state.autoBusy = false;
  state.playedFor = null;
  const was = state.armed;
  state.armed = false;
  // Give back the play mode we borrowed, so disarming leaves the panel as it
  // was found. No tick() here: disarm is called from inside tick.
  if (state.autoPrevPlay !== null) {
    state.settings.play = state.autoPrevPlay;
    state.autoPrevPlay = null;
    panel.setPlayMode(state.settings.play);
    state.human = null;
    state.form = null;
    state.fen = null;
  }
  // Only speak up if it was actually running; a navigation should not leave a
  // red note on a panel whose autoplay was never touched.
  if (was) panel.setAutoplay(false, note || "");
}

function toggleAutoplay() {
  if (state.armed) {
    disarm("stopped");
    return;
  }
  if (guidedSide() === null) {
    panel.setAutoplay(false, "guide is off");
    return;
  }
  // "both" plays every move, which on a real game means the opponent's too.
  // It is for the analysis board, where there is no opponent.
  if (guidedSide() === "both" && !/\/analysis/.test(location.pathname)) {
    panel.setAutoplay(false, "guide both: analysis only");
    return;
  }
  if (!state.settings.running) {
    panel.setAutoplay(false, "paused");
    return;
  }
  state.armed = true;
  state.autoMoves = 0;
  state.playedFor = null;

  // Autoplay is a player, not an engine. With no play profile it would just
  // relay Stockfish's best move, so borrow the wandering "auto" form for the
  // session and hand it back on disarm.
  if (!hasProfile()) {
    state.autoPrevPlay = state.settings.play;
    state.settings.play = "auto";
    panel.setPlayMode("auto");
    state.human = null;
    state.form = null;
    state.fen = null;
    panel.setAutoplay(true, "humanized: auto");
    tick();
    return;
  }
  panel.setAutoplay(true, "armed");
  // Arm means "start thinking now": force a fresh read and search so the first
  // move comes from a current pick, not from whatever the panel last settled on
  // while the page sat idle.
  state.fen = null;
  tick();
}

/**
 * How long to sit before playing, in milliseconds.
 *
 * The humanizer's think time, fed the real position: how many legal moves there
 * are, how close the candidates are, whether the move is forced or an obvious
 * recapture. The search already burned part of that thought, so it is subtracted
 * — the pause a person sees is the remainder, not the whole think on top.
 */
function autoplayDelay(fen, uci, lines, turn) {
  let branching = 30;
  let forced = false;
  let recapture = false;
  try {
    const moves = new Chess(fen).moves({ verbose: true });
    branching = moves.length || 30;
    forced = moves.length === 1;
    const mv = moves.find(m => m.lan === uci);
    const toSq = uciSquare(uci, 2);
    recapture = !!mv?.captured && toSq !== null && !!state.lastMove?.includes(toSq);
  } catch {
    /* an unreadable position is not a reason to invent a number */
  }

  // Close candidates are a real decision; a move that is clearly best is not.
  let inst = 0;
  const wins = (lines ?? [])
    .map(l => winProbability(l.score, turn))
    .filter(v => Number.isFinite(v))
    .sort((a, b) => b - a);
  if (wins.length >= 2) inst = Math.max(0, Math.min(1, 1 - (wins[0] - wins[1]) * 8));

  const elo = state.human?.profile?.elo ?? 1400;
  if (recapture) return Math.max(250, 380 + Math.random() * 520 - (Date.now() - state.positionAt));
  // When the server already priced the thought, use its number.
  const priced = server.lastDone?.pick?.think_ms;
  if (priced) return Math.max(250, priced - (Date.now() - state.positionAt));
  let think = thinkTime({ elo, branching, instability: inst, forced });
  // A find you did not see at first costs time; a slip is usually played
  // quickly, because it looked right at a glance.
  const reason = state.human?.fen === fen ? state.human.pick?.reason : null;
  if (reason === "brilliant") think *= 1.5 + Math.random() * 0.5;
  else if (reason === "mistake") think *= 0.7 + Math.random() * 0.3;
  return Math.max(250, think - (Date.now() - state.positionAt));
}

/**
 * Schedule one move, or do nothing. Called after every paint and on arming;
 * every condition that would make a move wrong is a reason to wait, not to
 * guess. Nothing here dispatches directly.
 */
function maybeAutoplay() {
  if (!state.armed || state.autoBusy || state.autoTimer) return;
  if (!state.settings?.running || document.hidden) return;
  if (state.autoMoves >= AUTOPLAY_MAX_MOVES) {
    disarm(`move cap ${AUTOPLAY_MAX_MOVES}`);
    return;
  }
  const side = guidedSide();
  if (side === null) {
    disarm("guide is off");
    return;
  }
  // Only a finished search is a decision. Intermediate info lines are still
  // changing, and playing one would be playing a half-thought.
  if (!state.settled) return;
  // A manual flip shows the other side's possibilities; it is not this board's
  // turn and nothing may be played from it.
  if (state.manualTurn) return;
  if (side !== "both" && state.realTurn !== side) return;
  const fen = state.fen;
  if (!fen || state.playedFor === fen) return;
  if (state.lastRender?.fen !== fen) return;
  // Exactly the move the arrow draws: pinned line, humanized pick, or best.
  const uci = state.pvUci?.[0];
  if (!uci) return;
  if (!legalMove(fen, uci)) {
    disarm(`refused ${uci}: not legal here`);
    return;
  }
  const delay = autoplayDelay(fen, uci, state.lastRender.lines, state.realTurn);
  state.autoTimer = setTimeout(() => {
    state.autoTimer = null;
    dispatchAutoplay(fen, uci);
  }, delay);
  panel.setAutoplay(true, `${state.autoMoves} played`);
}

/** The one place that touches the board. */
async function dispatchAutoplay(fen, uci) {
  if (!state.armed || state.fen !== fen || state.playedFor === fen) return;
  // Re-read the legality against the position on screen right now, not the one
  // the search started from.
  const mv = legalMove(fen, uci);
  if (!mv) {
    disarm(`refused ${uci}: not legal here`);
    return;
  }
  if (!state.boardEl?.isConnected) {
    disarm("board gone");
    return;
  }
  const rect = state.boardEl.getBoundingClientRect();
  if (!rect.width) {
    disarm("board has no size");
    return;
  }

  state.playedFor = fen;
  state.autoBusy = true;
  // People mix gestures, and reach further for a long move.
  const dist = Math.max(
    Math.abs((mv.from % 8) - (mv.to % 8)),
    Math.abs(((mv.from / 8) | 0) - ((mv.to / 8) | 0)),
  );
  const mode = Math.random() < 0.2 + 0.06 * dist ? "drag" : "click";
  const played = await playMoveHuman(document, state.boardEl, rect, state.flipped, mv, {
    mode,
    abort: () => !state.armed || state.fen !== fen,
  });
  if (!state.armed) return;
  if (state.fen !== fen) {
    // The position moved on mid-gesture. Drop it; the next read decides.
    state.autoBusy = false;
    state.playedFor = null;
    return;
  }
  if (!played) {
    state.autoBusy = false;
    disarm("could not reach the board");
    return;
  }
  if (mv.promotion) {
    // The picker appears after the destination click, not necessarily at once.
    // Offer the queen a few times, then let the accept watch decide.
    let tries = 0;
    state.autoPromo = setInterval(() => {
      tries++;
      if (!state.armed || promoteQueen(document, state.boardEl) || tries >= 6) {
        clearInterval(state.autoPromo);
        state.autoPromo = null;
      }
    }, 250);
  }
  panel.setAutoplay(true, `${mv.san}…`);

  // The board has to actually change. If it does not, stop: retrying a move
  // the site refused is how a harness plays garbage into a live game.
  const deadline = Date.now() + AUTOPLAY_ACCEPT_MS;
  state.autoWatch = setInterval(() => {
    if (!state.armed) {
      clearInterval(state.autoWatch);
      state.autoWatch = null;
      state.autoBusy = false;
      return;
    }
    if (state.fen && state.fen !== fen) {
      clearInterval(state.autoWatch);
      clearInterval(state.autoPromo);
      state.autoWatch = null;
      state.autoPromo = null;
      state.autoBusy = false;
      state.autoMoves++;
      panel.setAutoplay(true, `${state.autoMoves} played`);
      return;
    }
    if (Date.now() > deadline) disarm("board did not accept the move");
  }, 200);
}

// --- board loop -------------------------------------------------------------

function detect() {
  return readChesscom();
}

function samePieces(a, b) {
  if (!a || !b || a.length !== 64 || b.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const p = a[i];
    const q = b[i];
    if (!p && !q) continue;
    if (!p || !q || p.color !== q.color || p.type !== q.type) return false;
  }
  return true;
}

/**
 * FEN move number from the index of the last played move. Index 0 is White's
 * first move, so after `1...e5` (index 1) White is about to play move 2.
 */
function fullmoveOf(ply) {
  return ply === null || ply === undefined ? 1 : Math.floor((ply + 1) / 2) + 1;
}

// Two-ply enumeration is a few hundred positions. Building it once per anchor
// keeps a hold cheap while the board keeps changing underneath it.
let twoPlyCache = { anchor: null, map: null };
function twoPlyFrom(fen) {
  if (twoPlyCache.anchor !== fen) {
    twoPlyCache = { anchor: fen, map: reachableIn(fen, 2) ?? new Map() };
  }
  return twoPlyCache.map;
}

function resetForNavigation() {
  disarm("new page");
  state.lastUrl = location.href;
  state.prevPieces = null;
  state.manualTurn = null;
  state.turn = "w";
  state.realTurn = "w";
  state.fen = null;
  state.anchorFen = null;
  state.candidateKey = null;
  state.candidateHits = 0;
  state.pvUci = null;
  state.human = null;
  state.castling = null;
  state.enPassant = null;
  state.engineError = null;
  state.ply = null;
  state.linePick = null;
  state.lastRender = null;
  state.recentFens = [];
  state.searchGen++;
}

function tick() {
  if (!state.settings) return;
  if (location.href !== state.lastUrl) resetForNavigation();

  const board = detect();
  if (!board) {
    disarm("no board");
    state.rect = null;
    state.boardEl = null;
    state.prevPieces = null;
    state.fen = null;
    state.anchorFen = null;
    state.candidateKey = null;
    state.candidateHits = 0;
    state.pvUci = null;
    state.human = null;
    state.castling = null;
    state.enPassant = null;
    state.engineError = null;
    state.ply = null;
    state.linePick = null;
    state.lastRender = null;
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
  const same = samePieces(state.prevPieces, board.pieces);
  // The move list is the page's own statement of which ply is on the board.
  // It is not updated atomically with the pieces, though: in fast games one is
  // routinely a frame ahead of the other. So it is a tiebreaker, not proof.
  const ply = Number.isInteger(board.ply) ? board.ply : null;
  const step = ply !== null && state.ply !== null ? ply - state.ply : null;

  // Explain the board as exactly one legal move from the last position we
  // accepted. A frame in flight — a piece drawn on two squares, a capture whose
  // victim has not been removed yet — matches nothing, and is not allowed to
  // become the new anchor.
  const successor = !same && state.anchorFen ? successorOf(state.anchorFen, board.pieces) : null;
  let explained = successor;
  let explainedPlies = successor ? 1 : 0;

  // The pieces did not change, so the placement is the same position. If the
  // list moved forward, the board is behind it: hold the last good read and let
  // the pieces catch up. If it moved back, the list is showing an identical
  // (repeated) position and only the turn and move number differ; take those.
  if (same && step !== null && step > 0) {
    refreshGeometry();
    return;
  }

  // A changed board with no legal explanation is a frame in flight until it has
  // held still. How long "still" has to be depends on what else we know:
  //
  //   first read ............. nothing to compare against, take it
  //   one ply ................ a frame is plausible, three looks
  //   two plies .............. enumerated exactly, once the board holds still
  //   anything else, selected  the move list states the position, one more look
  //   anything else, live ..... never: the list is the last move played, not
  //                             necessarily the position on the board, and a
  //                             wrong turn is worse than a late one
  //
  // A board that holds still has to be re-read on a timer, because the page
  // stops mutating the moment the animation ends; waiting for the next DOM
  // event would mean never accepting a real jump.
  if (!same && !explained) {
    const key = toFen(board.pieces, "w").split(" ")[0] + "|" + (ply ?? "");
    if (state.candidateKey === key) state.candidateHits++;
    else {
      state.candidateKey = key;
      state.candidateHits = 1;
    }
    // Two moves between ticks is the common bullet miss, and the one case a
    // single successor cannot explain. Enumerating two plies is exact but costs
    // tens of milliseconds, so it runs only after the board has held still
    // once: while moves keep landing the panel holds instead of burning the
    // page's thread on a position that is about to change again.
    if (state.anchorFen && step !== null && step >= 2 && state.candidateHits >= 2) {
      const hit = twoPlyFrom(state.anchorFen).get(toFen(board.pieces, "w").split(" ")[0]);
      if (hit) {
        explained = hit;
        explainedPlies = 2;
      }
    }
    if (!explained) {
      let need;
      if (state.anchorFen === null) need = 1;
      else if (step === 1) need = 3;
      else need = board.moveSelected ? 2 : Infinity;
      if (state.candidateHits < need) {
        if (Number.isFinite(need)) schedule(160);
        refreshGeometry();
        return;
      }
    }
  }
  state.candidateKey = null;
  state.candidateHits = 0;

  // Build the position. A legal successor carries its own turn, rights and en
  // passant target exactly. A jump or an unexplained read falls back to what is
  // visible, and drops the target.
  let turn;
  let realTurn;
  let castling;
  let enPassant;
  let nextPly;
  let fen;

  if (same && (step === null || step === 0)) {
    // Same board, same ply: reuse the position exactly. A UI action re-ticks
    // it, and the rights and target already tracked are still the right ones.
    realTurn = state.realTurn ?? "w";
    turn = state.manualTurn ?? realTurn;
    castling = state.castling ?? inferCastling(board.pieces);
    enPassant = state.enPassant;
    nextPly = state.ply;
    fen = toFen(board.pieces, turn, { castling, enPassant, fullmove: fullmoveOf(nextPly) });
  } else if (same) {
    // Same placement, earlier ply: a repeated position in the move list. The
    // board cannot be wrong about the pieces, so only the side to move and the
    // move number come from the list.
    realTurn = board.moveTurn ?? state.realTurn ?? "w";
    turn = state.manualTurn ?? realTurn;
    castling = inferCastling(board.pieces);
    enPassant = null;
    nextPly = ply;
    fen = toFen(board.pieces, turn, { castling, enPassant, fullmove: fullmoveOf(nextPly) });
  } else if (explained) {
    // One legal move (or two, when the game outran the reader): the turn,
    // rights and target are the position's own, and a manual "what if" flip
    // ends here.
    state.manualTurn = null;
    const [placement, succTurn, succCastling, succEp] = explained.split(" ");
    realTurn = succTurn;
    turn = succTurn;
    castling = succCastling === "-" ? "" : succCastling;
    enPassant = succEp === "-" ? null : succEp;
    // Count the move we actually adopted, not the list's idea of it: when the
    // list runs a tick ahead the next same-board read has to hold. With no list
    // there is no move number to count from, so it stays unknown.
    nextPly = state.ply === null ? (ply ?? null) : state.ply + explainedPlies;
    fen = `${placement} ${succTurn} ${succCastling} ${succEp} 0 ${fullmoveOf(nextPly)}`;
  } else {
    // A jump (navigation, two moves between ticks) or an unexplained but stable
    // read. The move list states the side outright; otherwise fall back to the
    // two independent inferences.
    realTurn =
      board.moveTurn ?? diff ?? turnFromLastMove(board.pieces, board.lastMove) ?? state.realTurn ?? "w";
    turn = state.manualTurn ?? realTurn;
    castling = inferCastling(board.pieces);
    enPassant = null;
    // The list is the only reason this branch can run, and it says where the
    // board is — including backwards, when the user clicks an earlier node.
    nextPly = ply ?? (state.ply === null ? null : state.ply + 1);
    fen = toFen(board.pieces, turn, { castling, enPassant, fullmove: fullmoveOf(nextPly) });
  }

  try {
    new Chess(fen);
  } catch {
    // Flipping the side by hand can leave an en passant square that is illegal
    // for the new side to move. Show the position without the target, but keep
    // tracking it: flipping back has to restore it.
    fen = toFen(board.pieces, turn, { castling, enPassant: null, fullmove: fullmoveOf(nextPly) });
    try {
      new Chess(fen);
    } catch {
      refreshGeometry();
      return;
    }
  }

  // A position where the side that just moved is still in check cannot occur.
  // That is a snapshot of two positions stitched together (mid-animation, a
  // stale piece the DOM has not removed), not a board. Refuse the frame rather
  // than hand the engine a position that was never on screen.
  if (opponentInCheck(fen)) {
    refreshGeometry();
    return;
  }

  const fullmove = fullmoveOf(nextPly);
  let anchorFen = toFen(board.pieces, realTurn, { castling, enPassant, fullmove });
  try {
    new Chess(anchorFen);
  } catch {
    anchorFen = toFen(board.pieces, realTurn, { castling, enPassant: "-", fullmove });
  }

  state.turn = turn;
  state.realTurn = realTurn;
  state.prevPieces = board.pieces;
  state.castling = castling;
  state.enPassant = enPassant;
  state.ply = nextPly;
  // The anchor is the real position, never the manually flipped view: the next
  // real move has to be explained from the board's own side to move.
  state.anchorFen = anchorFen;
  panel.setSite(board.site);
  panel.setStatus(state.engineError || (state.settings.running ? "" : "Paused."));
  panel.setFen(fen, turn);

  if (fen === state.fen) {
    refreshGeometry();
    return;
  }
  state.fen = fen;
  state.linePick = null;
  state.lastRender = null;
  state.pvUci = null;
  state.settled = false;
  // A new position is a new decision; the old "already played" mark is void.
  state.playedFor = null;
  // The clock starts when the position appears, not when the search finishes:
  // a person is already thinking while the engine is still looking.
  state.positionAt = Date.now();
  state.lastMove = board.lastMove ?? null;
  updateArrow();

  if (!state.settings.running) {
    panel.setSearching(false);
    return;
  }
  analyze(fen, turn);
}

let debounce = null;
function schedule(delay = 120) {
  clearTimeout(debounce);
  debounce = setTimeout(tick, delay);
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
    disarm("panel closed");
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
    // A manual flip is a "what if" view of the other side, not the board's real
    // turn. Autoplay must never fire a move from that view, so stop it here.
    if (state.armed) disarm("manual flip");
    const next = (state.manualTurn ?? state.realTurn) === "w" ? "b" : "w";
    state.manualTurn = next === state.realTurn ? null : next;
    state.fen = null;
    tick();
  },
  onGuide(guide) {
    state.settings.guide = guide;
    panel.setGuide(guide);
    saveSettings();
    if (state.armed && guidedSide() === null) disarm("guide is off");
    updateArrow();
    maybeAutoplay();
  },
  onPlay(play) {
    state.settings.play = play;
    panel.setPlayMode(play);
    saveSettings();
    state.human = null;
    // Entering auto starts a fresh form; switching away forgets the old one.
    state.form = null;
    state.fen = null;
    tick();
  },
  onSrc(src) {
    state.settings.src = src;
    panel.setSrc(src);
    saveSettings();
    state.serverHealthy = null;
    server.ping().then(ok => {
      state.serverHealthy = ok;
      if (src === "server" && !ok) panel.setStatus("server unreachable");
      else if (ok) panel.setStatus("server ready");
    }).catch(() => {
      state.serverHealthy = false;
    });
    state.fen = null;
    tick();
  },
  onConfigToggle() {
    panel.setConfigVisible(panel.el.cfgrow.hidden);
  },
  onServerUrl(url) {
    state.settings.serverUrl = url;
    saveSettings();
    server.configure({ url: url || undefined });
    state.serverHealthy = null;
    server.ping().then(ok => {
      state.serverHealthy = ok;
      panel.setStatus(ok ? "server ready" : "server unreachable");
      if (ok && (state.settings.src ?? "auto") !== "local") {
        state.fen = null;
        tick();
      }
    });
  },
  onServerToken(token) {
    state.settings.serverToken = token;
    saveSettings();
    server.configure({ token: token || undefined });
  },
  onPv(count) {
    state.settings.pv = count;
    panel.setPv(count);
    saveSettings();
    // Only the drawing changes; the line is already in hand.
    updateArrow();
  },
  onLineClick(uci) {
    if (!uci) return;
    state.linePick = state.linePick === uci ? null : uci;
    // Repaint from the lines already in hand so the arrow and the highlight
    // move on the click, not on the next engine info line.
    if (state.lastRender) renderLines(state.lastRender.lines, state.lastRender.fen, state.lastRender.turn);
    else updateArrow();
  },
  onPause() {
    state.settings.running = !state.settings.running;
    panel.setPaused(!state.settings.running);
    saveSettings();
    if (state.settings.running) {
      state.fen = null;
      tick();
    } else {
      disarm("paused");
      engine.stop();
      hideArrow();
      panel.setStatus("Paused.");
    }
  },
  onAutoplay() {
    toggleAutoplay();
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
  panel.setPlayMode(state.settings.play);
  panel.setSrc(state.settings.src);
  panel.setPv(state.settings.pv);
  panel.setPaused(!state.settings.running);
  panel.setAutoplay(false, "");
  panel.setCollapsed(state.settings.collapsed);
  panel.pos = state.settings.pos;
  panel.place(panel.pos);
  panel.hide();

  state.server = server;
  server.configure({
    url: state.settings.serverUrl || undefined,
    token: state.settings.serverToken || undefined,
  });
  panel.setServerConfig({
    url: state.settings.serverUrl,
    token: state.settings.serverToken,
  });
  panel.setConfigVisible(state.settings.src === "server");
  if ((state.settings.src ?? "auto") !== "local") {
    server.ping().then(ok => {
      state.serverHealthy = ok;
      if (ok && state.settings.src === "auto") panel.setStatus("server ready");
    }).catch(() => {
      state.serverHealthy = false;
    });
  }

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
      disarm("tab hidden");
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