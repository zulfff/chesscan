// Manual live check: autoplay on a real play page (computer game), not the
// analysis board. This is the path with no `.selected` move-list node, a live
// opponent, and a clock, so it is the one that matters for "does it play".
//
//   chromium --remote-debugging-port=9222 --load-extension=build/chrome
//   # open https://www.chess.com/play/computer, pick a bot, press Start
//   node test/live-play-page.mjs [moves]

import puppeteer from "puppeteer-core";

const WANT = Number(process.argv[2] || 3);
const PORT = Number(process.env.PORT || 9222);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${PORT}`,
  defaultViewport: null,
});
const page = (await browser.pages()).find(p => /chess\.com\/play/.test(p.url()));
if (!page) {
  console.error("no chess.com/play tab");
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
    why: s.getElementById('why').textContent,
    guide: s.getElementById('guide').value,
    play: s.getElementById('play').value,
    plies: [...document.querySelectorAll('wc-move-list .node')].filter(n => n.textContent.trim()).length,
  })`);

let now = await read();
if (!now) {
  console.error("panel not found");
  await browser.disconnect();
  process.exit(1);
}
console.log("before:", JSON.stringify(now));
if (now.fen === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1") {
  const started = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "Start");
    if (!b) return false;
    b.click();
    return true;
  });
  console.log("pressed Start:", started);
  await sleep(6000);
}
if ((await read()).on === "true") await panel(`s => s.getElementById('auto').click()`);
await panel(`s => { const g = s.getElementById('guide'); g.value = 'auto'; g.dispatchEvent(new Event('change', { bubbles: true })); }`);
await sleep(1500);
now = await read();
console.log("armed from:", JSON.stringify(now));
await panel(`s => s.getElementById('auto').click()`);
console.log("after arm:", JSON.stringify(await read()));

let played = 0;
let prev = now.fen;
const deadline = Date.now() + 90000;
while (played < WANT && Date.now() < deadline) {
  await sleep(300);
  const r = await read();
  if (r.on !== "true") {
    console.log("disarmed itself:", JSON.stringify(r));
    break;
  }
  if (r.fen !== prev) {
    played++;
    console.log(`${played}. ${r.fen}  [${r.why}] ${r.note}`);
    prev = r.fen;
  }
}

const end = await read();
console.log(`final: ${JSON.stringify(end)}`);
await page.screenshot({ path: "/data/home/live-play-page.png" });
await browser.disconnect();
process.exit(played > 0 && end.on === "true" ? 0 : 1);
