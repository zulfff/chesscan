//! Shared library used by both the CLI (`chesscan`) and the desktop app
//! (`chesscan-gui`). All the real work lives here: capture, detection, board
//! reading, engine, overlay.

pub mod capture;
pub mod classify;
pub mod config;
pub mod detect;
pub mod engine;
pub mod fen;
pub mod overlay;
pub mod read;

pub use config::{BoardRect, Config, Prototype};