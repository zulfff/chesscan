// Manual live check: play a line on a real chess.com analysis board at
// bullet-ish spacing and prove the panel never shows a position the site's own
// move list does not contain. Not part of npm test — it needs a real browser,
// a real site, and a human deciding which page is safe to play on.
//
//   chromium --remote-debugging-port=9222 --load-extension=build/chrome
//   # open https://www.chess.com/analysis
//   node test/live-fast-controls.mjs [gap-ms]
//
// The check is deliberately about hallucination, not latency: a panel that lags
// a move behind is honest, a panel that shows a position that never existed is
// not. Every FEN the panel renders has to be one of the positions the move list
// can produce, and the last one has to be the final position.

import puppeteer from "puppeteer-core";
import { Chess } from "chess.js";

const GAP = Number(process.argv[2] || 500);
const PORT = Number(process.env.PORT || 9222);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const LINE = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = fen => fen.split(" ").slice(0, 2).join(" ");

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${PORT}`,
  defaultViewport: null,
});
const page = (await browser.pages()).find(p => /chess\.com\/analysis/.test(p.url()));
if (!page) {
  console.error("no chess.com/analysis tab");
  process.exit(1);
}
await page.bringToFront();

const panel = fn =>
  page.evaluate(
    `(() => { const s = document.getElementById('chesscan-ext-root')?.shadowRoot; return s ? (${fn})(s) : null; })()`,
  );
const panelFen = () => panel(`s => s.getElementById('fen').textContent`);
const moveCount = () =>
  page.evaluate(
    () => [...document.querySelectorAll("wc-move-list .node")].filter(n => n.textContent.trim()).length,
  );

await page.goto(`https://www.chess.com/analysis?fen=${encodeURIComponent(START)}`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await sleep(7000);

// The panel only exists once the content script has found the board. If it is
// closed from an earlier session, say so instead of timing out on a null.
if (!(await panelFen())) {
  console.error("panel not found; is the extension loaded and the board visible?");
  await browser.disconnect();
  process.exit(1);
}
for (let i = 0; i < 60; i++) {
  if ((await panelFen()) === START) break;
  await sleep(250);
}
const startFen = await panelFen();
if (startFen !== START) {
  console.error(`board did not reset to the start position: ${startFen}`);
  await browser.disconnect();
  process.exit(1);
}
console.log("start:", startFen);

const geom = await page.evaluate(() => {
  const b = document.querySelector("wc-chess-board");
  const r = b.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, flipped: b.classList.contains("flipped") };
});
const center = sq => {
  const file = "abcdefgh".indexOf(sq[0]);
  const rank = Number(sq[1]) - 1;
  const col = geom.flipped ? 7 - file : file;
  const row = geom.flipped ? rank : 7 - rank;
  return { x: geom.x + (col + 0.5) * (geom.w / 8), y: geom.y + (row + 0.5) * (geom.h / 8) };
};
const drag = async (from, to) => {
  const a = center(from);
  const b = center(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await sleep(30);
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await sleep(30);
  await page.mouse.up();
};

// Sample the panel while the moves land. A distinct FEN is a position the
// extension decided to show, and each one has to be explainable.
const seen = [];
let stop = false;
const poll = (async () => {
  while (!stop) {
    try {
      const fen = await panelFen();
      if (fen && fen !== seen[seen.length - 1]?.fen) seen.push({ t: Date.now(), fen, moves: await moveCount() });
    } catch {
      // navigation in flight; the next sample will do
    }
    await sleep(50);
  }
})();

const game = new Chess();
const played = [];
for (const san of LINE.split(" ")) {
  const move = game.move(san);
  await drag(move.from, move.to);
  played.push(san);
  await sleep(GAP);
}
stop = true;
await poll;
await sleep(2500); // let the last position settle and the engine finish

const site = await page.evaluate(() =>
  [...document.querySelectorAll("wc-move-list .node")]
    .map(n => n.textContent.trim())
    .filter(Boolean),
);
const replay = new Chess();
const legal = new Map([[key(replay.fen()), 0]]);
for (const san of site) {
  try {
    replay.move(san);
  } catch {
    console.error(`site move list has a token chess.js cannot play: ${JSON.stringify(san)}`);
    console.error("full list:", JSON.stringify(site));
    await browser.disconnect();
    process.exit(1);
  }
  legal.set(key(replay.fen()), legal.size);
}
const finalFen = replay.fen();

let bad = 0;
for (const s of seen) {
  if (!legal.has(key(s.fen))) {
    bad++;
    console.log(`BAD  ${s.fen}  (move list had ${s.moves})`);
  }
}
const last = await panelFen();
const finalOk = key(last) === key(finalFen);
const shown = new Set(seen.map(s => legal.get(key(s.fen))).filter(v => v !== undefined));

console.log(`played ${played.length} plies at ~${GAP} ms`);
console.log(`site move list: ${site.join(" ")}`);
console.log(`panel FENs: ${seen.length} distinct, ${shown.size} of ${legal.size} positions`);
const missing = [...legal.entries()].filter(([, ply]) => !shown.has(ply)).map(([, ply]) => ply);
if (missing.length) console.log(`never shown (lag, not wrong): ${missing.join(", ")}`);
console.log(`bad FENs: ${bad}`);
console.log(`final: ${last}`);
console.log(`final matches the move list: ${finalOk}`);

await page.screenshot({ path: "/data/home/live-fast-controls.png" });
await browser.disconnect();
process.exit(bad === 0 && finalOk ? 0 : 1);
