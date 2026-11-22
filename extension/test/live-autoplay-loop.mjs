// Manual live check: autoplay in the shape of a real game, not a solo board.
// Arm with guide=auto (the player's side), let it play white, answer as black
// by dragging a legal move, and require it to play white again. Repeats three
// times. A harness that plays one move and then sits there is broken even
// though every individual move was legal.
//
//   chromium --remote-debugging-port=9222 --load-extension=build/chrome
//   # open https://www.chess.com/analysis
//   node test/live-autoplay-loop.mjs

import puppeteer from "puppeteer-core";
import { Chess } from "chess.js";

const PORT = Number(process.env.PORT || 9222);
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const ROUNDS = Number(process.argv[2] || 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
const read = () =>
  panel(`s => ({
    fen: s.getElementById('fen').textContent,
    on: s.getElementById('auto').getAttribute('aria-pressed'),
    note: s.getElementById('autoinfo').textContent,
    guide: s.getElementById('guide').value,
    plies: [...document.querySelectorAll('wc-move-list .node')].filter(n => n.textContent.trim()).length,
  })`);

await page.goto(`https://www.chess.com/analysis?fen=${encodeURIComponent(START)}`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await sleep(7000);

// Never inherit an arming or a guide mode from an earlier run.
let now = await read();
if (!now) {
  console.error("panel not found");
  await browser.disconnect();
  process.exit(1);
}
if (now.on === "true") await panel(`s => s.getElementById('auto').click()`);
await panel(`s => { const g = s.getElementById('guide'); g.value = 'auto'; g.dispatchEvent(new Event('change', { bubbles: true })); }`);
await sleep(1500);
for (let i = 0; i < 40; i++) {
  if ((await read()).fen === START) break;
  await sleep(250);
}
now = await read();
if (now.fen !== START) {
  console.error(`board did not reset: ${now.fen}`);
  await browser.disconnect();
  process.exit(1);
}
console.log(`start guide=${now.guide} fen=${now.fen}`);

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

// The move list runs ahead of the board, so wait for the panel's own FEN: a
// distinct position with the expected side to move. A lag is fine; a wrong
// position is not, and the FEN's turn is what the next drag is computed from.
const waitTurn = async (turn, prevFen, ms = 25000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await read();
    if (r.fen !== prevFen && r.fen.split(" ")[1] === turn) return r;
    if (r.on !== "true") return r;
    await sleep(100);
  }
  return null;
};

await panel(`s => s.getElementById('auto').click()`);
console.log("armed:", JSON.stringify(await read()));

let failures = 0;
let prev = START;
for (let round = 1; round <= ROUNDS; round++) {
  // White's move must arrive on its own.
  const afterWhite = await waitTurn("b", prev);
  if (!afterWhite || afterWhite.on !== "true" || afterWhite.fen.split(" ")[1] !== "b") {
    console.log(`round ${round}: autoplay did not play white (${JSON.stringify(afterWhite)})`);
    failures++;
    break;
  }
  console.log(`round ${round}: white played -> ${afterWhite.fen}  [${afterWhite.note}]`);

  // Answer as black, exactly as an opponent would, from the panel's position.
  const game = new Chess(afterWhite.fen);
  const reply = game.moves({ verbose: true })[0];
  await drag(reply.from, reply.to);
  const afterBlack = await waitTurn("w", afterWhite.fen);
  if (!afterBlack || afterBlack.fen.split(" ")[1] !== "w") {
    console.log(`round ${round}: black's reply never appeared`);
    failures++;
    break;
  }
  console.log(`round ${round}: black replied ${reply.san} -> ${afterBlack.fen}`);
  prev = afterBlack.fen;
  await sleep(300);
}

const end = await read();
console.log(`final: on=${end.on} plies=${end.plies} note=${JSON.stringify(end.note)}`);
console.log(`final fen: ${end.fen}`);
await page.screenshot({ path: "/data/home/live-autoplay-loop.png" });
await browser.disconnect();
process.exit(failures === 0 && end.plies >= ROUNDS * 2 ? 0 : 1);
