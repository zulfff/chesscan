// Coach window. The recorded tab hides chesscan's arrow and panel; this window
// is a different browser window, so it is not part of the tab capture. It reads
// the panel text the content script mirrors and re-draws what was hidden: a board
// from the FEN with an arrow on the best move.
//
// That is the compromise for "I want to see the arrow but not in the video":
// pixel capture of a surface includes everything on it, so the arrow can only be
// shown outside the captured tab.

const $ = id => document.getElementById(id);
let startedAt = null;

const SIZE = 168;
const CELL = SIZE / 8;
const GLYPH = {
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
};

const mmss = ms => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

// chesscan's `.line .san` holds the whole principal variation ("1. e4 e6 2. …"),
// not one move. The move to play is its first SAN token, whatever colour it is.
const firstSan = pv => {
  if (!pv) return "";
  for (const token of pv.trim().split(/\s+/)) {
    if (/^\d+\.(\.\.)?$/.test(token)) continue;
    return token.replace(/[!?]+$/, "");
  }
  return "";
};

const turnText = turn => (turn === "b" ? "black to move" : turn === "w" ? "white to move" : "");

/** Squares of the mini board. `flipped` mirrors the user's board, which we read
 * off the rank labels because chess.com draws the board as one SVG. */
function squareXY(square, flipped) {
  let col = square.charCodeAt(0) - 97;
  let row = 8 - Number(square[1]);
  if (flipped) {
    col = 7 - col;
    row = 7 - row;
  }
  return [(col + 0.5) * CELL, (row + 0.5) * CELL];
}

function drawBoard(fen, flipped) {
  const grid = $("grid");
  const rows = (fen || "").split(" ")[0].split("/");
  grid.replaceChildren();
  if (rows.length !== 8) {
    $("arrow").replaceChildren();
    return;
  }
  // FEN lists rank 8 first; the display starts at the top row either way.
  const ranks = flipped ? [...rows].reverse() : rows;
  for (let row = 0; row < 8; row += 1) {
    let col = 0;
    const put = () => {
      const el = document.createElement("span");
      el.className = (row + col) % 2 ? "l" : "d";
      el.dataset.square = String.fromCharCode(97 + col) + String(8 - row);
      grid.append(el);
      col += 1;
    };
    for (const ch of ranks[row]) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i += 1) put();
        continue;
      }
      const piece = document.createElement("span");
      piece.className = (row + col) % 2 ? "l" : "d";
      piece.dataset.square = String.fromCharCode(97 + col) + String(8 - row);
      piece.textContent = GLYPH[ch] ?? "";
      grid.append(piece);
      col += 1;
    }
    for (; col < 8; col += 1) put();
  }
}

function drawArrow(uci, flipped) {
  const svg = $("arrow");
  svg.replaceChildren();
  if (!uci || uci.length < 4) return;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const [x1, y1] = squareXY(from, flipped);
  const [x2, y2] = squareXY(to, flipped);

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 9;
  // Stop short of the target centre so the piece stays readable.
  const tail = CELL * 0.34;
  const ex = x2 - Math.cos(angle) * tail;
  const ey = y2 - Math.sin(angle) * tail;

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", ex);
  line.setAttribute("y2", ey);
  line.setAttribute("stroke", "#d7b061");
  line.setAttribute("stroke-width", "5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", "0.92");

  const tip = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const left = `${ex + Math.cos(angle + 2.6) * head},${ey + Math.sin(angle + 2.6) * head}`;
  const right = `${ex + Math.cos(angle - 2.6) * head},${ey + Math.sin(angle - 2.6) * head}`;
  tip.setAttribute("points", `${ex},${ey} ${left} ${right}`);
  tip.setAttribute("fill", "#d7b061");
  tip.setAttribute("opacity", "0.92");

  svg.append(line, tip);
}

function clear() {
  for (const id of ["move", "score", "prob", "turn", "pvline", "fen"]) $(id).textContent = id === "move" ? "—" : "";
  $("alts").replaceChildren();
  $("arrow").replaceChildren();
}

function renderPanel(data) {
  if (!data || !data.present) {
    clear();
    drawBoard(null, false);
    $("hint").textContent = "chesscan panel not found on this board";
    return;
  }

  const lines = data.lines ?? [];
  const best = lines.find(line => line.best) ?? lines[0] ?? null;
  const move = firstSan(best?.san);

  $("move").textContent = move || "—";
  $("score").textContent = best?.score || "";
  $("prob").textContent = data.prob || "";
  $("turn").textContent = turnText(data.turn);
  $("pvline").textContent = best?.san && best.san !== move ? best.san : "";
  $("fen").textContent = data.fen || "";
  $("hint").textContent = data.status || (best ? "" : "waiting for the engine");

  drawBoard(data.fen, !!data.flipped);
  drawArrow(best?.uci, !!data.flipped);

  $("alts").replaceChildren(
    ...lines
      .filter(line => line !== best)
      .slice(0, 3)
      .map(line => {
        const li = document.createElement("li");
        const san = document.createElement("span");
        san.className = "san";
        san.textContent = firstSan(line.san) || line.san;
        const score = document.createElement("span");
        score.textContent = line.score;
        li.append(san, score);
        return li;
      }),
  );
}

function tick() {
  $("time").textContent = startedAt ? mmss(Date.now() - startedAt) : "00:00";
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "coach-panel") renderPanel(msg.data);
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  $("stop").textContent = "Stopping…";
  await chrome.runtime.sendMessage({ type: "recorder-stop" }).catch(() => {});
  window.close();
});

(async () => {
  const res = await chrome.runtime.sendMessage({ type: "coach-hello" }).catch(() => null);
  startedAt = res?.startedAt ?? null;
  renderPanel(res?.panel);
  if (!res?.recording) {
    $("hint").textContent = "not recording";
    $("stop").disabled = true;
  }
  tick();
  setInterval(tick, 500);
})();