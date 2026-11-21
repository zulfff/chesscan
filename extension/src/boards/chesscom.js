// chess.com board reader.
//
// Two layouts have shipped over the years: piece elements carry square classes
// (square-52 = file 5, rank 2) or percentage transforms. Both are handled; the
// class form is the one current builds use.

const PIECE_CLASS = /^([wb])([pnbrqk])$/;
const SQUARE_CLASS = /^square-([1-8])([1-8])$/;

function squareFromClasses(el) {
  for (const cls of el.classList) {
    const m = SQUARE_CLASS.exec(cls);
    if (m) return (Number(m[2]) - 1) * 8 + (Number(m[1]) - 1);
  }
  return null;
}

/**
 * Older chess.com builds position pieces with a CSS transform instead of a
 * square class. Both percentage offsets (0..700%) and pixel offsets have
 * shipped. `size` is the width of one square in CSS pixels, used to turn a
 * pixel offset into a file/rank. Returns a board index or null.
 */
export function squareFromTransform(transform, flipped, size) {
  const m = /translate(?:3d)?\(\s*(-?[\d.]+)(px|%)?[,\s]+(-?[\d.]+)(px|%)?/i.exec(
    transform || "",
  );
  if (!m) return null;
  const unitX = m[2] || "px";
  const unitY = m[4] || "px";
  const col = unitX === "%" ? Number(m[1]) / 100 : size ? Number(m[1]) / size : NaN;
  const row = unitY === "%" ? Number(m[3]) / 100 : size ? Number(m[3]) / size : NaN;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;

  const c = Math.round(col);
  const r = Math.round(row);
  // A real square offset lands on an integer cell; a centring transform or a
  // piece mid-animation does not.
  if (Math.abs(col - c) > 0.15 || Math.abs(row - r) > 0.15) return null;
  if (c < 0 || c > 7 || r < 0 || r > 7) return null;

  const file = flipped ? 7 - c : c;
  const rank = flipped ? r : 7 - r;
  return rank * 8 + file;
}

/**
 * chess.com keeps the played moves in `wc-move-list`. The node marked
 * `.selected` is the position shown on the board; its `data-node="0-<ply>"`
 * carries the zero-based ply and its `white-move` / `black-move` class says
 * which side just played. That is the only place the page states the side to
 * move and the real move number outright, so read it instead of inferring.
 * Live games do not mark a selected node; the last move is then the one on the
 * board. Returns `{ ply, turn }` or null when the list is absent or empty.
 */
export function readMoveList(boardEl, doc = document) {
  const lists = Array.from(doc.querySelectorAll("wc-move-list, .move-list"));
  if (!lists.length) return null;

  const id = boardEl?.id || "";
  const visible = l => {
    const r = l.getBoundingClientRect?.();
    return !r || r.width > 0 || r.height > 0;
  };
  const list =
    (id ? lists.find(l => l.getAttribute("board-id") === id) : null) ??
    lists.find(visible) ??
    lists[0];

  const nodes = Array.from(list.querySelectorAll(".node"));
  if (!nodes.length) return null;

  // `.selected` sits on a span inside the node in current builds.
  const marked = list.querySelectorAll(".node.selected, .node .selected");
  const node = marked.length ? marked[marked.length - 1].closest(".node") : nodes[nodes.length - 1];
  if (!node) return null;

  const raw = node.getAttribute("data-node") || "";
  const tail = raw ? Number(raw.split("-").pop()) : NaN;
  const index = Number.isInteger(tail) && tail >= 0 ? tail : nodes.indexOf(node);
  if (index < 0) return null;

  const turn = node.classList.contains("white-move")
    ? "b"
    : node.classList.contains("black-move")
      ? "w"
      : null;
  return { ply: index, turn };
}

export function readChesscom() {
  const boards = Array.from(
    document.querySelectorAll("wc-chess-board, chess-board"),
  );
  let picked = null;
  let bestArea = 0;

  for (const el of boards) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      picked = { el, rect };
    }
  }
  if (!picked) return null;

  const { el, rect } = picked;
  const flipped = el.classList.contains("flipped");
  const pieces = new Array(64).fill(null);

  for (const pieceEl of el.querySelectorAll(".piece")) {
    let color = null;
    let type = null;
    for (const cls of pieceEl.classList) {
      const m = PIECE_CLASS.exec(cls);
      if (m) {
        color = m[1];
        type = m[2];
        break;
      }
    }
    if (!color || !type) continue;

    let sq = squareFromClasses(pieceEl);
    if (sq === null) sq = squareFromTransform(pieceEl.style.transform, flipped, rect.width / 8);
    if (sq === null) continue;
    pieces[sq] = { color, type };
  }

  const lastMove = [];
  for (const hl of el.querySelectorAll(".highlight")) {
    const sq = squareFromClasses(hl);
    if (sq !== null) lastMove.push(sq);
  }

  const moves = readMoveList(el) ?? { ply: null, turn: null };
  return {
    site: "chesscom",
    pieces,
    lastMove,
    flipped,
    rect,
    boardEl: el,
    wrap: el,
    ply: moves.ply,
    moveTurn: moves.turn,
  };
}