//! A chess engine written from scratch for the chesscan server.
//!
//! Board representation, move generation, evaluation, search, an exact
//! small-endgame solver and the humanizer. No UCI, no third-party engine, no
//! borrowed evaluation function.

pub mod board;
pub mod eval;
pub mod humanize;
pub mod movelist;
pub mod movegen;
pub mod search;
pub mod solver;
pub mod tt;
pub mod types;
