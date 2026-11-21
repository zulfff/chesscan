// Manual check on the real chess.com analysis board: make a move by dragging and
// confirm the extension follows the DOM. Usage: node test/real-move.mjs

import puppeteer from "puppeteer-core";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = "/tmp/chesscan-real-move";
await rm(dir, { recursive: true, force: true });
await cp(new URL("../build/chrome", import.meta.url).pathname, dir, { recursive: true });
const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
manifest.content_scripts[0].matches.push("https://www.chess.com/*");
await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${dir}`,
    `--load-extension=${dir}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const panel = () =>
  (() => {
    const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
    if (!s) return null;
    return {
      fen: s.getElementById("fen").textContent,
      turn: s.getElementById("turn").textContent,
      status: s.getElementById("status").textContent,
      prob: s.getElementById("prob").textContent,
      lines: [...s.querySelectorAll(".line:not(.placeholder) .san")].map(e => e.textContent),
      scores: [...s.querySelectorAll(".line:not(.placeholder) .sc")].map(e => e.textContent),
      arrow: !!document.getElementById("chesscan-arrow-layer")?.querySelector("svg"),
    };
  })();

try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("page error:", e.message));
  await page.goto("https://www.chess.com/analysis", { waitUntil: "domcontentloaded", timeout: 60000 });

  // Dismiss the "Game Review & Analysis" promo if it shows up.
  await sleep(4000);
  await page.evaluate(() => {
    const ok = [...document.querySelectorAll("button")].find(b => /^ok$/i.test(b.textContent.trim()));
    ok?.click();
  });
  await sleep(1500);

  await page.waitForFunction(
    () => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      return s && s.getElementById("fen").textContent.includes("KQkq");
    },
    { timeout: 30000 },
  );

  const geo = await page.evaluate(() => {
    const b = document.querySelector("wc-chess-board");
    const r = b.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      flipped: b.classList.contains("flipped"),
      pieces: b.querySelectorAll(".piece").length,
    };
  });
  console.log("board", JSON.stringify(geo));

  const sq = geo.width / 8;
  const cx = file => geo.left + (geo.flipped ? 7 - file : file) * sq + sq / 2;
  const cy = rank => geo.top + (geo.flipped ? rank : 7 - rank) * sq + sq / 2;

  // Drag the e2 pawn to e4.
  await page.mouse.move(cx(4), cy(1));
  await page.mouse.down();
  await page.mouse.move(cx(4), cy(3), { steps: 12 });
  await page.mouse.up();
  await sleep(3500);

  let state = await page.evaluate(panel);
  console.log("after move:", JSON.stringify(state, null, 2));

  // Wait for the engine to settle on the new position.
  await page.waitForFunction(
    () => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      return s && s.getElementById("fen").textContent.includes(" b ") && !s.getElementById("live").classList.contains("on");
    },
    { timeout: 60000 },
  ).catch(() => {});

  state = await page.evaluate(panel);
  console.log("settled:", JSON.stringify(state, null, 2));
  await page.screenshot({ path: join(here, "real-move.png") });

  if (!state || !state.fen.startsWith("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b")) {
    console.error("FAIL: extension did not follow the move");
    process.exitCode = 1;
  } else {
    console.log("PASS: move followed");
  }
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}