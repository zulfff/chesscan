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
// It then stops with the `recorder-stop` hotkey, which is the path the user
// actually has while playing: no window to hunt for, no popup to reopen.
//
// Everything is asserted through the DOM and storage, not pixels; the video file
// is checked for existence afterwards.

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

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });

const game = (await browser.pages()).find(page => /chess\.com/.test(page.url()));
if (!game) {
  console.error("no chess.com tab");
  process.exit(1);
}
await game.bringToFront();
// Reload re-injects the content script and wakes the recorder's service worker.
await game.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await sleep(5000);

let sw = null;
for (const target of browser.targets().filter(t => t.type() === "service_worker" && /src\/background\.js/.test(t.url()))) {
  const worker = await target.worker();
  if ((await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => null)) === "chesscan recorder") sw = worker;
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
      style: !!document.getElementById("chesscan-rec-hide"),
      fen: host?.shadowRoot?.getElementById("fen")?.textContent ?? null,
    };
  });

const recorderState = () =>
  sw.evaluate(async () => (await chrome.storage.session.get("recorder")).recorder ?? null);

const pageByUrl = async frag => (await browser.pages()).find(p => p.url().includes(frag) && !p.isClosed()) ?? null;

console.log("before:", JSON.stringify(await panelState()));

const commands = await sw.evaluate(async () =>
  Object.fromEntries((await chrome.commands.getAll()).map(c => [c.name, c.shortcut])),
);
const openKey = commands["_execute_action"];
const stopKey = commands["recorder-stop"];
console.log("shortcuts:", JSON.stringify(commands));
if (!openKey) {
  console.error("no _execute_action shortcut: reinstall the extension in a fresh profile");
  await browser.disconnect();
  process.exit(1);
}

// Real invocation: tabCapture refuses anything else.
xdo("search", "--name", "Chess Analysis Board", "windowactivate", "--sync");
await sleep(400);
xdo("key", "--clearmodifiers", openKey.toLowerCase());

let popup = null;
for (let i = 0; i < 10 && !popup; i += 1) {
  await sleep(500);
  popup = await pageByUrl("/src/popup.html");
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
await sleep(3000);

const state = await recorderState();
const during = await panelState();
const recordPage = await pageByUrl("/src/record.html");
const recordUi = recordPage
  ? await recordPage.evaluate(() => ({
      status: document.getElementById("status").textContent,
      stopDisabled: document.getElementById("stop").disabled,
      saveHidden: document.getElementById("save").hidden,
    }))
  : null;
console.log("state:", JSON.stringify(state));
console.log("during:", JSON.stringify(during));
console.log("record window:", JSON.stringify(recordUi));

const coachPage = await pageByUrl("/src/coach.html");
const coachSeen = coachPage
  ? await coachPage.evaluate(() => ({
      move: document.getElementById("move").textContent,
      score: document.getElementById("score").textContent,
      alts: [...document.querySelectorAll("#alts li")].map(li => li.textContent),
    }))
  : null;
console.log("coach:", JSON.stringify(coachSeen));

await sleep(SECONDS * 1000);

// The hotkey is the whole point: stop from the board, no UI hunting.
if (stopKey) {
  xdo("key", "--clearmodifiers", stopKey.toLowerCase());
  console.log(`stop: pressed ${stopKey}`);
} else {
  console.log("no recorder-stop shortcut; stopping through the worker");
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: "recorder-stop" }));
}
await sleep(6000);

const after = await panelState();
const recordAfter = recordPage && !recordPage.isClosed()
  ? await recordPage.evaluate(() => ({
      status: document.getElementById("status").textContent,
      saveHidden: document.getElementById("save").hidden,
    }))
  : null;
console.log("after:", JSON.stringify(after));
console.log("record window after:", JSON.stringify(recordAfter));
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
  !!state?.uiTabId &&
  during.panel === "none" &&
  during.arrow === "none" &&
  during.style &&
  !after.style &&
  after.panel !== "none" &&
  after.arrow !== "none" &&
  !!recordUi &&
  !recordUi.stopDisabled &&
  !!video &&
  !!coachSeen?.move;

await browser.disconnect();
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);