// Manual live check: arm the panel's autoplay menu on a real chess.com board
// and watch it play. Not part of npm test — it needs a real browser, a real
// site, and a human deciding which page is safe to play on.
//
//   chromium --remote-debugging-port=9222 --load-extension=build/chrome
//   # open https://www.chess.com/analysis (or an unrated/bot game)
//   node test/live-autoplay.mjs [moves]
//
// It arms through the same button a person clicks, reads the result out of the
// panel and the site's own move list, and disarms at the end. The gap between
// moves is printed so the pacing can be eyeballed, not just asserted.

import puppeteer from "puppeteer-core";

const WANT = Number(process.argv[2] || 6);
const PORT = Number(process.env.PORT || 9222);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${PORT}`,
  defaultViewport: null,
});
const page = (await browser.pages()).find(p => /chess\.com/.test(p.url()));
if (!page) {
  console.error("no chess.com tab");
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
    play: s.getElementById('play').value,
    guide: s.getElementById('guide').value,
    plies: [...document.querySelectorAll('wc-move-list .node')].filter(n => n.textContent.trim()).length,
  })`);

// Start from a known state: never inherit an arming from an earlier run.
if ((await read()).on === "true") await panel(`s => s.getElementById('auto').click()`);
await panel(`s => { const g = s.getElementById('guide'); g.value = 'both'; g.dispatchEvent(new Event('change', { bubbles: true })); }`);
await sleep(1500);
const start = await read();
console.log("start:", JSON.stringify(start));

await panel(`s => s.getElementById('auto').click()`);
console.log("armed:", JSON.stringify(await read()));

const deadline = Date.now() + 300000;
let played = 0;
let prevAt = Date.now();
let lastPlies = (await read()).plies;
const gaps = [];
while (played < WANT && Date.now() < deadline) {
  await sleep(250);
  const now = await read();
  if (now.on !== "true") {
    console.log("disarmed itself:", now.note);
    break;
  }
  // Count plies on the site's own move list, not FEN edits: a re-read can
  // change a FEN field without a piece moving.
  if (now.plies > lastPlies) {
    const gap = Date.now() - prevAt;
    prevAt = Date.now();
    gaps.push(gap);
    played += now.plies - lastPlies;
    lastPlies = now.plies;
    console.log(`${played}. +${(gap / 1000).toFixed(1)}s  ${now.fen}  [${now.why}]`);
  }
}

await page.screenshot({ path: "/data/home/live-autoplay.png" });
const siteMoves = await page.evaluate(() =>
  [...document.querySelectorAll("wc-move-list .node")]
    .map(n => n.textContent.trim())
    .filter(Boolean)
    .join(" "),
);
console.log("site move list:", siteMoves);
if (gaps.length) {
  const s = [...gaps].sort((a, b) => a - b);
  console.log(
    `gaps: min ${(s[0] / 1000).toFixed(1)}s  median ${(s[(s.length / 2) | 0] / 1000).toFixed(1)}s  max ${(s[s.length - 1] / 1000).toFixed(1)}s`,
  );
}

await panel(`s => s.getElementById('auto').click()`);
// A gesture already in flight when we disarmed still lands; let it settle
// before deciding whether the loop really stopped.
await sleep(3000);
const after = await read();
await sleep(8000);
const later = await read();
console.log("after disarm:", JSON.stringify({ on: later.on, note: later.note, play: later.play }));
console.log("stopped:", after.fen === later.fen && after.plies === later.plies);
console.log(`played ${played} ply(s)`);
await browser.disconnect();
