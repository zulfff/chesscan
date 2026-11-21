// End-to-end check: real Chromium, the real extension, real Stockfish WASM.
// Fixtures reproduce the DOM chess.com renders, so board reading, turn
// inference, the engine loop and the panel are all exercised without an account.

import puppeteer from "puppeteer-core";
import http from "node:http";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { toFen, inferCastling, plausible } from "../src/fen.js";
import { turnFromDiff, turnFromLastMove } from "../src/turn.js";
import { Humanizer, SKILL, cpCeiling, thinkTime } from "../src/humanize.js";
import { chesscomHtml, fenPieces, START, AFTER_E4, CASTLED } from "./fixtures.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const extRoot = join(root, "..");
const CHROMIUM = process.env.CHROMIUM || "/usr/bin/chromium";
const PORT = 8123;

const AFTER_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R";

// --- unit checks on the pure modules ----------------------------------------

function unitChecks() {
  const start = new Array(64).fill(null);
  for (const p of fenPieces(START)) start[p.rank * 8 + p.file] = { color: p.color, type: p.type };
  assert.equal(toFen(start, "w"), `${START} w KQkq - 0 1`);
  assert.equal(inferCastling(start), "KQkq");
  assert.ok(plausible(start));

  const after = start.slice();
  after[12] = null;
  after[28] = { color: "w", type: "p" };
  assert.equal(turnFromDiff(start, after), "b");
  assert.equal(turnFromLastMove(after, [12, 28]), "b");

  // A navigation jump changes too much to be a move.
  const other = fenPieces(CASTLED).reduce((acc, p) => {
    acc[p.rank * 8 + p.file] = { color: p.color, type: p.type };
    return acc;
  }, new Array(64).fill(null));
  assert.equal(turnFromDiff(start, other), null);

  const noKings = start.slice();
  noKings[4] = null;
  assert.ok(!plausible(noKings));
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
    const board = url.searchParams.get("board") || START;
    const flipped = url.searchParams.get("flip") === "1";
    const last = (url.searchParams.get("last") || "").split(",").filter(Boolean);
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (csp) {
      headers["content-security-policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
    }
    res.writeHead(200, headers);
    res.end(chesscomHtml(board, { flipped, last }));
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

    await setPlay(page, "off");
    await waitLines(page);

    // 3. a move happens in the DOM -> turn flips without any site API
    await applyMove(page, "52", "54");
    await waitFen(page, `${AFTER_E4} b KQkq - 0 1`);
    await waitLines(page);
    p = await readPanel(page);
    assert.equal(p.turn, "b");
    console.log(`[${label}] move detection: ok (${p.lines[0]} ${p.scores[0]})`);

    // 4. manual flip overrides the side to move
    await page.evaluate(panelEval(`s => s.getElementById('flip').click()`));
    await waitFen(page, `${AFTER_E4} w KQkq - 0 1`);
    console.log(`[${label}] manual flip: ok`);
    await page.evaluate(panelEval(`s => s.getElementById('flip').click()`));
    await waitFen(page, `${AFTER_E4} b KQkq - 0 1`);

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