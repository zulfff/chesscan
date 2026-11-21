// Plays a real game against a chess.com bot with the extension loaded.
// After every ply the extension's FEN is compared with an independent DOM read,
// and the panel must keep producing lines and an arrow.
//
// Usage: CHROMIUM=/usr/bin/chromium node test/real-game.mjs [plies]

import puppeteer from "puppeteer-core";
import { Chess } from "chess.js";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enPassantFromDiff } from "../src/turn.js";
import { inferCastling, updateCastling } from "../src/fen.js";
import { dragMove } from "../src/autoplay.js";

const here = dirname(fileURLToPath(import.meta.url));

const FILES = "abcdefgh";
const MAX_PLIES = Number(process.argv[2] || 12);
const BOOK = ["e2e4", "g1f3", "f1c4", "b1c3", "d2d3", "c2c3", "c1e3", "d1d2", "a2a3", "h2h3"];

const dir = "/tmp/chesscan-real-game";
await rm(dir, { recursive: true, force: true });
await cp(new URL("../build/chrome", import.meta.url).pathname, dir, { recursive: true });
const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
manifest.content_scripts[0].matches.push("https://www.chess.com/*");
await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
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

const page = await browser.newPage();
page.on("pageerror", e => console.log("page error:", e.message));

async function boardState() {
  return page.evaluate(() => {
    const b = document.querySelector("wc-chess-board");
    if (!b) return null;
    const pieces = [];
    for (const el of b.querySelectorAll(".piece")) {
      let color = null;
      let type = null;
      let file = null;
      let rank = null;
      for (const c of el.classList) {
        let m;
        if ((m = /^([wb])([pnbrqk])$/.exec(c))) {
          color = m[1];
          type = m[2];
        } else if ((m = /^square-([1-8])([1-8])$/.exec(c))) {
          file = Number(m[1]) - 1;
          rank = Number(m[2]) - 1;
        }
      }
      if (color && type && file !== null) pieces.push({ color, type, file, rank });
    }
    const r = b.getBoundingClientRect();
    // Same source the extension uses: the selected node in the move list.
    const list = document.querySelector("wc-move-list, .move-list");
    const marked = list ? list.querySelectorAll(".node.selected, .node .selected") : [];
    const node = marked.length
      ? marked[marked.length - 1].closest(".node")
      : [...(list?.querySelectorAll(".node") ?? [])].pop();
    const raw = node?.getAttribute("data-node") || "";
    const tail = raw ? Number(raw.split("-").pop()) : NaN;
    return {
      pieces,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      flipped: b.classList.contains("flipped"),
      ply: Number.isInteger(tail) && tail >= 0 ? tail : null,
    };
  });
}

const boardKey = state =>
  state.pieces
    .map(p => `${p.color}${p.type}${p.file}${p.rank}`)
    .sort()
    .join("");

function gridOf(state) {
  const grid = new Array(64).fill(null);
  for (const p of state.pieces) grid[p.rank * 8 + p.file] = { color: p.color, type: p.type };
  return grid;
}

let rights = null;

function fenFrom(state, turn, prev = null) {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const p of state.pieces) grid[p.rank][p.file] = p;
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = grid[rank][file];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) {
        row += empty;
        empty = 0;
      }
      row += p.color === "w" ? p.type.toUpperCase() : p.type;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  // Track rights across moves, the way the extension does, instead of reading
  // them off placement (which would over-report after a king or rook moved).
  rights = prev
    ? updateCastling(rights ?? inferCastling(gridOf(prev)), gridOf(prev), gridOf(state))
    : inferCastling(gridOf(state));
  const ep = prev ? enPassantFromDiff(gridOf(prev), gridOf(state)) : null;
  const epName = ep === null ? "-" : `${FILES[ep % 8]}${((ep / 8) | 0) + 1}`;
  const fullmove = state.ply === null ? 1 : Math.floor(state.ply / 2) + 1;
  return `${rows.join("/")} ${turn} ${rights || "-"} ${epName} 0 ${fullmove}`;
}

const panel = () => {
  const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
  if (!s) return null;
  return {
    fen: s.getElementById("fen").textContent,
    turn: s.getElementById("turn").textContent,
    status: s.getElementById("status").textContent,
    lines: [...s.querySelectorAll(".line:not(.placeholder) .san")].map(e => e.textContent),
    arrow: !!document.getElementById("chesscan-arrow-layer")?.querySelector("svg"),
  };
};

async function readPanel() {
  return page.evaluate(panel);
}

async function waitBoardChange(beforeKey, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last = null;
  let lastChange = 0;
  while (Date.now() < deadline) {
    const state = await boardState();
    const key = boardKey(state);
    if (key !== beforeKey) {
      if (key === last) {
        if (Date.now() - lastChange > 400) return state;
      } else {
        last = key;
        lastChange = Date.now();
      }
    }
    await sleep(150);
  }
  throw new Error("board did not change in time");
}

async function drag(fromSq, toSq) {
  const state = await boardState();
  const sq = s => (Number(s[1]) - 1) * 8 + FILES.indexOf(s[0]);
  await dragMove(page, state.rect, state.flipped, sq(fromSq), sq(toSq));
}

async function waitExtensionFen(fen, timeout = 12000) {
  try {
    await page.waitForFunction(
      expected => {
        const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
        return s && s.getElementById("fen").textContent === expected;
      },
      { timeout },
      fen,
    );
    return true;
  } catch {
    return false;
  }
}

const transcript = [];

try {
  await page.goto("https://www.chess.com/play/computer", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(6000);

  // Marko (300) is preselected in the fixture; the primary button starts the game.
  await page.evaluate(() => {
    const start = [...document.querySelectorAll("button")].find(
      b => /^play$/i.test(b.textContent.trim()) && /cc-button-primary/.test(b.className),
    );
    start?.click();
  });
  await sleep(6000);

  // Wait for the game UI and the extension's first FEN.
  await page.waitForFunction(
    () => {
      const s = document.getElementById("chesscan-ext-root")?.shadowRoot;
      return s && s.getElementById("fen").textContent.includes("KQkq");
    },
    { timeout: 45000 },
  );

  let state = await boardState();
  if (state.pieces.length !== 32) throw new Error(`expected 32 pieces, got ${state.pieces.length}`);
  const ourColor = state.flipped ? "b" : "w";
  console.log(`game started, playing ${ourColor}`);

  const startFen = fenFrom(state, "w");
  if (!(await waitExtensionFen(startFen))) {
    throw new Error(`extension did not show start FEN; panel=${JSON.stringify(await readPanel())}`);
  }
  transcript.push({ ply: 0, fen: startFen, ok: true });
  console.log("ply 0:", startFen);

  let chess = new Chess(startFen);
  let plies = 0;
  let arrowSeen = false;

  while (plies < MAX_PLIES) {
    // If the bot opens (we are black), wait for its first move.
    if (chess.turn() !== ourColor) {
      const beforeState = await boardState();
      const before = boardKey(beforeState);
      const moved = await waitBoardChange(before);
      const fen = fenFrom(moved, ourColor, beforeState);
      const ok = await waitExtensionFen(fen);
      transcript.push({ ply: ++plies, by: "bot", fen, ok, panel: await readPanel() });
      console.log(`ply ${plies} bot: ${fen} ${ok ? "ok" : "MISMATCH"}`);
      if (!ok) throw new Error("extension FEN mismatch after bot move");
      chess = new Chess(fen);
      if (chess.isGameOver()) break;
      continue;
    }

    // Our move: book first, else a random legal non-promotion move.
    const legal = chess.moves({ verbose: true });
    let move = null;
    for (const uci of BOOK) {
      move = legal.find(m => m.from + m.to === uci);
      if (move) break;
    }
    if (!move) {
      const quiet = legal.filter(m => !m.promotion);
      const pool = quiet.length ? quiet : legal;
      move = pool[Math.floor(Math.random() * pool.length)];
    }

    const beforeState = await boardState();
    const before = boardKey(beforeState);
    await drag(move.from, move.to);
    const moved = await waitBoardChange(before);
    const fen = fenFrom(moved, chess.turn() === "w" ? "b" : "w", beforeState);
    const ok = await waitExtensionFen(fen);
    const p = await readPanel();
    if (p?.arrow) arrowSeen = true;
    transcript.push({ ply: ++plies, by: "us", san: move.san, fen, ok, panel: p });
    console.log(`ply ${plies} us ${move.san}: ${fen} ${ok ? "ok" : "MISMATCH"}`);
    if (!ok) throw new Error(`extension FEN mismatch after ${move.san}: ${JSON.stringify(p)}`);
    chess = new Chess(fen);
    if (chess.isGameOver()) break;

    // Bot reply.
    const afterUs = boardKey(moved);
    const replied = await waitBoardChange(afterUs);
    const fenBack = fenFrom(replied, ourColor, moved);
    const okBack = await waitExtensionFen(fenBack);
    const pBack = await readPanel();
    if (pBack?.arrow) arrowSeen = true;
    transcript.push({ ply: ++plies, by: "bot", fen: fenBack, ok: okBack, panel: pBack });
    console.log(`ply ${plies} bot: ${fenBack} ${okBack ? "ok" : "MISMATCH"}`);
    if (!okBack) throw new Error("extension FEN mismatch after bot reply");
    chess = new Chess(fenBack);
    if (chess.isGameOver()) break;
  }

  // The panel must have produced analysis at some point and kept an arrow.
  const finalPanel = await readPanel();
  const analysed = transcript.some(t => (t.panel?.lines?.length || 0) >= 3);
  console.log("analysed lines:", analysed, "arrow seen:", arrowSeen, "final:", JSON.stringify(finalPanel));
  if (!analysed) throw new Error("extension never showed three engine lines");
  if (!arrowSeen && !finalPanel?.arrow) throw new Error("extension never drew the best-move arrow");

  await page.screenshot({ path: join(here, "game-final.png") });
  console.log("\ntranscript:");
  for (const t of transcript) {
    console.log(
      `#${t.ply} ${t.by}${t.san ? " " + t.san : ""} | ${t.ok ? "ok" : "FAIL"} | ${t.fen}`,
    );
  }
  console.log(`\nPASS: ${plies} plies played, extension agreed every time`);
} catch (err) {
  console.error("FAIL:", err.message);
  await page.screenshot({ path: join(here, "game-fail.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}