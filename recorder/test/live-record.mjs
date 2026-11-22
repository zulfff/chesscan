// Live check for the recorder extension.
//
//   chromium --user-data-dir=<fresh> --remote-debugging-port=9222 \
//     --load-extension=<chesscan>/build/chrome --load-extension=recorder
//   # open https://www.chess.com/analysis on a screen with xdotool
//   node test/live-record.mjs [seconds]
//
// tabCapture only hands out a stream id to an extension Chrome considers
// invoked on the tab, and a synthetic openPopup() does not count — so this test
// fires the manifest's `_execute_action` shortcut with a real X key event. A
// fresh profile matters too: suggested_key is applied at install time.
//
// Everything the tab does is asserted through the DOM and storage, not through
// pixels; the video file is checked for existence and readability afterwards.

import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 9222);
const SECONDS = Number(process.argv[2] || 4);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DISPLAY = process.env.DISPLAY || ":1";

const xdo = (...args) => {
  try {
    return execFileSync("xdotool", args, { env: { ...process.env, DISPLAY }, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (err) {
    console.log("xdotool", args.join(" "), "failed:", err.message.split("\n")[0]);
    return "";
  }
};

const browser = await puppeteer.connect({
  browserURL: `http://127.0.0.1:${PORT}`,
  defaultViewport: null,
});

const game = (await browser.pages()).find(page => /chess\.com/.test(page.url()));
if (!game) {
  console.error("no chess.com tab");
  process.exit(1);
}
await game.bringToFront();
// Reload re-injects the content script and wakes the recorder's service worker
// (Chrome stops an idle MV3 worker after ~30 s).
await game.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await sleep(5000);

let sw = null;
for (const target of browser.targets().filter(t => t.type() === "service_worker" && /background\.js/.test(t.url()))) {
  const worker = await target.worker();
  const name = await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => null);
  if (name === "chesscan recorder") sw = worker;
}
if (!sw) {
  console.error("recorder service worker not found; is the extension loaded?");
  await browser.disconnect();
  process.exit(1);
}

const panelState = () =>
  game.evaluate(() => {
    const host = document.getElementById("chesscan-ext-root");
    const arrow = document.getElementById("chesscan-arrow-layer");
    return {
      panel: host ? getComputedStyle(host).display : "missing",
      arrow: arrow ? getComputedStyle(arrow).display : "missing",
      style: document.getElementById("chesscan-rec-hide")?.textContent ?? null,
      fen: host?.shadowRoot?.getElementById("fen")?.textContent ?? null,
    };
  });

const recorderState = () =>
  sw.evaluate(async () => (await chrome.storage.session.get("recorder")).recorder ?? null);

console.log("before:", JSON.stringify(await panelState()));

const shortcut = await sw.evaluate(async () => {
  const command = (await chrome.commands.getAll()).find(c => c.name === "_execute_action");
  return command?.shortcut ?? "";
});
if (!shortcut) {
  console.error("no _execute_action shortcut: reinstall the extension in a fresh profile");
  await browser.disconnect();
  process.exit(1);
}

xdo("search", "--name", "Chess Analysis Board", "windowactivate", "--sync");
await sleep(400);
xdo("key", "--clearmodifiers", shortcut.toLowerCase());

// Attach to the popup if CDP exposes it; either way the button is the same, and
// the coordinate path below is the one that works on a bare Xvfb desktop.
let popup = null;
for (let i = 0; i < 10 && !popup; i += 1) {
  await sleep(500);
  popup = (await browser.pages()).find(page => page.url().includes("/src/popup.html") && !page.isClosed()) ?? null;
}

let started = false;
if (popup) {
  try {
    await popup.waitForSelector("#go:not([disabled])", { timeout: 15000 });
    await popup.click("#go");
    started = true;
    console.log("start: clicked the popup button");
  } catch {
    console.log("popup was not usable; falling back to coordinates");
  }
}
if (!started) {
  // The toolbar popup sits top-right at the width Chrome gives it; this is the
  // Start button's centre on the reference layout.
  xdo("mousemove", "1225", "328", "click", "1");
  console.log("start: clicked at 1225,328");
}
await sleep(2500);

const state = await recorderState();
const during = await panelState();
console.log("state:", JSON.stringify(state));
console.log("during:", JSON.stringify(during));

const coachPage = (await browser.pages()).find(page => page.url().includes("/src/coach.html")) ?? null;
let coachWindow = null;
if (state?.coachWindowId != null) {
  coachWindow = await sw.evaluate(async id => {
    try {
      return await chrome.windows.get(id);
    } catch {
      return null;
    }
  }, state.coachWindowId);
}
console.log("coach window:", coachWindow ? `${coachWindow.width}x${coachWindow.height} @ ${coachWindow.left},${coachWindow.top}` : "MISSING");

let coachSeen = null;
if (coachPage && !coachPage.isClosed()) {
  coachSeen = await coachPage.evaluate(() => ({
    move: document.getElementById("move").textContent,
    score: document.getElementById("score").textContent,
    alts: [...document.querySelectorAll("#alts li")].map(li => li.textContent),
  }));
} else {
  console.log("coach page did not attach to CDP");
}
console.log("coach:", JSON.stringify(coachSeen));

await sleep(SECONDS * 1000);

// Stop from the coach when possible, otherwise from the coach window's Stop
// button by coordinates, otherwise through the worker.
if (coachPage && !coachPage.isClosed()) {
  await coachPage.click("#stop").catch(() => {});
  console.log("stop: clicked the coach button");
} else if (coachWindow) {
  xdo("mousemove", String(Math.round(coachWindow.left + 170)), String(Math.round(coachWindow.top + 295)), "click", "1");
  console.log("stop: clicked the coach at its Stop button");
} else {
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: "recorder-stop" }));
  console.log("stop: through the worker");
}
await sleep(6000);

const after = await panelState();
console.log("after:", JSON.stringify(after));
console.log("state:", JSON.stringify(await recorderState()));

const dir = join(homedir(), "Downloads");
const files = (await readdir(dir).catch(() => [])).filter(name => /^chesscan-.*\.(webm|mp4)$/.test(name)).sort();
const newest = files.at(-1);
let video = null;
if (newest) {
  const info = await stat(join(dir, newest));
  video = `${newest} ${(info.size / 1024).toFixed(0)} KiB`;
}
console.log("file:", video ?? "none");

const ok =
  !!state &&
  !!state.tabId &&
  during.panel === "none" &&
  during.arrow === "none" &&
  !!during.style &&
  !after.style &&
  after.panel !== "none" &&
  after.arrow !== "none" &&
  !!video &&
  !!coachSeen &&
  !!coachSeen.move;

await browser.disconnect();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);