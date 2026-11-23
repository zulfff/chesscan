//! Wire protocol.
//!
//! Requests are JSON. Responses are newline-delimited JSON, so the panel can
//! show a line at each depth instead of waiting for the whole search. Every
//! score is from the side-to-move's point of view, which is what the extension
//! already expects from a UCI engine.

use serde::{Deserialize, Serialize};

use crate::chess::search::RootLine;
use crate::chess::search;

#[derive(Deserialize, Debug)]
pub struct AnalyzeRequest {
    pub fen: String,
    #[serde(default = "default_depth")]
    pub depth: u32,
    #[serde(default = "default_multipv")]
    pub multipv: usize,
    #[serde(default)]
    pub time_ms: Option<u64>,
    #[serde(default)]
    pub play: Option<PlayRequest>,
    /// Earlier positions in the game, as FENs, for threefold repetition.
    #[serde(default)]
    pub history: Vec<String>,
    /// Anything stable per position; seeds the humanizer's randomness.
    #[serde(default)]
    pub seed: Option<String>,
    #[serde(default)]
    pub solve_pieces: Option<u32>,
}

fn default_depth() -> u32 {
    18
}

fn default_multipv() -> usize {
    4
}

#[derive(Deserialize, Debug, Clone)]
pub struct PlayRequest {
    /// "off" | "max" | "auto" | a preset name.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub elo: Option<i32>,
    #[serde(default)]
    pub aggression: Option<f64>,
    #[serde(default)]
    pub brilliancy: Option<f64>,
    #[serde(default)]
    pub mistake: Option<f64>,
    #[serde(default)]
    pub ceiling: Option<i32>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ScoreOut {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: i32,
}

#[derive(Serialize, Debug, Clone)]
pub struct LineOut {
    pub uci: String,
    pub pv: Vec<String>,
    pub score: ScoreOut,
    pub depth: u32,
    pub shallow: Option<i32>,
    pub win: f64,
}

#[derive(Serialize, Debug, Clone)]
pub struct PickOut {
    pub uci: String,
    pub reason: String,
    pub cp_loss: i32,
    pub win: f64,
    pub glance_win: f64,
    pub think_ms: u64,
    pub elo: i32,
}

#[derive(Serialize, Debug, Clone)]
pub struct SolverOut {
    pub attempted: bool,
    pub proven: bool,
    pub mate_in: Option<i32>,
    pub nodes: u64,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "info")]
    Info {
        depth: u32,
        lines: Vec<LineOut>,
        nodes: u64,
    },
    #[serde(rename = "done")]
    Done {
        depth: u32,
        lines: Vec<LineOut>,
        pick: Option<PickOut>,
        bestmove: Option<String>,
        proven: bool,
        mate_in: Option<i32>,
        solver: SolverOut,
        nodes: u64,
        time_ms: u128,
        tt_hits: u64,
        tt_probes: u64,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Convert a search score to the UCI-shaped score the panel understands.
pub fn score_out(score: i32) -> ScoreOut {
    if score >= search::MATE_THRESHOLD {
        ScoreOut {
            kind: "mate".into(),
            value: (search::MATE - score + 1) / 2,
        }
    } else if score <= -search::MATE_THRESHOLD {
        ScoreOut {
            kind: "mate".into(),
            value: -((search::MATE + score + 1) / 2),
        }
    } else {
        ScoreOut {
            kind: "cp".into(),
            value: score,
        }
    }
}

pub fn line_out(line: &RootLine) -> LineOut {
    let uci = line.pv.first().map(|m| m.uci()).unwrap_or_default();
    LineOut {
        uci,
        pv: line.pv.iter().map(|m| m.uci()).collect(),
        score: score_out(line.score),
        depth: line.depth,
        shallow: line.shallow,
        win: crate::chess::humanize::win_probability(line.score),
    }
}

pub fn lines_out(lines: &[RootLine]) -> Vec<LineOut> {
    lines.iter().map(line_out).collect()
}

/// Sanitise a request's limits. A client must not be able to pin a worker for
/// a minute with a depth it typed by accident.
pub fn clamp_limits(req: &AnalyzeRequest) -> search::Limits {
    search::Limits {
        depth: req.depth.clamp(1, 30),
        time_ms: req.time_ms.unwrap_or(2000).clamp(200, 30_000),
        nodes: 20_000_000,
        tt_mb: 64,
    }
}

pub fn preset_elo(name: &str) -> Option<i32> {
    match name {
        "casual" => Some(850),
        "club" => Some(1250),
        "solid" => Some(1750),
        "strongClub" => Some(1650),
        "expert" => Some(2000),
        "master" => Some(2300),
        _ => None,
    }
}

/// Recompute the Zobrist hash of each FEN in the game history.
pub fn history_hashes(fens: &[String]) -> Vec<u64> {
    fens.iter()
        .filter_map(|f| crate::chess::board::Board::from_fen(f).ok())
        .map(|b| b.hash)
        .collect()
}
