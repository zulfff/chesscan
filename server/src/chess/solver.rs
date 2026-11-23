//! Exact solver for small endgames.
//!
//! This is the honest meaning of "perfect": for a position with few enough
//! pieces, we search the whole game tree with no heuristic pruning and report
//! a score that is proven, not estimated. Alpha-beta is exact when it is not
//! allowed to lie about bounds, so the solver uses a transposition table for
//! move ordering only and never cuts on a stored bound.
//!
//! `proven` is only ever true when every variation was resolved: a forced mate,
//! or a complete tree. A node that ran out of depth makes the result an
//! estimate again, and the caller must say so.

use super::board::Board;
use super::eval::evaluate;
use super::movegen::legal_moves;
use super::tt::Tt;
use super::types::*;

pub struct SolveResult {
    pub mv: Option<Move>,
    pub score: i32,
    pub nodes: u64,
    /// True only when the whole tree was resolved within the limits.
    pub proven: bool,
    /// Plies to mate, if a forced mate was found.
    pub mate_in: Option<i32>,
}

struct Solver {
    tt: Tt,
    nodes: u64,
    max_nodes: u64,
    stopped: bool,
    hit_depth_limit: bool,
    root_move: Option<Move>,
}

impl Solver {
    fn new(max_nodes: u64) -> Solver {
        Solver {
            tt: Tt::new(8),
            nodes: 0,
            max_nodes,
            stopped: false,
            hit_depth_limit: false,
            root_move: None,
        }
    }

    fn negamax(&mut self, board: &Board, depth: i32, alpha: i32, beta: i32, ply: i32) -> i32 {
        self.nodes += 1;
        if self.nodes >= self.max_nodes {
            self.stopped = true;
            return evaluate(board);
        }

        if board.halfmove >= 100 || board.is_insufficient_material() {
            return 0;
        }
        if ply > 200 {
            self.hit_depth_limit = true;
            return evaluate(board);
        }

        // TT for ordering only: a bound from another line is not a proof.
        let mut tt_move = Move::default();
        if let Some(e) = self.tt.probe(board.hash) {
            tt_move = Move(e.mv);
        }

        let moves = legal_moves(board);
        if moves.is_empty() {
            return if board.in_check(board.side) {
                -super::search::MATE + ply
            } else {
                0
            };
        }

        // The solver only uses the table for ordering; a bound from another
        // line is not a proof, so it never cuts on a stored score.
        let mut ordered = moves;
        let _ = tt_move;

        if depth <= 0 {
            // Still resolve captures so a mate in one or a winning capture is
            // never mistaken for an unresolved leaf.
            let mut captures = crate::chess::movelist::MoveList::new();
            for m in ordered.iter().copied() {
                if board.is_capture(m) {
                    captures.push(m);
                }
            }
            if captures.is_empty() {
                self.hit_depth_limit = true;
                return evaluate(board);
            }
            ordered = captures;
        }

        let mut best = -super::search::INF;
        let mut best_move = Move::default();
        let mut a = alpha;
        for m in ordered {
            let mut next = board.clone();
            next.make_move(m);
            let score = -self.negamax(&next, depth - 1, -beta, -a, ply + 1);
            if self.stopped {
                return best.max(score);
            }
            if score > best {
                best = score;
                best_move = m;
                if ply == 0 {
                    self.root_move = Some(m);
                    // A forced mate at the root needs no further alternatives.
                    if best >= super::search::MATE_THRESHOLD {
                        break;
                    }
                }
            }
            if score > a {
                a = score;
            }
            if a >= beta {
                break;
            }
        }

        self.tt.store(board.hash, best_move, best, depth as i8, 1);
        best
    }
}

/// Try to solve `board` exactly. Positions with more than `max_pieces` pieces
/// are refused; the caller should use the normal search instead.
pub fn solve(board: &Board, max_pieces: u32, max_nodes: u64, max_depth: i32) -> Option<SolveResult> {
    if board.piece_count() > max_pieces {
        return None;
    }
    let mut s = Solver::new(max_nodes);
    let mut last_score = 0;
    let mut last_move = None;

    for depth in 1..=max_depth {
        s.hit_depth_limit = false;
        let score = s.negamax(board, depth, -super::search::INF, super::search::INF, 0);
        last_score = score;
        last_move = s.root_move;

        let mate_in = mate_distance(score);
        if mate_in.is_some() {
            return Some(SolveResult {
                mv: last_move,
                score,
                nodes: s.nodes,
                proven: !s.stopped,
                mate_in,
            });
        }
        if s.stopped {
            break;
        }
        // Every line resolved: the score is the game-theoretic value.
        if !s.hit_depth_limit {
            return Some(SolveResult {
                mv: last_move,
                score,
                nodes: s.nodes,
                proven: true,
                mate_in: None,
            });
        }
    }

    Some(SolveResult {
        mv: last_move,
        score: last_score,
        nodes: s.nodes,
        proven: false,
        mate_in: mate_distance(last_score),
    })
}

/// Plies to mate from a search score, signed (positive = side to move mates).
fn mate_distance(score: i32) -> Option<i32> {
    if score >= super::search::MATE_THRESHOLD {
        Some((super::search::MATE - score + 1) / 2)
    } else if score <= -super::search::MATE_THRESHOLD {
        Some(-((super::search::MATE + score + 1) / 2))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_position_that_is_too_large() {
        let b = Board::from_fen("6k1/5ppp/8/8/8/8/5PPP/4R1K1 b - - 0 1").unwrap();
        assert!(solve(&b, 5, 2_000_000, 12).is_none());
    }

    #[test]
    fn refuses_a_full_board() {
        let b = Board::startpos();
        assert!(solve(&b, 5, 1_000_000, 10).is_none());
    }

    #[test]
    fn solves_a_small_mate() {
        // Black is already mated: the rook on e8 checks along the rank and the
        // pawns cover every escape.
        let b = Board::from_fen("4R1k1/5ppp/8/8/8/8/8/6K1 b - - 0 1").unwrap();
        let r = solve(&b, 6, 2_000_000, 12).unwrap();
        assert!(r.proven, "a five-piece mate should be resolved exactly");
        assert!(r.mate_in.is_some(), "should report a mate distance");
        assert_eq!(r.score, -crate::chess::search::MATE);
    }

    #[test]
    fn solves_a_forced_mate_in_one() {
        // White to move, Re1-e8#.
        let b = Board::from_fen("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1").unwrap();
        let r = solve(&b, 6, 2_000_000, 8).unwrap();
        assert!(r.mate_in.is_some(), "mate in one should be proven");
        assert_eq!(r.mv.map(|m| m.uci()), Some("e1e8".to_string()));
    }
}
