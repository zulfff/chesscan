// End-to-end check: real Chromium, the real extension, real Stockfish WASM.
// Fixtures reproduce the DOM chess.com renders, so board reading, turn
// inference, the engine loop and the panel are all exercised without an account.

import puppeteer from "puppeteer-core";
import http from "node:http";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Chess } from "chess.js";

import { toFen, inferCastling, updateCastling, plausible, opponentInCheck, successorOf, reachableIn } from "../src/fen.js";
import { turnFromDiff, turnFromLastMove, enPassantFromDiff } from "../src/turn.js";
import { squareFromTransform } from "../src/boards/chesscom.js";
import { Humanizer, Form, SKILL, cpCeiling, thinkTime } from "../src/humanize.js";
import { chesscomHtml, fenPieces, FIXTURE_JS, START, AFTER_E4, AFTER_E4_E5_NF3, CASTLED, squareIndex } from "./fixtures.mjs";
import { squareCenter, parseUci, legalMove, dragMove, squareName, queenPicker, jitterPoint } from "../src/autoplay.js";

const root = dirname(fileURLToPath(import.meta.url));
const extRoot = join(root, "..");
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";
const PORT = 8123;

const AFTER_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR";

// --- unit checks on the pure modules ----------------------------------------

function unitChecks() {
  const start = new Array(64).fill(null);
  for (const p of fenPieces(START)) start[p.rank * 8 + p.file] = { color: p.color, type: p.type };
  assert.equal(toFen(start, "w"), `${START} w KQkq - 0 1`);
  assert.equal(inferCastling(start), "KQkq");
  assert.ok(plausible(start));

  // Material and king adjacency: chess.js does not check these, so a transient
  // DOM state could otherwise be analysed as a position that cannot exist.
  const ninePawns = new Array(64).fill(null);
  for (let f = 0; f < 8; f++) ninePawns[8 + f] = { color: "w", type: "p" };
  ninePawns[16] = { color: "w", type: "p" };
  ninePawns[4] = { color: "w", type: "k" };
  ninePawns[60] = { color: "b", type: "k" };
  assert.ok(!plausible(ninePawns), "nine pawns must be rejected");

  const adjacent = new Array(64).fill(null);
  adjacent[4] = { color: "w", type: "k" };
  adjacent[5] = { color: "b", type: "k" };
  assert.ok(!plausible(adjacent), "adjacent kings must be rejected");

  const tooMany = new Array(64).fill(null);
  for (let i = 0; i < 16; i++) tooMany[i] = { color: "w", type: "q" };
  tooMany[4] = { color: "w", type: "k" };
  tooMany[20] = { color: "w", type: "p" };
  tooMany[60] = { color: "b", type: "k" };
  assert.ok(!plausible(tooMany), "seventeen white pieces must be rejected");

  // A promoted piece costs a pawn. A duplicate piece keeps every pawn, which no
  // game can reach — that is a piece drawn twice during an animation, not a
  // position. chess.js accepts it, so the count has to be checked here.
  const threeKnights = new Array(64).fill(null);
  threeKnights[4] = { color: "w", type: "k" };
  threeKnights[60] = { color: "b", type: "k" };
  threeKnights[1] = { color: "w", type: "n" };
  threeKnights[6] = { color: "w", type: "n" };
  threeKnights[18] = { color: "w", type: "n" };
  for (let f = 0; f < 8; f++) threeKnights[8 + f] = { color: "w", type: "p" };
  assert.ok(!plausible(threeKnights), "a third knight beside eight pawns must be rejected");
  threeKnights[8] = null; // one pawn paid for the promotion
  assert.ok(plausible(threeKnights), "a third knight with seven pawns is reachable");

  // A legal position never has the side that just moved still in check. This is
  // the check chess.js does not perform, and it catches a stitched snapshot.
  assert.equal(opponentInCheck(`${START} w KQkq - 0 1`), false);
  assert.equal(opponentInCheck(`${AFTER_E4} b KQkq e3 0 1`), false);
  assert.equal(
    opponentInCheck("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1"),
    true,
    "non-mover in check must be refused",
  );
  assert.equal(
    opponentInCheck("4k3/8/8/8/8/8/4R3/4K3 b - - 0 1"),
    false,
    "a check against the side to move is legal",
  );

  const after = start.slice();
  after[12] = null;
  after[28] = { color: "w", type: "p" };
  assert.equal(turnFromDiff(start, after), "b");
  assert.equal(turnFromLastMove(after, [12, 28]), "b");

  // En passant target from a double push, both colours.
  assert.equal(enPassantFromDiff(start, after), 20); // e3
  const afterE5 = after.slice();
  afterE5[52] = null; // e7
  afterE5[36] = { color: "b", type: "p" }; // e5
  assert.equal(enPassantFromDiff(after, afterE5), 44); // e6
  assert.equal(enPassantFromDiff(after, after), null);

  // Castling rights survive only until the king or rook actually moves.
  const kingMoved = start.slice();
  kingMoved[4] = null;
  kingMoved[12] = { color: "w", type: "k" };
  assert.equal(updateCastling("KQkq", start, kingMoved), "kq");
  assert.equal(updateCastling("KQkq", start, start), "KQkq");

  const rookMoved = start.slice();
  rookMoved[0] = null;
  rookMoved[8] = { color: "w", type: "r" };
  assert.equal(updateCastling("KQkq", start, rookMoved), "Kkq");

  const rookCaptured = start.slice();
  rookCaptured[7] = { color: "b", type: "r" };
  assert.equal(updateCastling("KQkq", start, rookCaptured), "Qkq");

  // A king that walks back home does not get its rights back.
  assert.equal(updateCastling("kq", kingMoved, start), "kq");

  // FEN carries the target square, and a bad one is ignored.
  assert.equal(toFen(after, "b", { enPassant: 20 }), `${AFTER_E4} b KQkq e3 0 1`);
  assert.equal(toFen(after, "b", { enPassant: 64 }), `${AFTER_E4} b KQkq - 0 1`);

  // Board reading: percentage and pixel transforms, both orientations.
  assert.equal(squareFromTransform("translate(400%, 600%)", false, 60), 12); // e2
  assert.equal(squareFromTransform("translate(400%, 100%)", false, 60), 52); // e7
  assert.equal(squareFromTransform("translate(0%, 0%)", true, 60), 7); // h1
  assert.equal(squareFromTransform("translate(700%, 700%)", true, 60), 56); // a8
  assert.equal(squareFromTransform("translate(240px, 360px)", false, 60), 12); // e2
  assert.equal(squareFromTransform("translate(-50%, -50%)", false, 60), null);

  // A board is only a new position if exactly one legal move produces it. This
  // is what stops a frame in flight from becoming the position being analysed.
  const boardOf = placement => {
    const out = new Array(64).fill(null);
    for (const p of fenPieces(placement)) out[p.rank * 8 + p.file] = { color: p.color, type: p.type };
    return out;
  };
  assert.equal(
    successorOf(`${START} w KQkq - 0 1`, boardOf(AFTER_E4)),
    `${AFTER_E4} b KQkq e3 0 1`,
    "e4 must be explained as exactly one legal move, with its target",
  );
  assert.equal(successorOf(`${START} w KQkq - 0 1`, boardOf(START)), null, "no move produces the same board");
  assert.equal(
    successorOf(`${START} w KQkq - 0 1`, boardOf("rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR")),
    null,
    "a board with the mover still on its square is a frame, not a move",
  );
  assert.equal(successorOf(`${START} w KQkq - 0 1`, threeKnights), null, "a duplicated piece explains nothing");
  assert.equal(
    successorOf("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", boardOf("r3k2r/8/8/8/8/8/8/R4RK1")),
    "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1",
    "castling carries the rook and drops both rights",
  );
  assert.equal(
    successorOf("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2", boardOf("rnbqkbnr/ppp1pppp/3P4/8/8/8/PPPP1PPP/RNBQKBNR")),
    "rnbqkbnr/ppp1pppp/3P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
    "en passant is explained from the target, not guessed from placement",
  );

  // Two plies are enumerated too: that is the gap a fast game leaves between
  // ticks, and the set has to contain the real position while excluding a
  // frame that is not reachable in two moves.
  const two = reachableIn(`${START} w KQkq - 0 1`, 2);
  assert.ok(two instanceof Map, "two plies must be enumerable");
  assert.equal(
    two.get(AFTER_E4_E5),
    `${AFTER_E4_E5} w KQkq e6 0 2`,
    "1.e4 e5 must be in the two-ply set with its target",
  );
  assert.equal(two.get(AFTER_E4), undefined, "one move is not a two-ply position");
  assert.equal(
    two.get("rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR"),
    undefined,
    "a duplicated pawn is not reachable in two plies",
  );
  assert.equal(reachableIn(`${START} w KQkq - 0 1`, 3), null, "three plies are not enumerated");
  assert.equal(reachableIn("not a fen", 2), null, "an invalid FEN has no reachable set");

  // A navigation jump changes too much to be a move.
  const other = fenPieces(CASTLED).reduce((acc, p) => {
    acc[p.rank * 8 + p.file] = { color: p.color, type: p.type };
    return acc;
  }, new Array(64).fill(null));
  assert.equal(turnFromDiff(start, other), null);

  const noKings = start.slice();
  noKings[4] = null;
  assert.ok(!plausible(noKings));

  // Autoplay geometry: the harness clicks these coordinates, so they have to be
  // the square centres in both orientations.
  const rect = { left: 100, top: 50, width: 480, height: 480 };
  assert.deepEqual(squareCenter(rect, false, 12), { x: 370, y: 440 }); // e2
  assert.deepEqual(squareCenter(rect, false, 0), { x: 130, y: 500 }); // a1
  assert.deepEqual(squareCenter(rect, true, 12), { x: 310, y: 140 }); // e2 flipped
  assert.deepEqual(squareCenter(rect, true, 63), { x: 130, y: 500 }); // h8 flipped
  assert.equal(squareCenter(rect, false, 64), null);

  assert.deepEqual(parseUci("e2e4"), { from: 12, to: 28, promotion: null });
  assert.deepEqual(parseUci("e7e8q"), { from: 52, to: 60, promotion: "q" });
  assert.equal(parseUci("e2e"), null);
  assert.equal(parseUci("z2e4"), null);
  assert.equal(parseUci("e2e4x"), null, "bogus promotion piece must be refused");
  assert.equal(squareName(12), "e2");
  assert.equal(squareName(63), "h8");

  // Legality: the last gate before a click, which cannot be undone.
  assert.equal(legalMove(`${START} w KQkq - 0 1`, "e2e4").san, "e4");
  assert.equal(legalMove(`${START} w KQkq - 0 1`, "e2e5"), null, "three-square pawn push");
  assert.equal(legalMove(`${START} b KQkq - 0 1`, "e2e4"), null, "white move on black's turn");
  assert.match(legalMove("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q").san, /^a8=Q/);
  assert.equal(legalMove("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8"), null, "promotion without a piece");
  assert.equal(legalMove("not a fen", "e2e4"), null);

  // The promotion picker, as chess.com actually renders it: the colour is part
  // of the piece class, so the queen is "wq"/"bq", never a bare "q".
  const pickerDoc = classes => ({
    querySelectorAll: () =>
      classes.map((c, i) => ({
        className: c,
        getBoundingClientRect: () => ({ left: i * 20, top: 40, width: 20, height: 20 }),
      })),
  });
  const whitePicker = ["promotion-window top", "promotion-piece wb", "promotion-piece wn", "promotion-piece wq", "promotion-piece wr"];
  const blackPicker = ["promotion-window bottom", "promotion-piece bb", "promotion-piece bn", "promotion-piece bq", "promotion-piece br"];
  assert.equal(queenPicker(pickerDoc(whitePicker)).el.className, "promotion-piece wq");
  assert.equal(queenPicker(pickerDoc(blackPicker)).el.className, "promotion-piece bq");
  assert.deepEqual(
    { x: queenPicker(pickerDoc(whitePicker)).x, y: queenPicker(pickerDoc(whitePicker)).y },
    { x: 70, y: 50 },
  );
  assert.equal(queenPicker(pickerDoc(["promotion-window top"])), null, "no queen, no click");
  const hiddenPicker = {
    querySelectorAll: () => [
      { className: "promotion-piece wq", getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) },
    ],
  };
  assert.equal(queenPicker(hiddenPicker), null, "a zero-size piece is not a picker you can click");

  // The landing point is off-centre but never outside the square it names.
  for (const flip of [false, true]) {
    for (const rng of [() => 0, () => 0.999999, Math.random]) {
      for (let sq = 0; sq < 64; sq++) {
        const p = jitterPoint(rect, flip, sq, rng);
        const c = squareCenter(rect, flip, sq);
        const half = rect.width / 16;
        assert.ok(
          Math.abs(p.x - c.x) < half && Math.abs(p.y - c.y) < half,
          `jitter left square ${sq}`,
        );
      }
    }
  }
  assert.equal(jitterPoint(rect, false, 64), null);

  console.log("unit: ok");
}

// --- browser checks ----------------------------------------------------------

async function prepareExtension() {
  const dir = join(root, ".tmp-ext");
  await rm(dir, { recursive: true, force: true });
  await cp(join(extRoot, "build", "chrome"), dir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  manifest.content_scripts[0].matches.push("http://127.0.0.1/*");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

function startServer({ csp }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/fixture.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(FIXTURE_JS);
      return;
    }
    const board = url.searchParams.get("board") || START;
    const flipped = url.searchParams.get("flip") === "1";
    const last = (url.searchParams.get("last") || "").split(",").filter(Boolean);
    const moves = (url.searchParams.get("moves") || "").split(",").filter(Boolean);
    const sel = url.searchParams.get("sel");
    const selected = sel === null || sel === "" ? null : Number(sel);
    const interactive = url.searchParams.get("interactive") === "1";
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (csp) {
      headers["content-security-policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
    }
    res.writeHead(200, headers);
    res.end(chesscomHtml(board, { flipped, last, moves, selected, interactive }));
  });
  return new Promise(resolve => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

const panelEval = fn => `(() => { const s = document.getElementById('chesscan-ext-root')?.shadowRoot; return s ? (${fn})(s) : null; })()`;

async function readPanel(page) {
  return page.evaluate(
    panelEval(`s => {
      const layer = document.getElementById('chesscan-arrow-layer');
      return {
        fen: s.getElementById('fen').textContent,
        turn: s.getElementById('turn').textContent,
        status: s.getElementById('status').textContent,
        prob: s.getElementById('prob').textContent,
        guide: s.getElementById('guide').value,
        lines: [...s.querySelectorAll('.line:not(.placeholder) .san')].map(e => e.textContent),
        scores: [...s.querySelectorAll('.line:not(.placeholder) .sc')].map(e => e.textContent),
        searching: s.getElementById('live').classList.contains('on'),
        arrow: !!layer && layer.style.display !== 'none' && !!layer.querySelector('svg'),
      };
    }`),
  );
}

async function waitFen(page, expected, timeout = 20000) {
  await page.waitForFunction(
    fen => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      return s && s.getElementById("fen").textContent === fen;
    },
    { timeout },
    expected,
  );
}

async function waitLines(page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      if (!s) return false;
      const lines = s.querySelectorAll(".line:not(.placeholder) .san");
      return lines.length >= 3 && [...lines].every(e => e.textContent.trim().length > 0) && !s.getElementById("live").classList.contains("on");
    },
    { timeout },
  );
}

async function waitArrow(page, visible, timeout = 8000) {
  await page.waitForFunction(
    want => {
      const layer = document.getElementById("chesscan-arrow-layer");
      const shown = !!layer && layer.style.display !== "none" && !!layer.querySelector("svg");
      return want ? shown : !shown;
    },
    { timeout },
    visible,
  );
}

async function setDepth(page, depth) {
  await page.evaluate(
    panelEval(`s => { const sel = s.getElementById('depth'); sel.value = '${depth}'; sel.dispatchEvent(new Event('change', { bubbles: true })); }`),
  );
}

async function setGuide(page, guide) {
  await page.evaluate(
    panelEval(`s => { const sel = s.getElementById('guide'); sel.value = '${guide}'; sel.dispatchEvent(new Event('change', { bubbles: true })); }`),
  );
}

async function setPlay(page, mode) {
  await page.evaluate(
    panelEval(`s => { const sel = s.getElementById('play'); sel.value = '${mode}'; sel.dispatchEvent(new Event('change', { bubbles: true })); }`),
  );
}

async function setPv(page, n) {
  await page.evaluate(
    panelEval(`s => { const sel = s.getElementById('pv'); sel.value = '${n}'; sel.dispatchEvent(new Event('change', { bubbles: true })); }`),
  );
}

async function waitArrowCount(page, n, timeout = 8000) {
  await page.waitForFunction(
    want => {
      const layer = document.getElementById("chesscan-arrow-layer");
      const drawn = layer ? layer.querySelectorAll("line").length : 0;
      return layer?.style.display !== "none" && drawn === want;
    },
    { timeout },
    n,
  );
}

async function waitChosen(page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      if (!s) return false;
      return (
        s.querySelectorAll(".line.chosen").length === 1 &&
        !s.getElementById("live").classList.contains("on")
      );
    },
    { timeout },
  );
}

async function applyMove(page, fromXY, toXY) {
  await page.evaluate(([from, to]) => {
    const el = document.querySelector(`wc-chess-board .piece.square-${from}`);
    if (!el) throw new Error(`no piece on square-${from}`);
    el.classList.remove(`square-${from}`);
    el.classList.add(`square-${to}`);
  }, [fromXY, toXY]);
}

async function runBrowserChecks({ csp }) {
  const extDir = await prepareExtension();
  const server = await startServer({ csp });
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const label = csp ? "strict-csp" : "open";
  try {
    const page = await browser.newPage();
    page.on("pageerror", err => console.log(`[${label}] page error:`, err.message));

    // 1. start position
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    await waitFen(page, `${START} w KQkq - 0 1`);
    await setDepth(page, 12);
    await waitLines(page);
    let p = await readPanel(page);
    assert.equal(p.turn, "w");
    assert.equal(p.lines.length, 3);
    assert.match(p.scores[0], /^[+#-]/);
    assert.equal(p.guide, "auto");
    assert.ok(p.arrow, "best-move arrow should be drawn");
    assert.equal(p.status, "");
    console.log(`[${label}] start: ok (${p.lines[0]} ${p.scores[0]} ${p.prob})`);
    await page.screenshot({ path: join(root, `screenshot-${label}.png`) });

    // 1b. arrow chain: the suggestion plus the reply it invites
    await waitArrowCount(page, 2);
    await setPv(page, 3);
    await waitArrowCount(page, 3);
    await setPv(page, 1);
    await waitArrowCount(page, 1);
    await setPv(page, 2);
    await waitArrowCount(page, 2);
    assert.equal(await page.evaluate(panelEval(`s => s.getElementById('pv').value`)), "2");
    console.log(`[${label}] arrow chain: ok`);

    // 2. guide selector: only the bottom side gets the arrow in auto mode
    await setGuide(page, "black");
    await waitArrow(page, false);
    await setGuide(page, "auto");
    await waitArrow(page, true);
    console.log(`[${label}] guide gating: ok`);

    // 2b. human-like play mode: four candidates, exactly one highlighted pick
    await setPlay(page, "club");
    await waitChosen(page);
    const hp = await page.evaluate(
      panelEval(`s => ({
        lines: s.querySelectorAll(".line:not(.placeholder)").length,
        chosen: s.querySelectorAll(".line.chosen").length,
        why: s.getElementById("why").textContent,
        mode: s.getElementById("play").value,
      })`),
    );
    assert.equal(hp.mode, "club");
    assert.equal(hp.lines, 4, "play mode should widen the search to four candidates");
    assert.equal(hp.chosen, 1);
    assert.match(hp.why, /^(natural|slip|find|forced)$/);
    await waitArrow(page, true);
    console.log(`[${label}] play mode: ok (${hp.why})`);

    await setPlay(page, "off");
    await waitLines(page);
    const off = await page.evaluate(
      panelEval(`s => ({ lines: s.querySelectorAll(".line:not(.placeholder)").length, chosen: s.querySelectorAll(".line.chosen").length })`),
    );
    assert.equal(off.chosen, 0, "play off must go back to the plain engine best");
    assert.equal(off.lines, 3);
    console.log(`[${label}] play off: ok`);

    // 2c. max: full engine strength — one line, no human pick
    await setPlay(page, "max");
    await page.waitForFunction(
      () => {
        const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
        if (!s) return false;
        return (
          s.querySelectorAll(".line:not(.placeholder)").length === 1 &&
          s.getElementById("why").textContent === "max"
        );
      },
      { timeout: 60000 },
    );
    const maxp = await page.evaluate(
      panelEval(`s => ({ chosen: s.querySelectorAll(".line.chosen").length, lines: s.querySelectorAll(".line:not(.placeholder)").length })`),
    );
    assert.equal(maxp.lines, 1);
    assert.equal(maxp.chosen, 0, "max must not pretend the move was chosen by a person");
    await waitArrow(page, true);
    console.log(`[${label}] max: ok`);

    // 2d. solid: strong and consistent, but still an actual choice
    await setPlay(page, "solid");
    await waitChosen(page);
    const sol = await page.evaluate(
      panelEval(`s => ({ lines: s.querySelectorAll(".line:not(.placeholder)").length, why: s.getElementById("why").textContent })`),
    );
    assert.equal(sol.lines, 4);
    assert.notEqual(sol.why, "slip", "solid has mistakes disabled");
    console.log(`[${label}] solid: ok (${sol.why})`);

    // 2e. auto: a live form, shown with the pick
    await setPlay(page, "auto");
    await waitChosen(page);
    const autop = await page.evaluate(
      panelEval(`s => ({ lines: s.querySelectorAll(".line:not(.placeholder)").length, why: s.getElementById("why").textContent })`),
    );
    assert.equal(autop.lines, 4);
    assert.match(autop.why, /^(natural|slip|find|forced) \d{3,4}$/);
    console.log(`[${label}] auto: ok (${autop.why})`);

    await setPlay(page, "off");
    await waitLines(page);

    // 3. a move happens in the DOM -> turn flips without any site API
    await applyMove(page, "52", "54");
    await waitFen(page, `${AFTER_E4} b KQkq e3 0 1`);
    await waitLines(page);
    p = await readPanel(page);
    assert.equal(p.turn, "b");
    console.log(`[${label}] move detection: ok (${p.lines[0]} ${p.scores[0]})`);

    // 4. manual flip overrides the side to move. The en passant target is
    // illegal for the flipped side, so the panel drops it; flipping back
    // restores it because the tracked target never left the state.
    await page.evaluate(panelEval(`s => s.getElementById('flip').click()`));
    await waitFen(page, `${AFTER_E4} w KQkq - 0 1`);
    console.log(`[${label}] manual flip: ok`);
    await page.evaluate(panelEval(`s => s.getElementById('flip').click()`));
    await waitFen(page, `${AFTER_E4} b KQkq e3 0 1`);

    // 5. two quick moves while a search is running: the stale bestmove must not
    //    finalize the new job with no lines.
    await applyMove(page, "57", "55"); // ...e5
    await new Promise(r => setTimeout(r, 350));
    await applyMove(page, "71", "63"); // Nf3
    await waitFen(page, `${AFTER_E5_NF3} b KQkq - 0 1`);
    await waitLines(page);
    p = await readPanel(page);
    assert.ok(p.lines.length >= 3, "lines must survive a stopped search");
    assert.equal(p.turn, "b");
    console.log(`[${label}] rapid moves: ok (${p.lines[0]})`);

    // 6. flipped board: auto guides the bottom side, so no arrow on white's turn
    await page.goto(
      `http://127.0.0.1:${PORT}/?board=${encodeURIComponent(CASTLED)}&flip=1&last=g8f6`,
      { waitUntil: "load" },
    );
    await waitFen(page, `${CASTLED} w - - 0 1`);
    await waitLines(page);
    p = await readPanel(page);
    assert.equal(p.turn, "w");
    assert.equal(p.arrow, false, "auto must not guide the opponent");
    await setGuide(page, "both");
    await waitArrow(page, true);
    console.log(`[${label}] flipped + guide: ok (${p.lines[0]})`);
    await setGuide(page, "auto");

    // 7. close -> pill, reopen -> panel
    await page.evaluate(panelEval(`s => s.getElementById('close').click()`));
    await page.waitForFunction(() => {
      const s = document.getElementById("chesscan-ext-root").shadowRoot;
      return s.querySelector(".panel").hidden && !s.getElementById("pill").hidden;
    });
    await page.evaluate(panelEval(`s => s.getElementById('pill').click()`));
    await waitLines(page);
    console.log(`[${label}] close/reopen: ok`);

    // 8. move list: the side to move and the move number are read from
    //    wc-move-list instead of inferred from the pieces.
    const listPage = await browser.newPage();
    await listPage.goto(
      `http://127.0.0.1:${PORT}/?board=${encodeURIComponent(AFTER_E4_E5_NF3)}&moves=e4,e5,Nf3&sel=2`,
      { waitUntil: "load" },
    );
    await waitFen(listPage, `${AFTER_E4_E5_NF3} b KQkq - 0 2`);
    await setDepth(listPage, 12);
    await setGuide(listPage, "both");
    await waitLines(listPage);
    console.log(`[${label}] move list: ok (side to move read, fullmove 2)`);

    // 9. clicking a PV pins the arrows to that line; clicking it again unpins.
    const picked = await listPage.evaluate(
      panelEval(`s => {
        const rows = [...s.querySelectorAll('.line[data-uci]')];
        if (rows.length < 2) return null;
        const uci = rows[1].dataset.uci;
        rows[1].click();
        return { uci, pinned: s.querySelector('.line.pinned')?.dataset.uci ?? null };
      }`),
    );
    assert.ok(picked, "need at least two PV rows with a first move");
    assert.equal(picked.pinned, picked.uci, "clicking a line must pin that line");
    const arrows = await listPage.evaluate(() => {
      const board = document.querySelector("wc-chess-board");
      const size = board.getBoundingClientRect().width / 8;
      const lines = [...document.querySelectorAll("#chesscan-arrow-layer svg line")];
      return { size, first: lines.length ? ["x1", "y1", "x2", "y2"].map(a => Number(lines[0].getAttribute(a))) : null };
    });
    assert.ok(arrows.first, "the pinned line must draw an arrow");
    const want = (() => {
      const sq = u => (Number(u[1]) - 1) * 8 + "abcdefgh".indexOf(u[0]);
      const c = s => [((s % 8) + 0.5) * arrows.size, (7 - ((s / 8) | 0) + 0.5) * arrows.size];
      const [x1, y1] = c(sq(picked.uci.slice(0, 2)));
      const [x2, y2] = c(sq(picked.uci.slice(2, 4)));
      const len = Math.hypot(x2 - x1, y2 - y1);
      return [(x2 - x1) / len, (y2 - y1) / len];
    })();
    const [x1, y1, x2, y2] = arrows.first;
    const alen = Math.hypot(x2 - x1, y2 - y1);
    assert.ok(
      Math.abs((x2 - x1) / alen - want[0]) < 0.01 &&
        Math.abs((y2 - y1) / alen - want[1]) < 0.01,
      "the first arrow must point along the pinned move",
    );
    await listPage.evaluate(panelEval(`s => s.querySelector('.line.pinned')?.click()`));
    const unpinned = await listPage.evaluate(panelEval(`s => s.querySelectorAll('.line.pinned').length`));
    assert.equal(unpinned, 0, "clicking the pinned line must unpin it");
    console.log(`[${label}] pinned line: ok`);

    // 10. moving the selected node changes the side to move and the move number
    //     without touching a single piece.
    await listPage.evaluate(() => {
      const nodes = [...document.querySelectorAll("wc-move-list .node")];
      for (const el of document.querySelectorAll("wc-move-list .selected")) {
        el.classList.remove("selected");
      }
      nodes[1].querySelector(".node-highlight-content").classList.add("selected");
    });
    await waitFen(listPage, `${AFTER_E4_E5_NF3} w KQkq - 0 2`);
    console.log(`[${label}] move list turn: ok`);
    await listPage.close();

    // 11. fast controls. The move list and the pieces are updated by separate
    //     code paths on the page, so in a bullet game one is routinely a frame
    //     ahead of the other. A changed board is only a new position if exactly
    //     one legal move explains it; anything else has to be held, never
    //     guessed. These are the four races that produced wrong FENs.
    const cls = sq => `square-${(sq % 8) + 1}${((sq / 8) | 0) + 1}`;
    // Apply one or more moves to the fixture board in a single mutation batch,
    // the way a page that skipped a tick leaves the DOM.
    const domMoves = (page, pairs, { duplicate = false } = {}) =>
      page.evaluate(
        ({ pairs, duplicate }) => {
          const board = document.querySelector("wc-chess-board");
          const cls = sq => `square-${(sq % 8) + 1}${((sq / 8) | 0) + 1}`;
          for (const [from, to] of pairs) {
            const piece = board.querySelector(`.piece.${cls(from)}`);
            if (!piece) throw new Error(`no piece on ${from}`);
            if (duplicate) {
              // A frame in flight draws the piece twice: keep the original and
              // add a copy on the destination.
              const copy = piece.cloneNode(true);
              copy.classList.remove(cls(from));
              copy.classList.add(cls(to));
              board.appendChild(copy);
              continue;
            }
            board.querySelector(`.piece.${cls(to)}`)?.remove();
            piece.classList.remove(cls(from));
            piece.classList.add(cls(to));
          }
          if (duplicate) return;
          for (const e of board.querySelectorAll(".highlight")) e.classList.remove("highlight");
          for (const sq of pairs[pairs.length - 1]) {
            const d = document.createElement("div");
            d.className = `highlight ${cls(sq)}`;
            board.appendChild(d);
          }
        },
        { pairs, duplicate },
      );
    const domMove = (page, from, to, opts) => domMoves(page, [[from, to]], opts);
    const addNode = (page, san, index) =>
      page.evaluate(
        ({ san, index }) => {
          const list = document.querySelector("wc-move-list");
          const div = document.createElement("div");
          div.setAttribute("data-node", `0-${index}`);
          div.className = `node ${index % 2 === 0 ? "white" : "black"}-move main-line-ply`;
          div.innerHTML = `<span class="node-highlight-content">${san}</span>`;
          list.appendChild(div);
        },
        { san, index },
      );
    const fenStays = async (page, expected, ms = 700) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const p = await readPanel(page);
        assert.equal(p.fen, expected, "an unexplained board must not become the position");
        await new Promise(r => setTimeout(r, 60));
      }
    };

    // 11a. board ahead of the list: the pieces moved, the list has not. The
    //      board is one legal move from the last position, so it is adopted at
    //      once, with the en passant target the move really creates.
    const fastPage = await browser.newPage();
    await fastPage.goto(`http://127.0.0.1:${PORT}/?board=${encodeURIComponent(START)}`, {
      waitUntil: "load",
    });
    await waitFen(fastPage, `${START} w KQkq - 0 1`);
    await domMove(fastPage, squareIndex("e2"), squareIndex("e4"));
    await waitFen(fastPage, `${AFTER_E4} b KQkq e3 0 1`);
    console.log(`[${label}] board ahead of list: ok`);

    // 11b. list ahead of the board: the same pieces, a list that has moved on.
    //      Nothing may be re-read from the stale board, and the turn must not
    //      flip until the pieces do.
    await fastPage.goto(
      `http://127.0.0.1:${PORT}/?board=${encodeURIComponent(AFTER_E4)}&moves=e4`,
      { waitUntil: "load" },
    );
    await waitFen(fastPage, `${AFTER_E4} b KQkq - 0 1`);
    await addNode(fastPage, "e5", 1);
    await fenStays(fastPage, `${AFTER_E4} b KQkq - 0 1`);
    await domMove(fastPage, squareIndex("e7"), squareIndex("e5"));
    await waitFen(fastPage, `${AFTER_E4_E5} w KQkq e6 0 2`);
    console.log(`[${label}] list ahead of board: ok`);

    // 11c. a piece drawn on two squares mid-animation. It is not a legal move,
    //      and no amount of waiting makes it one, so the panel keeps the last
    //      good position until the animation finishes.
    const dupBoard = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR";
    const dupAfter = "r1bqkbnr/ppp1pppp/2n5/3P4/8/8/PPPP1PPP/RNBQKBNR";
    await fastPage.goto(
      `http://127.0.0.1:${PORT}/?board=${encodeURIComponent(dupBoard)}&last=c4,d5`,
      { waitUntil: "load" },
    );
    await waitFen(fastPage, `${dupBoard} b KQkq - 0 1`);
    await domMove(fastPage, squareIndex("b8"), squareIndex("c6"), { duplicate: true });
    await fenStays(fastPage, `${dupBoard} b KQkq - 0 1`, 900);
    await fastPage.evaluate(sq => {
      document.querySelector(`.piece.${sq}`)?.remove();
    }, cls(squareIndex("b8")));
    await waitFen(fastPage, `${dupAfter} w KQkq - 0 1`);
    console.log(`[${label}] mid-animation duplicate: ok`);

    // 11d. two moves between ticks. No single move explains the board, so it
    //      has to hold until it has been read twice, then land on the position
    //      the move list states — not on a half-applied one.
    await fastPage.goto(
      `http://127.0.0.1:${PORT}/?board=${encodeURIComponent(AFTER_E4)}&moves=e4`,
      { waitUntil: "load" },
    );
    await waitFen(fastPage, `${AFTER_E4} b KQkq - 0 1`);
    await addNode(fastPage, "e5", 1);
    await addNode(fastPage, "Nf3", 2);
    await domMoves(fastPage, [
      [squareIndex("e7"), squareIndex("e5")],
      [squareIndex("g1"), squareIndex("f3")],
    ]);
    await waitFen(fastPage, `${AFTER_E4_E5_NF3} b KQkq - 0 2`);
    console.log(`[${label}] two moves in one tick: ok`);
    await fastPage.close();


    // 12. autoplay geometry: the coordinates the harness computes have to land
    //     on the squares it meant, under real browser input. Synthetic events
    //     can be swallowed by pointer capture; page.mouse goes through CDP.
    const autoPage = await browser.newPage();
    await autoPage.goto(`http://127.0.0.1:${PORT}/?interactive=1`, { waitUntil: "load" });
    await waitFen(autoPage, `${START} w KQkq - 0 1`);
    await waitLines(autoPage);
    const geo = await autoPage.evaluate(() => {
      const b = document.querySelector("wc-chess-board");
      const r = b.getBoundingClientRect();
      return {
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        flipped: b.classList.contains("flipped"),
      };
    });
    const e2 = squareCenter(geo.rect, geo.flipped, 12);
    const e4 = squareCenter(geo.rect, geo.flipped, 28);

    // Selecting a piece marks one square; a last move marks two. Reading a
    // selection as a move invents a side-to-move change out of nothing.
    const a1 = squareCenter(geo.rect, geo.flipped, 0);
    await autoPage.mouse.click(a1.x, a1.y);
    await new Promise(r => setTimeout(r, 1400));
    const selected = await autoPage.evaluate(() => ({
      marks: document.querySelectorAll("wc-chess-board .highlight").length,
      fen: document.getElementById("chesscan-ext-root").shadowRoot.getElementById("fen").textContent,
    }));
    assert.equal(selected.marks, 1, "selecting a piece marks exactly one square");
    assert.equal(
      selected.fen,
      `${START} w KQkq - 0 1`,
      "a selection must not rewrite the position",
    );
    await autoPage.mouse.click(a1.x, a1.y); // deselect
    await new Promise(r => setTimeout(r, 400));

    await autoPage.mouse.click(e2.x, e2.y);
    await autoPage.mouse.click(e4.x, e4.y);
    await autoPage.waitForFunction(() => window.__applied?.length === 1, { timeout: 5000 });
    const applied = await autoPage.evaluate(() => window.__applied[0]);
    assert.deepEqual(
      applied,
      { from: { file: 4, rank: 1 }, to: { file: 4, rank: 3 } },
      "the clicks must land on e2 then e4",
    );
    await waitFen(autoPage, `${AFTER_E4} b KQkq e3 0 1`);

    // The same geometry has to work for a drag, which is the gesture the live
    // board is actually driven with.
    await dragMove(autoPage, geo.rect, geo.flipped, 11, 27); // d2-d4
    await autoPage.waitForFunction(() => window.__applied?.length === 2, { timeout: 5000 });
    const dragged = await autoPage.evaluate(() => window.__applied[1]);
    assert.deepEqual(
      dragged,
      { from: { file: 3, rank: 1 }, to: { file: 3, rank: 3 } },
      "the drag must start on d2 and end on d4",
    );
    console.log(`[${label}] autoplay geometry: ok`);

    // guide "both" plays every move, so it is refused anywhere but analysis.
    await setGuide(autoPage, "both");
    await autoPage.evaluate(panelEval(`s => s.getElementById('auto').click()`));
    const bothRefused = await autoPage.evaluate(
      panelEval(`s => ({ on: s.getElementById('auto').getAttribute('aria-pressed'), note: s.getElementById('autoinfo').textContent })`),
    );
    assert.equal(bothRefused.on, "false", "guide both must not arm outside analysis");
    assert.match(bothRefused.note, /analysis only/);
    await autoPage.close();

    // 13. the autoplay menu: it plays the move the panel is showing, disarming
    //     stops it, guide off refuses to arm, and a reload never inherits it.
    const menuPage = await browser.newPage();
    await menuPage.goto(`http://127.0.0.1:${PORT}/analysis?interactive=1`, { waitUntil: "load" });
    await waitFen(menuPage, `${START} w KQkq - 0 1`);
    await waitLines(menuPage);
    const autoState = () =>
      menuPage.evaluate(
        panelEval(`s => ({ on: s.getElementById('auto').getAttribute('aria-pressed'), note: s.getElementById('autoinfo').textContent })`),
      );

    await setGuide(menuPage, "off");
    await menuPage.evaluate(panelEval(`s => s.getElementById('auto').click()`));
    let auto = await autoState();
    assert.equal(auto.on, "false", "guide off must refuse to arm");
    assert.match(auto.note, /guide is off/);

    // Both sides, so it keeps playing and disarming is observable.
    await setGuide(menuPage, "both");
    await waitLines(menuPage);
    const playValue = () => menuPage.evaluate(panelEval(`s => s.getElementById('play').value`));
    assert.equal(await playValue(), "off");
    await menuPage.evaluate(panelEval(`s => s.getElementById('auto').click()`));
    assert.equal((await autoState()).on, "true");
    assert.equal(
      await playValue(),
      "auto",
      "arming with no play profile must borrow a human one",
    );
    // The pause is a real think time now (log-normal, up to ~22s), not a fixed
    // delay, so the budget has to cover the tail plus the search.
    await menuPage.waitForFunction(() => window.__applied?.length >= 1, { timeout: 60000 });
    const first = await menuPage.evaluate(() => window.__applied[0]);
    const name = c => "abcdefgh"[c.file] + (c.rank + 1);
    const uci = name(first.from) + name(first.to);
    assert.ok(
      legalMove(`${START} w KQkq - 0 1`, uci),
      `autoplay played an illegal move: ${uci}`,
    );
    const why = await menuPage.evaluate(panelEval(`s => s.getElementById('why').textContent`));
    assert.match(why, /^(natural|slip|find|forced)/, "the pick must come from the humanizer");
    const replay = new Chess(`${START} w KQkq - 0 1`);
    replay.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    const wantFen = replay.fen().split(" ").slice(0, 2).join(" ");
    await menuPage.waitForFunction(
      w => {
        const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
        return s && s.getElementById("fen").textContent.split(" ").slice(0, 2).join(" ") === w;
      },
      { timeout: 10000 },
      wantFen,
    );

    await menuPage.waitForFunction(() => window.__applied?.length >= 2, { timeout: 60000 });
    await menuPage.evaluate(panelEval(`s => s.getElementById('auto').click()`));
    const stopped = await menuPage.evaluate(() => window.__applied.length);
    await new Promise(r => setTimeout(r, 4000));
    assert.equal(
      await menuPage.evaluate(() => window.__applied.length),
      stopped,
      "disarming must stop the moves",
    );
    assert.equal((await autoState()).on, "false");
    assert.equal(await playValue(), "off", "disarming must give the play mode back");

    await menuPage.reload({ waitUntil: "load" });
    await waitFen(menuPage, `${START} w KQkq - 0 1`);
    assert.equal(
      (await autoState()).on,
      "false",
      "a reload must never inherit an armed autoplay",
    );
    assert.equal(
      await playValue(),
      "off",
      "the borrowed play mode must never reach storage",
    );
    console.log(`[${label}] autoplay menu: ok (${stopped} moves, then stopped)`);
    await menuPage.close();

    await page.close();
    console.log(`[${label}] ALL PASS`);
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
    await rm(extDir, { recursive: true, force: true });
  }
}

// --- human-like move selection ----------------------------------------------

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function humanizeChecks() {
  const mk = (vals, depth) =>
    vals.map((v, i) => ({ multipv: i + 1, depth, score: { type: "cp", value: v }, pv: [`m${i}`] }));

  // One candidate: nothing to humanise.
  const solo = new Humanizer({ elo: 1200, rng: seeded(1) });
  assert.equal(solo.choose(mk([40], 16), "w").reason, "forced");

  // A move that looked fine at a glance and loses on reflection is a slip,
  // and it must be picked when the mistake rate is pushed to 1.
  const slip = new Humanizer({ elo: 1250, mistake: 1, brilliancy: 0, rng: seeded(2) });
  slip.observe(mk([80, 30], 4), "w");
  slip.observe(mk([80, -40], 16), "w");
  const picked = slip.choose(mk([80, -40], 16), "w");
  assert.equal(picked.uci, "m1");
  assert.equal(picked.reason, "mistake");
  assert.ok(picked.cpLoss > 0 && picked.cpLoss <= cpCeiling(1250));

  // A move that looked unsound and wins deep is a find.
  const find = new Humanizer({ elo: 1800, mistake: 0, brilliancy: 1, rng: seeded(3) });
  find.observe(mk([120, -20], 4), "w");
  find.observe(mk([60, 260], 16), "w");
  assert.equal(find.choose(mk([60, 260], 16), "w").reason, "brilliant");

  // Nobody of any rating throws away more than the ceiling, ever.
  const casual = new Humanizer({ elo: 850, rng: seeded(4) });
  const ceiling = cpCeiling(850);
  let offBest = 0;
  for (let i = 0; i < 5000; i++) {
    casual.reset();
    const deep = mk([40, 25, 5, -300], 16);
    casual.observe(mk([40, 25, 5, -300], 4), "w");
    casual.observe(deep, "w");
    const p = casual.choose(deep, "w");
    assert.ok(p.cpLoss <= ceiling + 1e-9, `cpLoss ${p.cpLoss} exceeds ceiling ${ceiling}`);
    assert.notEqual(p.uci, "m3", "must not hang the position for no reason");
    if (p.uci !== "m0") offBest++;
  }
  assert.ok(offBest > 0, "a casual player should not always play the engine move");

  // Stronger players deviate less.
  const master = new Humanizer({ elo: 2300, rng: seeded(5) });
  let masterOff = 0;
  for (let i = 0; i < 5000; i++) {
    master.reset();
    const deep = mk([40, 25, 5, -300], 16);
    master.observe(mk([40, 25, 5, -300], 4), "w");
    master.observe(deep, "w");
    if (master.choose(deep, "w").uci !== "m0") masterOff++;
  }
  assert.ok(masterOff / 5000 < offBest / 5000, "master should stay closer to the truth");

  // A solid profile: past its own ceiling never, a slip never.
  const solid = new Humanizer({ ...SKILL.solid, rng: seeded(10) });
  for (let i = 0; i < 3000; i++) {
    solid.reset();
    solid.observe(mk([40, -30, 90, -200], 4), "w");
    solid.observe(mk([40, -30, 90, -200], 16), "w");
    const p = solid.choose(mk([40, -30, 90, -200], 16), "w");
    assert.ok(p.cpLoss <= 60 + 1e-9, `solid cpLoss ${p.cpLoss} exceeds 60`);
    assert.notEqual(p.reason, "mistake", "solid profile must never slip");
  }

  // Auto mode: form drifts, but stays a plausible rating and a reproducible one.
  const form = new Form({ base: 1500, rng: seeded(11) });
  const elos = Array.from({ length: 200 }, () => form.next().elo);
  assert.ok(elos.every(e => e >= 600 && e <= 2500), "form must stay in rating range");
  const mean = elos.reduce((a, b) => a + b, 0) / elos.length;
  const sd = Math.sqrt(elos.reduce((a, b) => a + (b - mean) ** 2, 0) / elos.length);
  assert.ok(mean > 1200 && mean < 1800, `form should centre near its base (${mean})`);
  assert.ok(sd > 20, `form should actually vary (sd ${sd.toFixed(1)})`);
  assert.ok(elos.some(e => e < mean - 40), "form must have quiet stretches");
  assert.ok(elos.some(e => e > mean + 40), "form must have good stretches");

  const fa = new Form({ rng: seeded(12) });
  const fb = new Form({ rng: seeded(12) });
  assert.deepEqual(
    Array.from({ length: 20 }, () => fa.next().elo),
    Array.from({ length: 20 }, () => fb.next().elo),
  );

  // Deterministic under an injected rng.
  const a = new Humanizer({ elo: 1400, rng: seeded(7) });
  const b = new Humanizer({ elo: 1400, rng: seeded(7) });
  const deep = mk([40, 25, 5], 16);
  for (const m of [a, b]) {
    m.observe(mk([40, 25, 5], 4), "w");
    m.observe(deep, "w");
  }
  assert.equal(a.choose(deep, "w").uci, b.choose(deep, "w").uci);

  const forced = thinkTime({ forced: true, rng: seeded(8) });
  assert.ok(forced >= 200 && forced <= 500);
  const thought = thinkTime({ elo: 1500, branching: 30, instability: 0.3, rng: seeded(9) });
  assert.ok(thought >= 350 && thought <= 22000);
  console.log("humanize: ok");
}

unitChecks();
humanizeChecks();
await runBrowserChecks({ csp: false });
await runBrowserChecks({ csp: true });
console.log("all checks passed");