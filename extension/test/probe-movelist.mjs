// Manual probe: dump the chess.com move list DOM after a few moves.
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
await page.goto("https://www.chess.com/analysis", { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 7000));
await page.evaluate(() => {
  const ok = [...document.querySelectorAll("button")].find(b => /^ok$/i.test(b.textContent.trim()));
  ok?.click();
});
await new Promise(r => setTimeout(r, 1000));
const geo = await page.evaluate(() => {
  const r = document.querySelector("wc-chess-board").getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width };
});
const sq = geo.width / 8;
const pt = (f, r) => ({ x: geo.left + (f + 0.5) * sq, y: geo.top + (7 - r + 0.5) * sq });
async function drag(a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 900));
}
await drag(pt(4, 1), pt(4, 3));
await drag(pt(4, 6), pt(4, 4));
await drag(pt(6, 0), pt(5, 2));
await new Promise(r => setTimeout(r, 1500));
console.log(
  JSON.stringify(
    await page.evaluate(() => {
      const lists = [...document.querySelectorAll("wc-simple-move-list, .move-list, .vertical-move-list, [class*=move-list]")]
        .map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 80), html: e.outerHTML.slice(0, 1200) }));
      const nodes = [...document.querySelectorAll("[data-ply], .node, .move")]
        .slice(0, 12)
        .map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), text: e.textContent.trim().slice(0, 20), ply: e.getAttribute("data-ply") }));
      return { lists: lists.slice(0, 3), nodes };
    }),
    null,
    2,
  ),
);
await browser.close();