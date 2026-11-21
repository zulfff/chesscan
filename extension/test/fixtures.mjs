// DOM fixtures reproducing what chess.com renders.
//
// Two layouts have shipped: piece elements with square classes (square-52 =
// file 5, rank 2) and percentage transforms. The class form is what current
// builds use, and what this fixture renders.

export const SIZE = 480;
export const SQ = SIZE / 8;

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
export const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR";
export const AFTER_E4_E5_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R";
export const CASTLED = "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1";

export function fenPieces(board) {
  const out = [];
  board.split("/").forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      out.push({
        file,
        rank: 7 - r,
        color: ch === ch.toUpperCase() ? "w" : "b",
        type: ch.toLowerCase(),
      });
      file++;
    }
  });
  return out;
}

export function squareIndex(uci) {
  return (Number(uci[1]) - 1) * 8 + "abcdefgh".indexOf(uci[0]);
}

export function lastMoveSquares(last) {
  return last.flatMap(uci => [squareIndex(uci.slice(0, 2)), squareIndex(uci.slice(2, 4))]);
}

/**
 * Served as /fixture.js so it runs under a strict `script-src 'self'` policy
 * too. It makes the fixture board accept click-move-click the way the real one
 * does, and records what it received, so a test can prove that the coordinates
 * the harness computes land on the squares it meant.
 */
export const FIXTURE_JS = `(() => {
  const board = document.getElementById("board-analysis-board");
  if (!board) return;
  const clicks = [];
  const applied = [];
  window.__clicks = clicks;
  window.__applied = applied;
  let sel = null;
  let down = null;

  const sqAt = (x, y) => {
    const r = board.getBoundingClientRect();
    const size = r.width / 8;
    const col = Math.floor((x - r.left) / size);
    const row = Math.floor((y - r.top) / size);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    const flipped = board.classList.contains("flipped");
    return { file: flipped ? 7 - col : col, rank: flipped ? row : 7 - row };
  };
  const cls = c => "square-" + (c.file + 1) + (c.rank + 1);
  const same = (a, b) => a && b && a.file === b.file && a.rank === b.rank;
  const clearMarks = () => {
    for (const e of board.querySelectorAll(".highlight")) e.classList.remove("highlight");
    for (const e of board.querySelectorAll(".mark")) e.remove();
  };
  const mark = c => {
    const d = document.createElement("div");
    d.className = "mark highlight " + cls(c);
    board.appendChild(d);
  };

  function apply(from, to) {
    if (same(from, to)) return;
    const piece = board.querySelector(".piece." + cls(from));
    if (!piece) return;
    const captured = board.querySelector(".piece." + cls(to));
    if (captured) captured.remove();
    piece.classList.remove(cls(from));
    piece.classList.add(cls(to));
    // A real last move marks both squares, the way chess.com does.
    clearMarks();
    mark(from);
    mark(to);
    applied.push({ from, to });
  }

  // Both gestures the real board accepts: click-move-click (two pointerdowns)
  // and drag (down on the source, up on the target).
  board.addEventListener("pointerdown", ev => {
    const sq = sqAt(ev.clientX, ev.clientY);
    if (!sq) return;
    clicks.push(sq);
    down = sq;
    if (!sel) {
      sel = sq;
      // Selecting a piece marks exactly one square, the way chess.com does.
      // It is not a move, and must not be read as one.
      const piece = board.querySelector(".piece." + cls(sq));
      if (piece) piece.classList.add("highlight");
      return;
    }
    clearMarks();
    apply(sel, sq);
    sel = null;
  });

  board.addEventListener("pointerup", ev => {
    const sq = sqAt(ev.clientX, ev.clientY);
    if (down && sq && !same(down, sq)) {
      apply(down, sq);
      sel = null;
    }
    down = null;
  });
})();
`;

export function chesscomHtml(
  board,
  { flipped = false, last = [], moves = [], selected = null, interactive = false } = {},
) {
  const pieces = fenPieces(board);
  const pieceEls = pieces
    .map(
      p =>
        `<div class="piece ${p.color}${p.type} square-${p.file + 1}${p.rank + 1}" style="position:absolute;width:${SQ}px;height:${SQ}px"></div>`,
    )
    .join("\n");
  const highlights = lastMoveSquares(last)
    .map(sq => {
      return `<div class="highlight square-${(sq % 8) + 1}${((sq / 8) | 0) + 1}" style="position:absolute;width:${SQ}px;height:${SQ}px"></div>`;
    })
    .join("\n");
  // The move list is what a real page carries next to the board: one `.node`
  // per ply, `data-node="0-<ply>"`, and `.selected` on the position shown.
  const moveList = moves.length
    ? `<wc-move-list board-id="board-analysis-board" class="analysis-view-movelist move-list">${moves
        .map((san, i) => {
          const side = i % 2 === 0 ? "white" : "black";
          const sel = selected === i ? " selected" : "";
          return `<div data-node="0-${i}" class="node ${side}-move main-line-ply"><span class="node-highlight-content${sel}">${san}</span></div>`;
        })
        .join("")}</wc-move-list>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>chess.com fixture</title></head>
<body style="margin:0;background:#312e2b">
<div style="padding:40px">
  <wc-chess-board id="board-analysis-board" class="board${flipped ? " flipped" : ""}" style="display:block;position:relative;width:${SIZE}px;height:${SIZE}px;background:#eeeed2">
    <div class="pieces">
${pieceEls}
    </div>
${highlights}
  </wc-chess-board>
  ${moveList}
</div>
${interactive ? '<script src="/fixture.js"></script>' : ""}
</body></html>`;
}