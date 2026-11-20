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

unitChecks();
await runBrowserChecks({ csp: false });
await runBrowserChecks({ csp: true });
console.log("all checks passed");