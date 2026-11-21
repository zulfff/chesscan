#!/usr/bin/env node
// Autoplay harness: play the moves chesscan already suggests, on a real board.
//
// This is a testing tool, not a ladder bot. It is deliberately outside the
// extension: nothing here ships, and nothing here runs unless you start it.
// It clicks with real browser input (CDP Input.dispatchMouseEvent), which is
// the only way to be sure the board accepts the click the way it accepts a
// person's — synthetic DOM events can be refused by pointer capture and then
// you are testing your own event dispatcher, not the site.
//
// The extension does the thinking: it reads the board, searches, and marks the
// move it picked. This script reads that pick out of the panel, checks it is
// legal in the FEN the panel is showing, and clicks the two squares.
//
// Use it on unrated games or against bots. It plays one side only, stops at a
// move cap, never rematches, and refuses any move that is not legal in the
// position it just read.
//
//   # Chrome must be running with the extension loaded and remote debugging on:
//   chromium --remote-debugging-port=9222 --load-extension=build/chrome
//
//   node tools/autoplay.mjs --dry          # show the plan, click nothing
//   node tools/autoplay.mjs --moves=20     # play up to 20 of your moves
//
// Options:
//   --port=9222        DevTools port of the running browser
//   --moves=40         Stop after this many of your moves
//   --delay=900        Minimum gap after a move, ms
//   --mode=drag|click  How to move a piece. drag is the verified gesture
//   --side=auto|w|b|both  Which side to play. auto = the side at the bottom.
//                      both is analysis-board only: it plays each side in turn
//   --stall=60000      Stop after this long with no move played, ms
//   --dry              Read and validate, print, never click
//   --timeout=30000    How long to wait for a pick before giving up

import puppeteer from "puppeteer-core";
import { legalMove, squareCenter, squareName, dragMove, clickMove } from "../src/autoplay.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};
const PORT = Number(opt("port", 9222));
const MAX_MOVES = Number(opt("moves", 40));
const DELAY = Number(opt("delay", 900));
const SIDE = String(opt("side", "auto"));
const MODE = String(opt("mode", "drag"));
const STALL = Number(opt("stall", 60000));
const DRY = !!opt("dry", false);
const TIMEOUT = Number(opt("timeout", 30000));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log("[autoplay]", ...a);

/** Everything the loop needs, read straight out of the panel the extension drew. */
async function readPanel(page) {
  return page.evaluate(() => {
    const host = document.getElementById("chesscan-ext-root");
    const s = host?.shadowRoot;
    if (!s) return { error: "no panel" };
    // A closed panel keeps its last lines, so a stale pick is still in the DOM.
    // Refuse to read from it: the FEN on screen is not the board's any more.
    if (s.querySelector(".panel")?.hidden) return { error: "panel closed" };
    const board = document.querySelector("wc-chess-board, chess-board");
    if (!board) return { error: "no board" };
    const r = board.getBoundingClientRect();
    const line =
      s.querySelector(".line.chosen[data-uci]") ?? s.querySelector(".line[data-uci]");
    return {
      fen: s.getElementById("fen").textContent,
      status: s.getElementById("status").textContent,
      turn: s.getElementById("turn").textContent,
      searching: s.getElementById("live").classList.contains("on"),
      uci: line?.dataset.uci ?? null,
      picked: !!s.querySelector(".line.chosen"),
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      flipped: board.classList.contains("flipped"),
      url: location.href,
    };
  });
}

async function findBoardPage(browser) {
  for (const page of await browser.pages()) {
    if (!/chess\.com/.test(page.url())) continue;
    try {
      const st = await readPanel(page);
      if (!st.error) return { page, state: st };
    } catch {
      /* tab is navigating or gone */
    }
  }
  return null;
}

/** Wait until the panel has a settled pick for the current position. */
async function waitForPick(page, deadline) {
  while (Date.now() < deadline) {
    const st = await readPanel(page);
    if (st.error) return st;
    if (!st.searching && st.uci && st.fen && st.fen !== "\u2014") return st;
    await sleep(250);
  }
  return { error: "timed out waiting for a pick" };
}

/** chess.com shows a promotion picker after the destination click. Queen it. */
async function choosePromotion(page) {
  const box = await page.evaluate(() => {
    const windows = [
      ...document.querySelectorAll(".promotion-window, .promotion-piece, [class*='promotion']"),
    ];
    for (const el of windows) {
      if (!/q/.test(el.className)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  });
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}

async function playMove(page, st, mv) {
  const from = squareCenter(st.rect, st.flipped, mv.from);
  const to = squareCenter(st.rect, st.flipped, mv.to);
  if (!from || !to) throw new Error("board geometry is unusable");

  if (MODE === "click") {
    // Click-move-click: the same two clicks a person makes with "click to move".
    await clickMove(page, st.rect, st.flipped, mv.from, mv.to);
  } else {
    // Drag is the default: it is the gesture that has been verified against the
    // live board, and it does not depend on the site's click-to-move setting.
    await dragMove(page, st.rect, st.flipped, mv.from, mv.to);
  }

  if (mv.promotion) {
    await sleep(200);
    if (!(await choosePromotion(page))) {
      log("promotion picker not found; promote by hand");
    }
  }
}

async function main() {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
  });

  const found = await findBoardPage(browser);
  if (!found) {
    log(`no chess.com tab with the chesscan panel found on port ${PORT}`);
    log("start Chrome with --remote-debugging-port and the extension loaded");
    await browser.disconnect();
    process.exit(1);
  }
  const { page } = found;
  await page.bringToFront();

  const first = await readPanel(page);
  if (SIDE === "both" && !/\/analysis/.test(first.url)) {
    log("--side=both is only for the analysis board; it would play the opponent's moves in a game");
    await browser.disconnect();
    process.exit(1);
  }
  const mine = SIDE === "auto" ? (first.flipped ? "b" : "w") : SIDE;
  const label = mine === "both" ? "both sides (analysis)" : mine === "w" ? "white" : "black";
  log(`page: ${first.url}`);
  log(`playing ${label} · max ${MAX_MOVES} moves${DRY ? " · DRY RUN" : ""}`);

  let played = 0;
  // Waiting for the other side is normal; waiting forever is not. On an
  // analysis board nobody replies, and a game can end mid-loop.
  let lastProgress = Date.now();

  while (played < MAX_MOVES) {
    const st = await waitForPick(page, Date.now() + TIMEOUT);
    if (st.error) {
      log(`stopping: ${st.error}`);
      break;
    }
    if (Date.now() - lastProgress > STALL) {
      log(`stopping: no move for ${Math.round(STALL / 1000)}s (game over, or not our turn)`);
      break;
    }
    if (mine !== "both" && st.turn !== mine) {
      await sleep(600);
      continue;
    }

    const mv = legalMove(st.fen, st.uci);
    if (!mv) {
      log(`refusing ${st.uci}: not legal in ${st.fen}`);
      break;
    }

    log(
      `${played + 1}. ${mv.san} (${st.uci}) ${squareName(mv.from)}->${squareName(mv.to)}` +
        `${mv.promotion ? `=${mv.promotion.toUpperCase()}` : ""}`,
    );
    if (DRY) {
      // Nothing is clicked, so the position never changes. Print the plan for
      // this position and stop; looping would just repeat it.
      break;
    }

    await playMove(page, st, mv);
    played++;
    lastProgress = Date.now();

    // Wait for the board to actually change before reading again. This is the
    // only place that decides whether the move landed: comparing the next read
    // against the new FEN would skip every position we just moved to.
    const deadline = Date.now() + 8000;
    let changed = false;
    while (Date.now() < deadline) {
      const now = await readPanel(page);
      if (!now.error && now.fen !== st.fen) {
        changed = true;
        break;
      }
      await sleep(150);
    }
    if (!changed) {
      log("the board did not accept the move; stopping rather than retrying blind");
      break;
    }
    await sleep(DELAY);
  }

  log(DRY ? "dry run: nothing clicked" : `done: ${played} move${played === 1 ? "" : "s"}`);
  await browser.disconnect();
}

main().catch(err => {
  console.error("[autoplay] failed:", err.message);
  process.exit(1);
});
