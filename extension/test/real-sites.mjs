// Manual check against the real sites (public pages, no login).
// Usage: node test/real-sites.mjs [url ...]

import puppeteer from "puppeteer-core";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const extRoot = join(root, "..");
const dir = join(root, ".real-ext");

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["https://www.chess.com/analysis"];

await rm(dir, { recursive: true, force: true });
await cp(join(extRoot, "build", "chrome"), dir, { recursive: true });
const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
manifest.content_scripts[0].matches.push("https://www.chess.com/*", "https://chess.com/*");
await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${dir}`,
    `--load-extension=${dir}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-quic",
    "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

try {
  for (const url of urls) {
    const page = await browser.newPage();
    page.on("pageerror", e => console.log(`[${url}] page error:`, e.message));
    console.log(`\n== ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      console.log("goto failed:", e.message);
      await page.close();
      continue;
    }
    await new Promise(r => setTimeout(r, 8000));

    const info = await page.evaluate(() => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      return {
        title: document.title,
        boards: {
          cgWrap: document.querySelectorAll(".cg-wrap").length,
          cgBoard: document.querySelectorAll("cg-board").length,
          chesscom: document.querySelectorAll("wc-chess-board, chess-board").length,
          piecesLichess: document.querySelectorAll("cg-board piece").length,
          piecesChesscom: document.querySelectorAll(".piece").length,
        },
        panel: s
          ? {
              fen: s.getElementById("fen").textContent,
              turn: s.getElementById("turn").textContent,
              status: s.getElementById("status").textContent,
              lines: [...s.querySelectorAll(".line:not(.placeholder) .san")].map(e => e.textContent),
              prob: s.getElementById("prob").textContent,
              arrow: !!document.getElementById("chesscan-arrow-layer")?.querySelector("svg"),
            }
          : null,
      };
    });
    console.log(JSON.stringify(info, null, 2));
    await page.screenshot({ path: join(root, `real-${urls.indexOf(url)}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}