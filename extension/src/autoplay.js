// Geometry and legality for the autoplay harness (tools/autoplay.mjs).
//
// The harness drives the board with real browser input, so it does not need to
// synthesise events. It needs exactly two things from here: where a square sits
// on screen, and whether the move it is about to make is legal in the position
// the panel just read.
//
// The second one is the whole point. A click cannot be taken back, and the gap
// between "the engine liked this move" and "the board still says that" is where
// a test harness turns into a machine that plays garbage on a live game.

import { Chess } from "chess.js";

const FILES = "abcdefgh";

/**
 * Viewport coordinates of a square's centre.
 *
 * `rect` is the board's getBoundingClientRect(). Unflipped, rank 8 is the top
 * row and the a-file is on the left; flipped, both invert.
 */
export function squareCenter(rect, flipped, sq) {
  if (!rect || !(sq >= 0 && sq < 64)) return null;
  const size = rect.width / 8;
  const file = sq % 8;
  const rank = (sq / 8) | 0;
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return {
    x: rect.left + (col + 0.5) * size,
    y: rect.top + (row + 0.5) * size,
  };
}

/** "e2e4" -> { from: 12, to: 28, promotion: null }. Null if it is not UCI. */
export function parseUci(uci) {
  if (typeof uci !== "string" || uci.length < 4 || uci.length > 5) return null;
  const file = c => (c >= "a" && c <= "h" ? c.charCodeAt(0) - 97 : -1);
  const rank = c => (c >= "1" && c <= "8" ? c.charCodeAt(0) - 49 : -1);
  const ff = file(uci[0]);
  const fr = rank(uci[1]);
  const tf = file(uci[2]);
  const tr = rank(uci[3]);
  if (ff < 0 || fr < 0 || tf < 0 || tr < 0) return null;
  if (uci.length === 5 && !"qrbn".includes(uci[4])) return null;
  return { from: fr * 8 + ff, to: tr * 8 + tf, promotion: uci[4] || null };
}

/** Board index -> "e2". */
export function squareName(sq) {
  return `${FILES[sq % 8]}${((sq / 8) | 0) + 1}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Drag a piece from one square to another with real browser input.
 *
 * `page` is a puppeteer page. Drag is the default because it is the gesture
 * this repo has already verified against the live site: a pointer down on the
 * source, a couple of intermediate moves so the board sees a real drag, and up
 * on the target. Click-move-click is available too, but it depends on the
 * site's click-to-move preference.
 */
export async function dragMove(page, rect, flipped, from, to, { steps = 8, settle = 60 } = {}) {
  const a = squareCenter(rect, flipped, from);
  const b = squareCenter(rect, flipped, to);
  if (!a || !b) return false;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps });
  await sleep(settle);
  await page.mouse.up();
  return true;
}

/** Click the source square, then the target square. */
export async function clickMove(page, rect, flipped, from, to, { gap = 90 } = {}) {
  const a = squareCenter(rect, flipped, from);
  const b = squareCenter(rect, flipped, to);
  if (!a || !b) return false;
  await page.mouse.click(a.x, a.y);
  await sleep(gap);
  await page.mouse.click(b.x, b.y);
  return true;
}

// --- in-page dispatch -------------------------------------------------------
// The content script has no CDP, so it dispatches the events a real click
// produces. Verified against the live board: chess.com listens for pointerdown
// on wc-chess-board and lets it bubble up from whatever is on top of the square.

function fire(el, type, x, y, buttons, Ctor) {
  el.dispatchEvent(
    new Ctor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: type.endsWith("move") ? -1 : 0,
      buttons,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
}

/** The element a real click at this point would hit; the board if nothing is. */
function targetAt(doc, boardEl, x, y) {
  return doc.elementFromPoint(x, y) ?? boardEl;
}

/** One click: move into place, press, release, click. */
export function clickSquare(doc, boardEl, x, y) {
  const el = targetAt(doc, boardEl, x, y);
  if (!el) return false;
  fire(el, "pointermove", x, y, 0, PointerEvent);
  fire(el, "mousemove", x, y, 0, MouseEvent);
  fire(el, "pointerdown", x, y, 1, PointerEvent);
  fire(el, "mousedown", x, y, 1, MouseEvent);
  fire(el, "pointerup", x, y, 0, PointerEvent);
  fire(el, "mouseup", x, y, 0, MouseEvent);
  fire(el, "click", x, y, 0, MouseEvent);
  return true;
}

// --- the way a hand does it -------------------------------------------------
// A person does not teleport onto the exact centre of a square twice in a row.
// The pointer travels, lands somewhere inside the square, sometimes drags
// instead of clicking, and takes a different amount of time every move.

/** A point inside the square, off-centre by a little. Never leaves the square. */
export function jitterPoint(rect, flipped, sq, rng = Math.random) {
  const c = squareCenter(rect, flipped, sq);
  if (!c) return null;
  const j = (rect.width / 8) * 0.22;
  return { x: c.x + (rng() * 2 - 1) * j, y: c.y + (rng() * 2 - 1) * j };
}

// Where the pointer was left last move, so travel starts from somewhere real.
let cursor = null;

function moveEvent(doc, boardEl, x, y, buttons) {
  const el = targetAt(doc, boardEl, x, y);
  if (!el) return;
  fire(el, "pointermove", x, y, buttons, PointerEvent);
  fire(el, "mousemove", x, y, buttons, MouseEvent);
}

/** Travel to a point in uneven steps along a slight arc. */
export async function hoverTo(doc, boardEl, to, { rng = Math.random, steps = 5 } = {}) {
  const from = cursor ?? { x: to.x + (rng() * 2 - 1) * 70, y: to.y + 70 + rng() * 70 };
  const bow = (rng() * 2 - 1) * 16;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    moveEvent(
      doc,
      boardEl,
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t + Math.sin(Math.PI * t) * bow,
      0,
    );
    await sleep(10 + rng() * 22);
  }
  cursor = to;
}

function pressAt(doc, boardEl, p) {
  const el = targetAt(doc, boardEl, p.x, p.y);
  if (!el) return false;
  fire(el, "pointerdown", p.x, p.y, 1, PointerEvent);
  fire(el, "mousedown", p.x, p.y, 1, MouseEvent);
  return true;
}

function releaseAt(doc, boardEl, p) {
  const el = targetAt(doc, boardEl, p.x, p.y);
  if (!el) return false;
  fire(el, "pointerup", p.x, p.y, 0, PointerEvent);
  fire(el, "mouseup", p.x, p.y, 0, MouseEvent);
  cursor = p;
  return true;
}

/** Press, release, click — without the travel, which hoverTo already did. */
function tapAt(doc, boardEl, p) {
  const el = targetAt(doc, boardEl, p.x, p.y);
  if (!el) return false;
  fire(el, "pointerdown", p.x, p.y, 1, PointerEvent);
  fire(el, "mousedown", p.x, p.y, 1, MouseEvent);
  fire(el, "pointerup", p.x, p.y, 0, PointerEvent);
  fire(el, "mouseup", p.x, p.y, 0, MouseEvent);
  fire(el, "click", p.x, p.y, 0, MouseEvent);
  cursor = p;
  return true;
}

/**
 * Play a move the way a person would: travel, land off-centre, click or drag,
 * with a pause between the two clicks. `mv` comes from legalMove, so the caller
 * has already proved it applies to the position that was read.
 */
export async function playMoveHuman(doc, boardEl, rect, flipped, mv, { mode = "click", rng = Math.random, abort = () => false } = {}) {
  const a = jitterPoint(rect, flipped, mv.from, rng);
  const b = jitterPoint(rect, flipped, mv.to, rng);
  if (!a || !b || !boardEl) return false;

  await hoverTo(doc, boardEl, a, { rng });
  // The board can move under us mid-gesture. Never land a piece on a position
  // that is no longer the one this move was proved against.
  if (abort()) return false;
  if (mode === "drag") {
    if (!pressAt(doc, boardEl, a)) return false;
    const steps = 6 + Math.floor(rng() * 5);
    const bow = (rng() * 2 - 1) * 7;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      moveEvent(
        doc,
        boardEl,
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t + Math.sin(Math.PI * t) * bow,
        1,
      );
      await sleep(12 + rng() * 26);
    }
    await sleep(30 + rng() * 70);
    if (abort()) {
      releaseAt(doc, boardEl, a);
      return false;
    }
    return releaseAt(doc, boardEl, b);
  }

  if (!tapAt(doc, boardEl, a)) return false;
  await sleep(110 + rng() * 260);
  await hoverTo(doc, boardEl, b, { rng, steps: 4 });
  if (abort()) return false;
  return tapAt(doc, boardEl, b);
}

/**
 * chess.com answers a promotion with a picker over the target square: a
 * `.promotion-window` holding `.promotion-piece.wq` / `.bq` and the rest. The
 * colour is part of the class, so "wq" is the queen, not "q". Returns its
 * centre, or null when no picker is up.
 */
export function queenPicker(doc) {
  for (const el of doc.querySelectorAll("[class*='promotion']")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!/(^|\s)[wb]q(\s|$)|queen/.test(cls)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** Click the queen in the promotion picker. False when there is no picker. */
export function promoteQueen(doc, boardEl) {
  const pick = queenPicker(doc);
  if (!pick) return false;
  return clickSquare(doc, boardEl, pick.x, pick.y);
}

/**
 * The move, but only if it is legal in `fen`.
 *
 * Returns null for a move that does not apply to the position: wrong side to
 * move, illegal geometry, a promotion without a piece, a FEN that will not
 * parse. The caller must refuse to click on null.
 */
export function legalMove(fen, uci) {
  const mv = parseUci(uci);
  if (!mv) return null;
  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  try {
    const applied = chess.move({
      from: squareName(mv.from),
      to: squareName(mv.to),
      promotion: mv.promotion || undefined,
    });
    if (!applied) return null;
    return { ...mv, san: applied.san, color: applied.color };
  } catch {
    return null;
  }
}
