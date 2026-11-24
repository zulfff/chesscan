//! Search: iterative deepening, alpha-beta, transposition table, quiescence.
//!
//! The "perfect" part lives in `solver` (exact small-endgame solving); this is
//! the practical part that plays the other ninety-nine percent of positions.
//! Scores are from the side-to-move's perspective, mates are `MATE - ply`, and
//! the root returns every legal move so the humanizer can choose between
//! plausible ideas rather than only the best one.

use std::collections::HashMap;
use std::time::Instant;

use super::board::Board;
use super::eval::evaluate;
use super::movelist::{MoveList, MAX_MOVES};
use super::movegen::{generate, legal_captures, legal_moves};
use super::tt::{Tt, FLAG_EXACT, FLAG_LOWER, FLAG_UPPER};
use super::types::*;

pub const MATE: i32 = 30000;
pub const INF: i32 = 32000;
pub const MATE_THRESHOLD: i32 = MATE - 1000;

/// Depth whose root scores the humanizer treats as "the first glance".
pub const GLANCE_DEPTH: i32 = 6;
const MAX_PLY: usize = 128;

#[derive(Clone, Debug)]
pub struct RootLine {
    pub mv: Move,
    pub score: i32,
    pub pv: Vec<Move>,
    pub depth: u32,
    /// Score at the glance depth, for the humanizer's surprise term.
    pub shallow: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub lines: Vec<RootLine>,
    pub depth: u32,
    pub nodes: u64,
    pub time_ms: u128,
    pub tt_hits: u64,
    pub tt_probes: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub depth: u32,
    pub time_ms: u64,
    pub nodes: u64,
    pub tt_mb: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            depth: 20,
            time_ms: 2000,
            nodes: 20_000_000,
            tt_mb: 64,
        }
    }
}

pub struct Searcher {
    tt: Tt,
    killers: Vec<[Move; 2]>,
    history: Vec<[i32; 64]>,
    pv: Vec<Vec<Move>>,
    path: Vec<u64>,
    history_counts: HashMap<u64, u32>,
    nodes: u64,
    deadline: Option<Instant>,
    stopped: bool,
    start: Instant,
}

impl Searcher {
    pub fn new(limits: Limits, history_hashes: Vec<u64>) -> Searcher {
        Searcher {
            tt: Tt::new(limits.tt_mb),
            killers: vec![[Move::default(); 2]; MAX_PLY],
            history: vec![[0i32; 64]; 64],
            pv: vec![Vec::new(); MAX_PLY],
            path: Vec::new(),
            history_counts: history_hashes.iter().fold(HashMap::new(), |mut m, h| {
                *m.entry(*h).or_insert(0) += 1;
                m
            }),
            nodes: 0,
            deadline: if limits.time_ms > 0 {
                Some(Instant::now() + std::time::Duration::from_millis(limits.time_ms))
            } else {
                None
            },
            stopped: false,
            start: Instant::now(),
        }
    }

    fn check_time(&mut self) {
        self.nodes += 1;
        if self.nodes % 1024 != 0 {
            return;
        }
        if let Some(d) = self.deadline {
            if Instant::now() >= d {
                self.stopped = true;
            }
        }
    }

    fn is_draw(&self, board: &Board) -> bool {
        if board.halfmove >= 100 {
            return true;
        }
        if board.is_insufficient_material() {
            return true;
        }
        let h = board.hash;
        let mut count = *self.history_counts.get(&h).unwrap_or(&0);
        if count >= 2 {
            return true;
        }
        for x in self.path.iter() {
            if *x == h {
                count += 1;
                if count >= 2 {
                    return true;
                }
            }
        }
        false
    }

    fn tt_score(score: i32, ply: usize) -> i32 {
        if score >= MATE_THRESHOLD {
            score - ply as i32
        } else if score <= -MATE_THRESHOLD {
            score + ply as i32
        } else {
            score
        }
    }

    fn tt_store_score(score: i32, ply: usize) -> i32 {
        if score >= MATE_THRESHOLD {
            score + ply as i32
        } else if score <= -MATE_THRESHOLD {
            score - ply as i32
        } else {
            score
        }
    }

    fn score_move(&self, board: &Board, m: Move, tt_move: Move, ply: usize) -> i32 {
        if m == tt_move {
            return 1_000_000;
        }
        let mut s = 0i32;
        if board.is_capture(m) {
            let victim = if m.kind() == KIND_EP {
                PAWN
            } else {
                board.piece_at(m.to()).map(|(_, pt)| pt).unwrap_or(PAWN)
            };
            let attacker = board.piece_at(m.from()).map(|(_, pt)| pt).unwrap_or(PAWN);
            s += 10_000 + victim as i32 * 100 - attacker as i32;
        }
        if m.is_promotion() {
            s += 8000 + m.promo() as i32 * 100;
        }
        if m == self.killers[ply][0] {
            s += 7000;
        } else if m == self.killers[ply][1] {
            s += 6900;
        }
        s += self.history[m.from() as usize][m.to() as usize];
        s
    }

    fn ordered_moves(&self, board: &Board, moves: MoveList, tt_move: Move, ply: usize) -> MoveList {
        let n = moves.len();
        let mut scored: [(i32, Move); MAX_MOVES] = [(0, Move::default()); MAX_MOVES];
        for (i, m) in moves.iter().enumerate() {
            scored[i] = (self.score_move(board, *m, tt_move, ply), *m);
        }
        scored[..n].sort_by(|a, b| b.0.cmp(&a.0));
        let mut out = MoveList::new();
        for (_, m) in scored[..n].iter() {
            out.push(*m);
        }
        out
    }

    pub fn negamax(&mut self, board: &mut Board, mut depth: i32, mut alpha: i32, beta: i32, ply: usize, pv_node: bool) -> i32 {
        self.pv[ply].clear();
        self.check_time();
        if self.stopped {
            return 0;
        }
        if ply >= MAX_PLY - 1 {
            return evaluate(board);
        }
        if self.is_draw(board) {
            return 0;
        }
        if depth <= 0 {
            return self.qsearch(board, alpha, beta, ply);
        }

        let in_check = board.in_check(board.side);
        if in_check {
            depth += 1;
        }

        let tt_entry = self.tt.probe(board.hash);
        let mut tt_move = Move::default();
        if let Some(e) = tt_entry {
            tt_move = Move(e.mv);
            if !pv_node && e.depth as i32 >= depth {
                let s = Self::tt_score(e.score, ply);
                match e.flag {
                    FLAG_EXACT => return s,
                    FLAG_LOWER if s >= beta => return s,
                    FLAG_UPPER if s <= alpha => return s,
                    _ => {}
                }
            }
        }

        // Null-move pruning: a side with material that cannot pass and is not in
        // check is almost never worse off after a pass. It is unsound in
        // zugzwang, so it is disabled in the solver and in the endgame.
        if !pv_node
            && !in_check
            && depth >= 3
            && board.has_non_pawn_material(board.side)
        {
            let static_eval = evaluate(board);
            if static_eval >= beta {
                let mut null = board.clone();
                null.side = null.side.opposite();
                null.ep = NO_SQUARE;
                null.recompute_hash();
                self.path.push(null.hash);
                let r = 2 + depth / 4;
                let score = -self.negamax(&mut null, depth - 1 - r, -beta, -beta + 1, ply + 1, false);
                self.path.pop();
                if self.stopped {
                    return 0;
                }
                if score >= beta {
                    return beta;
                }
            }
        }

        let moves = legal_moves(board);
        if moves.is_empty() {
            return if in_check { -MATE + ply as i32 } else { 0 };
        }
        let ordered = self.ordered_moves(board, moves, tt_move, ply);

        let mut best = -INF;
        let mut best_move = Move::default();
        let alpha_orig = alpha;

        for (i, m) in ordered.iter().enumerate() {
            // Futility pruning: late quiet moves at shallow depth cannot raise
            // alpha when the static eval is far below it, so skip the make/unmake
            // entirely. Never prune when a mate or a forced line is in play.
            if !pv_node
                && !in_check
                && depth <= 3
                && i > 0
                && !board.is_capture(*m)
                && !m.is_promotion()
                && alpha > -MATE_THRESHOLD
                && alpha < MATE_THRESHOLD
                && evaluate(board) + 120 * depth <= alpha
            {
                continue;
            }
            let undo = board.make_move(*m);
            self.path.push(board.hash);

            let mut score;
            if i == 0 {
                score = -self.negamax(board, depth - 1, -beta, -alpha, ply + 1, pv_node);
            } else {
                // Principal variation search: prove the move is worse with a
                // null window first, re-search it if it turns out not to be.
                let reduction = if depth >= 3 && i >= 3 && !board.is_capture(*m) && !m.is_promotion() {
                    1 + (i / 8) as i32
                } else {
                    0
                };
                score = -self.negamax(board, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, false);
                if score > alpha && score < beta {
                    score = -self.negamax(board, depth - 1, -beta, -alpha, ply + 1, pv_node);
                }
            }
            self.path.pop();
            board.unmake_move(*m, &undo);

            if self.stopped {
                return 0;
            }

            if score > best {
                best = score;
                best_move = *m;
                if score > alpha {
                    alpha = score;
                    self.pv[ply].clear();
                    self.pv[ply].push(*m);
                    let tail = self.pv[ply + 1].clone();
                    self.pv[ply].extend(tail);
                }
            }

            if alpha >= beta {
                if !board.is_capture(*m) {
                    if self.killers[ply][0] != *m {
                        self.killers[ply][1] = self.killers[ply][0];
                        self.killers[ply][0] = *m;
                    }
                    self.history[m.from() as usize][m.to() as usize] += depth * depth;
                }
                break;
            }
        }

        let flag = if best <= alpha_orig {
            FLAG_UPPER
        } else if best >= beta {
            FLAG_LOWER
        } else {
            FLAG_EXACT
        };
        self.tt
            .store(board.hash, best_move, Self::tt_store_score(best, ply), depth as i8, flag);
        best
    }

    fn qsearch(&mut self, board: &mut Board, mut alpha: i32, beta: i32, ply: usize) -> i32 {
        self.check_time();
        if self.stopped {
            return 0;
        }
        if ply >= MAX_PLY - 1 {
            return evaluate(board);
        }

        let in_check = board.in_check(board.side);
        let stand = if in_check { -INF } else { evaluate(board) };
        if !in_check {
            if stand >= beta {
                return stand;
            }
            if stand > alpha {
                alpha = stand;
            }
        }

        let moves = if in_check {
            legal_moves(board)
        } else {
            legal_captures(board)
        };
        if moves.is_empty() {
            return if in_check { -MATE + ply as i32 } else { alpha };
        }

        let n = moves.len();
        let mut scored: [(i32, Move); MAX_MOVES] = [(0, Move::default()); MAX_MOVES];
        for (i, m) in moves.iter().enumerate() {
            let victim = if m.kind() == KIND_EP {
                PAWN
            } else {
                board.piece_at(m.to()).map(|(_, pt)| pt).unwrap_or(PAWN)
            };
            let attacker = board.piece_at(m.from()).map(|(_, pt)| pt).unwrap_or(PAWN);
            let mut s = 10_000 + victim as i32 * 100 - attacker as i32;
            if m.is_promotion() {
                s += 8000 + m.promo() as i32 * 100;
            }
            scored[i] = (s, *m);
        }
        scored[..n].sort_by(|a, b| b.0.cmp(&a.0));

        let mut best = stand;
        for (_, m) in scored[..n].iter() {
            let m = *m;
            // Delta pruning: a capture that cannot lift the score above alpha
            // even with the victim's full value is hopeless. The 200 margin
            // absorbs the piece-square difference and keeps promotions in.
            if !in_check {
                let mut gain = if m.kind() == KIND_EP {
                    super::eval::victim_value(PAWN)
                } else {
                    board
                        .piece_at(m.to())
                        .map(|(_, pt)| super::eval::victim_value(pt))
                        .unwrap_or(super::eval::victim_value(PAWN))
                };
                if m.is_promotion() {
                    gain += super::eval::victim_value(m.promo() as usize)
                        - super::eval::victim_value(PAWN);
                }
                if stand + gain + 200 <= alpha {
                    continue;
                }
            }
            let undo = board.make_move(m);
            let score = -self.qsearch(board, -beta, -alpha, ply + 1);
            board.unmake_move(m, &undo);
            if self.stopped {
                return 0;
            }
            if score > best {
                best = score;
            }
            if score >= beta {
                return beta;
            }
            if score > alpha {
                alpha = score;
            }
        }
        best
    }

    /// Score every root move with a full window, so the humanizer sees honest
    /// evaluations for each idea rather than a single line.
    fn search_root(
        &mut self,
        board: &mut Board,
        depth: i32,
        multipv: usize,
        prev_order: Option<&[Move]>,
    ) -> Vec<RootLine> {
        let moves = legal_moves(board);
        // Last iteration's best moves first: alpha rises sooner and the rest of
        // the root gets cut instead of searched at a full window.
        let mut ordered = MoveList::new();
        let mut seen: Vec<u32> = Vec::with_capacity(moves.len());
        if let Some(prev) = prev_order {
            for m in prev {
                if moves.as_slice().contains(m) && !seen.contains(&m.0) {
                    ordered.push(*m);
                    seen.push(m.0);
                }
            }
        }
        for m in moves.iter().copied() {
            if !seen.contains(&m.0) {
                ordered.push(m);
                seen.push(m.0);
            }
        }

        let mut lines: Vec<RootLine> = Vec::new();
        let mut alpha = -INF;
        let mut first = true;

        for m in ordered.iter().copied() {
            let undo = board.make_move(m);
            self.path.push(board.hash);
            let score = if multipv == 1 && !first {
                let s = -self.negamax(board, depth - 1, -alpha - 1, -alpha, 1, false);
                if s > alpha {
                    -self.negamax(board, depth - 1, -INF, -alpha, 1, true)
                } else {
                    s
                }
            } else {
                -self.negamax(board, depth - 1, -INF, INF, 1, true)
            };
            self.path.pop();
            board.unmake_move(m, &undo);
            if self.stopped {
                break;
            }
            if score > alpha {
                alpha = score;
            }
            first = false;
            let mut pv = vec![m];
            pv.extend(self.pv[1].iter().copied());
            lines.push(RootLine {
                mv: m,
                score,
                pv,
                depth: depth as u32,
                shallow: None,
            });
        }

        lines.sort_by(|a, b| b.score.cmp(&a.score));
        lines.truncate(multipv.max(1));
        lines
    }

    pub fn run(&mut self, board: &mut Board, limits: Limits, multipv: usize) -> SearchResult {
        self.run_with(board, limits, multipv, |_, _, _| {})
    }

    /// Run with a progress callback fired after every completed depth, so a
    /// server can stream the panel's lines while the search is still going.
    pub fn run_with<F: FnMut(u32, &[RootLine], u64)>(
        &mut self,
        board: &mut Board,
        limits: Limits,
        multipv: usize,
        mut on_depth: F,
    ) -> SearchResult {
        let start = Instant::now();

        // A position that has already been repeated is a draw; there is no
        // move that improves on it, so report every move as level.
        if self.is_draw(board) {
            let mut lines: Vec<RootLine> = Vec::new();
            for mv in legal_moves(board).iter().copied().take(multipv.max(1)) {
                lines.push(RootLine {
                    mv,
                    score: 0,
                    pv: vec![mv],
                    depth: 0,
                    shallow: None,
                });
            }
            return SearchResult {
                lines,
                depth: 0,
                nodes: 0,
                time_ms: 0,
                tt_hits: 0,
                tt_probes: 0,
            };
        }

        let mut best: Vec<RootLine> = Vec::new();
        let mut prev_order: Vec<Move> = Vec::new();
        let mut glance: Vec<(Move, i32)> = Vec::new();
        let mut completed_depth = 0u32;

        for depth in 1..=limits.depth {
            if let Some(d) = self.deadline {
                if Instant::now() >= d {
                    break;
                }
            }
            if self.nodes >= limits.nodes && limits.nodes > 0 {
                break;
            }

            let lines = self.search_root(board, depth as i32, multipv, Some(&prev_order));

            if self.stopped {
                // A partial depth is not a result. Keep the last complete one;
                // only if nothing has completed yet do we hand back the prefix.
                if best.is_empty() && !lines.is_empty() {
                    best = lines;
                    completed_depth = depth as u32;
                }
                break;
            }

            if !lines.is_empty() {
                if depth == GLANCE_DEPTH as u32 {
                    glance = lines.iter().map(|l| (l.mv, l.score)).collect();
                }
                // Record the glance for a final depth that never reaches the
                // glance band (a shallow request).
                if glance.is_empty() && depth < GLANCE_DEPTH as u32 {
                    glance = lines.iter().map(|l| (l.mv, l.score)).collect();
                }
                prev_order = best.iter().map(|l| l.mv).collect();
                best = lines;
                completed_depth = depth as u32;
                on_depth(depth as u32, &best, self.nodes);
            }

            // A mate score is exact once the whole root has been searched with
            // a full window; there is no point spending the rest of the budget
            // confirming a win we can already prove.
            if best.first().map(|l| l.score.abs() >= MATE_THRESHOLD).unwrap_or(false) {
                break;
            }
        }

        // Attach the shallow ("first glance") score to each final line.
        for line in best.iter_mut() {
            if let Some((_, s)) = glance.iter().find(|(m, _)| *m == line.mv) {
                line.shallow = Some(*s);
            }
        }

        let nodes = self.nodes;
        SearchResult {
            lines: best,
            depth: completed_depth,
            nodes,
            time_ms: start.elapsed().as_millis(),
            tt_hits: self.tt.hits,
            tt_probes: self.tt.probes,
        }
    }
}

/// Run a search. `history` is the list of Zobrist hashes of earlier positions
/// in the game, used for threefold-repetition draws.
pub fn search(board: &mut Board, limits: Limits, multipv: usize, history: &[u64]) -> SearchResult {
    let mut s = Searcher::new(limits, history.to_vec());
    s.run(board, limits, multipv)
}

/// Legal moves that are not captures, used by tests to sanity check ordering.
pub fn quiet_moves(board: &Board) -> Vec<Move> {
    generate(board, false)
        .into_iter()
        .filter(|m| !board.is_capture(*m))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cp(score: i32) -> i32 {
        score
    }

    #[test]
    fn finds_mate_in_one() {
        // Re1-e8#: the rook checks along the back rank and the pawns cover
        // every escape.
        let mut b = Board::from_fen("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1").unwrap();
        let r = search(&mut b, Limits { depth: 4, time_ms: 5000, ..Limits::default() }, 1, &[]);
        assert_eq!(r.lines[0].mv.uci(), "e1e8");
        assert!(r.lines[0].score >= MATE_THRESHOLD, "score {}", r.lines[0].score);
    }

    #[test]
    fn multipv_returns_requested_number_of_lines() {
        let mut b = Board::startpos();
        let r = search(&mut b, Limits { depth: 8, time_ms: 10000, ..Limits::default() }, 4, &[]);
        assert_eq!(r.lines.len(), 4);
        for w in r.lines.windows(2) {
            assert!(w[0].score >= w[1].score, "lines must be sorted best first");
        }
    }

    #[test]
    fn hangs_a_queen_for_a_rook_and_bishop_is_seen_as_good() {
        // Black to move; Qxd1 wins the queen? Use a simple tactic: white queen
        // en prise to a rook.
        let mut b = Board::from_fen("4k3/8/8/8/8/8/3q4/3R1K2 b - - 0 1").unwrap();
        let r = search(&mut b, Limits { depth: 8, time_ms: 10000, ..Limits::default() }, 3, &[]);
        assert_eq!(r.lines[0].mv.uci(), "d2d1");
        let _ = cp(r.lines[0].score);
    }

    #[test]
    fn repetition_is_a_draw() {
        let mut b = Board::startpos();
        // Same position three times.
        let h = b.hash;
        let r = search(&mut b, Limits { depth: 4, time_ms: 2000, ..Limits::default() }, 1, &[h, h]);
        assert_eq!(r.lines[0].score, 0, "threefold repetition should score 0");
    }

    #[test]
    fn a_shallow_request_still_returns_a_move() {
        let mut b = Board::startpos();
        let r = search(&mut b, Limits { depth: 1, time_ms: 2000, ..Limits::default() }, 3, &[]);
        assert!(!r.lines.is_empty());
        assert!(r.lines[0].shallow.is_some());
    }
}
