//! Post-game review.
//!
//! POST /v1/review takes a whole game as a UCI move list, replays it, evaluates
//! every position once with our own search and tags each move by the win
//! probability it cost the player who made it. The point is the report at the
//! end: accuracy per side and the counts of inaccuracies, mistakes and
//! blunders, so the same mistakes can be avoided next time.
//!
//! Every position is searched once. A move is judged by comparing the win
//! probability of the mover's best line in the position before it with the win
//! probability the played move actually left — the next position's search, seen
//! from the other side. That is one search per ply, not two.

use serde::{Deserialize, Serialize};

use crate::chess::board::Board;
use crate::chess::humanize;
use crate::chess::movegen;
use crate::chess::search::{self, Limits};
use crate::chess::types::{Color, Move};

#[derive(Deserialize, Debug)]
pub struct ReviewRequest {
    /// Start position; defaults to the standard game start.
    #[serde(default)]
    pub start: Option<String>,
    /// The game, as UCI moves.
    pub moves: Vec<String>,
    #[serde(default = "default_depth")]
    pub depth: u32,
    #[serde(default = "default_time_ms")]
    pub time_ms: u64,
}

fn default_depth() -> u32 {
    14
}

fn default_time_ms() -> u64 {
    1000
}

const MAX_MOVES: usize = 600;

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ReviewEvent {
    #[serde(rename = "move")]
    Move {
        /// Zero-based ply of the move in the game.
        ply: usize,
        /// The move as it was played.
        uci: String,
        /// What the engine preferred here.
        best: String,
        /// "best" | "good" | "inaccuracy" | "mistake" | "blunder".
        tag: String,
        /// Mover's win probability along the best line.
        win_before: f64,
        /// Mover's win probability after the played move.
        win_after: f64,
        /// win_before - win_after, clamped at zero.
        loss: f64,
        /// Accuracy for this move, 0..100 (the lichess curve).
        accuracy: f64,
        /// Evaluation after the played move, in pawns, from White's view.
        eval_after: f64,
    },
    #[serde(rename = "done")]
    Done {
        plies: usize,
        accuracy: SidePair,
        counts: CountPair,
        /// Why the game is over, when the last position is terminal.
        game_over: Option<String>,
        time_ms: u128,
        nodes: u64,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct SidePair {
    pub white: f64,
    pub black: f64,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct CountPair {
    pub white: Counts,
    pub black: Counts,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Counts {
    pub best: u32,
    pub good: u32,
    pub inaccuracy: u32,
    pub mistake: u32,
    pub blunder: u32,
}

impl Counts {
    fn bump(&mut self, tag: &str) {
        match tag {
            "best" => self.best += 1,
            "good" => self.good += 1,
            "inaccuracy" => self.inaccuracy += 1,
            "mistake" => self.mistake += 1,
            _ => self.blunder += 1,
        }
    }
}

/// Win-probability drop that earns each tag. A fifth of a winning position
/// thrown away is a blunder; a tenth is a mistake; a nudge is an inaccuracy.
const BLUNDER: f64 = 0.20;
const MISTAKE: f64 = 0.10;
const INACCURACY: f64 = 0.04;
/// Below this the played move is the engine's own choice.
const BEST_EPS: f64 = 0.005;

pub fn classify(loss: f64, is_best: bool) -> &'static str {
    if is_best && loss < BEST_EPS {
        "best"
    } else if loss >= BLUNDER {
        "blunder"
    } else if loss >= MISTAKE {
        "mistake"
    } else if loss >= INACCURACY {
        "inaccuracy"
    } else {
        "good"
    }
}

/// Lichess's accuracy curve: a small drop is nearly free, a large one is
/// punished hard. Clamped to 0..100.
pub fn move_accuracy(loss: f64) -> f64 {
    (103.1668 * (-4.3539 * loss.max(0.0)).exp() - 3.1668).clamp(0.0, 100.0)
}

fn limits(req: &ReviewRequest) -> Limits {
    Limits {
        depth: req.depth.clamp(1, 20),
        time_ms: req.time_ms.clamp(100, 5000),
        nodes: 20_000_000,
        tt_mb: 64,
    }
}

fn terminal_state(board: &Board) -> Option<String> {
    if movegen::legal_moves(board).is_empty() {
        return Some(if board.in_check(board.side) {
            if board.side == Color::White {
                "checkmate_white".into()
            } else {
                "checkmate_black".into()
            }
        } else {
            "stalemate".into()
        });
    }
    if board.is_insufficient_material() {
        return Some("insufficient_material".into());
    }
    None
}

/// The UCI move names a move the side to play can actually make: it is matched
/// against the generated legal moves, since parse and generator can disagree
/// on a move's internal kind (a double push, say) while naming the same move.
fn legal_by_uci(board: &Board, uci: &str) -> Result<Move, String> {
    Move::parse_uci(uci).ok_or_else(|| format!("bad UCI move '{uci}'"))?;
    movegen::legal_moves(board)
        .iter()
        .copied()
        .find(|m| m.uci() == uci)
        .ok_or_else(|| format!("illegal move '{uci}'"))
}

/// Replay the move list. Returns the board after the last move plus the reason
/// the game is over, when it is.
pub fn replay(start_fen: Option<&str>, moves: &[String]) -> Result<(Board, Option<String>), String> {
    let mut board = match start_fen {
        Some(fen) => Board::from_fen(fen)?,
        None => Board::from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")?,
    };
    for uci in moves {
        let m = legal_by_uci(&board, uci)?;
        board.make_move(m);
    }
    let over = terminal_state(&board);
    Ok((board, over))
}

/// One position probe: the side to move's win probability, the evaluation from
/// White's view and the engine's choice here. A terminal position is not
/// searched: a mated side scores zero, a dead position a half.
fn probe(board: &mut Board, limits: Limits) -> (f64, f64, String, u64) {
    let stm = board.side;
    if movegen::legal_moves(board).is_empty() {
        if board.in_check(stm) {
            let eval = if stm == Color::White { -100.0 } else { 100.0 };
            return (0.0, eval, String::new(), 0);
        }
        return (0.5, 0.0, String::new(), 0);
    }
    let result = search::search(board, limits, 1, &[]);
    let nodes = result.nodes;
    match result.lines.first() {
        Some(line) => {
            let eval = if stm == Color::White {
                line.score as f64 / 100.0
            } else {
                -line.score as f64 / 100.0
            };
            let best = line.pv.first().map(|mv| mv.uci()).unwrap_or_default();
            (humanize::win_probability(line.score), eval, best, nodes)
        }
        None => (0.5, 0.0, String::new(), nodes),
    }
}

/// Analyse the whole game, reporting one `move` event per ply through `report`.
/// Returns the `done` payload.
pub fn review(
    req: &ReviewRequest,
    mut report: impl FnMut(ReviewEvent),
) -> Result<ReviewEvent, String> {
    if req.moves.len() > MAX_MOVES {
        return Err(format!("at most {MAX_MOVES} moves per review"));
    }
    // Validate the whole game up front, so an illegal move is an error and not
    // a half-finished report.
    let (_, game_over) = replay(req.start.as_deref(), &req.moves)?;
    let mut board = match req.start.as_deref() {
        Some(fen) => Board::from_fen(fen)?,
        None => Board::from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")?,
    };

    let limits = limits(req);
    let mut white = (0.0f64, 0u32);
    let mut black = (0.0f64, 0u32);
    let mut counts = CountPair::default();
    let started = std::time::Instant::now();
    let mut total_nodes = 0u64;

    // Judgement of the move out of the previous position, kept until the new
    // position has been probed: (played uci, mover's win before, mover, best).
    let mut prev: Option<(String, f64, Color, String)> = None;

    // The mover's win probability after the played move is the complement of
    // the new side to move's.
    let mut judge = |prev: &Option<(String, f64, Color, String)>,
                     win_after_stm: f64,
                     eval_white: f64,
                     ply: usize,
                     white: &mut (f64, u32),
                     black: &mut (f64, u32),
                     counts: &mut CountPair| -> Option<ReviewEvent> {
        let (played, win_before, mover, best) = prev.as_ref()?.clone();
        let win_after = 1.0 - win_after_stm;
        let loss = (win_before - win_after).max(0.0);
        let is_best = played == best;
        let tag = classify(loss, is_best);
        let acc = move_accuracy(loss);
        counts.bump(mover, tag);
        let entry = match mover {
            Color::White => white,
            Color::Black => black,
        };
        entry.0 += acc;
        entry.1 += 1;
        Some(ReviewEvent::Move {
            ply,
            uci: played,
            best,
            tag: tag.to_string(),
            win_before,
            win_after,
            loss,
            accuracy: acc,
            eval_after: eval_white,
        })
    };

    for ply in 0..req.moves.len() {
        let uci = req.moves[ply].clone();
        let m = legal_by_uci(&board, &uci)?;

        let (win_here, eval_white, best, nodes) = probe(&mut board, limits);
        total_nodes += nodes;
        if let Some(e) = judge(&prev, win_here, eval_white, ply.saturating_sub(1), &mut white, &mut black, &mut counts) {
            report(e);
        }

        let mover = board.side;
        board.make_move(m);
        prev = Some((uci, win_here, mover, best));
    }

    // The final position decides the last move of the game.
    let (win_final, eval_white, _, nodes) = probe(&mut board, limits);
    total_nodes += nodes;
    if let Some(e) = judge(
        &prev,
        win_final,
        eval_white,
        req.moves.len() - 1,
        &mut white,
        &mut black,
        &mut counts,
    ) {
        report(e);
    }

    let accuracy = SidePair {
        white: avg(white),
        black: avg(black),
    };
    Ok(ReviewEvent::Done {
        plies: req.moves.len(),
        accuracy,
        counts,
        game_over,
        time_ms: started.elapsed().as_millis(),
        nodes: total_nodes,
    })
}

impl CountPair {
    fn bump(&mut self, color: Color, tag: &str) {
        match color {
            Color::White => self.white.bump(tag),
            Color::Black => self.black.bump(tag),
        }
    }
}

fn avg(side: (f64, u32)) -> f64 {
    if side.1 == 0 {
        100.0
    } else {
        side.0 / side.1 as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review_req(moves: &[&str]) -> ReviewRequest {
        ReviewRequest {
            start: None,
            moves: moves.iter().map(|m| m.to_string()).collect(),
            depth: 10,
            time_ms: 300,
        }
    }

    fn moves_of(events: &[ReviewEvent]) -> Vec<&ReviewEvent> {
        events
            .iter()
            .filter(|e| matches!(e, ReviewEvent::Move { .. }))
            .collect()
    }

    #[test]
    fn review_rejects_bad_moves() {
        let err = review(&review_req(&["e2e5"]), |_| {}).unwrap_err();
        assert!(err.contains("illegal"), "{err}");
        let err = review(&review_req(&["notamove"]), |_| {}).unwrap_err();
        assert!(err.contains("bad UCI"), "{err}");
        let mut long = Vec::new();
        for _ in 0..=MAX_MOVES {
            long.push("e2e4".to_string());
        }
        let err = review(
            &ReviewRequest { start: None, moves: long, depth: 10, time_ms: 300 },
            |_| {},
        )
        .unwrap_err();
        assert!(err.contains("at most"), "{err}");
    }

    #[test]
    fn review_reports_scholars_mate() {
        let moves = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];
        let mut events = Vec::new();
        let done = review(&review_req(&moves), |e| events.push(e)).unwrap();
        let ReviewEvent::Done { plies, accuracy, counts, game_over, .. } = done else {
            panic!("expected done event, got {done:?}");
        };
        let judged = moves_of(&events);
        assert_eq!(judged.len(), moves.len(), "one move event per ply");
        assert_eq!(plies, moves.len());
        assert_eq!(game_over.as_deref(), Some("checkmate_black"));
        // Facing Qxf7# costs Black the whole position: a blunder somewhere.
        let black_blunders = judged
            .iter()
            .filter_map(|e| match e {
                ReviewEvent::Move { ply, tag, .. } if *ply % 2 == 1 && tag == "blunder" => Some(ply),
                _ => None,
            })
            .count();
        assert!(black_blunders >= 1, "events: {judged:?}");
        assert!(accuracy.white > accuracy.black, "{accuracy:?}");
        assert!(counts.white.blunder + counts.black.blunder >= 1, "{counts:?}");
        for e in &judged {
            match e {
                ReviewEvent::Move { win_before, win_after, accuracy, .. } => {
                    assert!((0.0..=1.0).contains(win_before));
                    assert!((0.0..=1.0).contains(win_after));
                    assert!((0.0..=100.0).contains(accuracy));
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn review_flags_a_hung_queen_as_whites_blunder() {
        // Without a bishop on c4, Qxf7+ is not mate: Kxf7 wins the queen.
        let moves = ["e2e4", "e7e5", "d1h5", "b8c6", "h5f7", "e8f7"];
        let mut events = Vec::new();
        let done = review(&review_req(&moves), |e| events.push(e)).unwrap();
        let qxf7 = moves_of(&events)
            .into_iter()
            .find_map(|e| match e {
                ReviewEvent::Move { ply: 4, tag, loss, .. } => Some((tag.clone(), *loss)),
                _ => None,
            })
            .expect("ply 4 is judged");
        assert_eq!(qxf7.0, "blunder", "Qxf7+ hangs the queen, loss {}", qxf7.1);
        let kxf7 = moves_of(&events)
            .into_iter()
            .find_map(|e| match e {
                ReviewEvent::Move { ply: 5, tag, .. } => Some(tag.clone()),
                _ => None,
            })
            .expect("ply 5 is judged");
        assert_ne!(kxf7, "blunder", "taking the queen is not a blunder");
        let ReviewEvent::Done { game_over, accuracy, .. } = done else { unreachable!() };
        assert_eq!(game_over, None);
        assert!(accuracy.black > accuracy.white, "{accuracy:?}");
    }

    #[test]
    fn accuracy_curve_matches_the_rule() {
        assert!((move_accuracy(0.0) - 100.0).abs() < 0.01);
        assert!(move_accuracy(1.0) < 10.0, "a thrown game scores near zero");
        assert_eq!(move_accuracy(-0.5), 100.0, "negative loss cannot exceed 100");
    }

    #[test]
    fn classify_thresholds() {
        assert_eq!(classify(0.0, true), "best");
        assert_eq!(classify(0.01, false), "good");
        assert_eq!(classify(0.05, false), "inaccuracy");
        assert_eq!(classify(0.15, false), "mistake");
        assert_eq!(classify(0.30, false), "blunder");
    }

    #[test]
    fn replay_detects_stalemate_and_insufficient_material() {
        let (_, over) = replay(
            Some("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"),
            &[],
        )
        .unwrap();
        assert_eq!(over, Some("stalemate".into()));
        let (_, over) = replay(Some("8/8/8/4k3/8/8/8/4K3 w - - 0 1"), &[]).unwrap();
        assert_eq!(over, Some("insufficient_material".into()));
    }
}
