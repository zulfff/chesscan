//! Screen frame -> board characters, shared by CLI and GUI.

use anyhow::{bail, Result};
use image::RgbImage;

use crate::config::{BoardRect, Config};
use crate::fen;
use crate::{capture, classify, detect};

/// Read all 64 squares into a board array.
pub fn read_board(board: &RgbImage, cfg: &Config) -> Result<fen::Board> {
    let patches = capture::square_patches(board, cfg.white_bottom);
    if patches.len() != 64 {
        bail!("expected 64 squares, got {}", patches.len());
    }
    let mut out = fen::empty_board();
    for ((file, rank), patch) in patches {
        let d = classify::descriptor(&patch);
        // 1.05 sits below half the closest prototype pair (R-B at 2.0) yet above
        // the normal spread across board sizes and highlight states (worst seen:
        // 0.96).
        let piece = classify::classify(&d, &cfg.prototypes, 1.05);
        out[(rank * 8 + file) as usize] = piece;
    }
    Ok(out)
}

/// Kings and sane material, ignoring squares the classifier could not name.
/// Returns how many of the 64 squares it could name, or None if the shape is
/// impossible for a chess position (two kings, no pawn on a back rank, no
/// more than eight pawns or sixteen pieces per side).
fn shape_ok(b: &fen::Board) -> Option<usize> {
    let (mut wk, mut bk) = (0, 0);
    let (mut wp, mut bp) = (0, 0);
    let (mut wtot, mut btot) = (0, 0);
    let mut named = 0;
    for (i, &c) in b.iter().enumerate() {
        let rank = i / 8; // 0 = first rank, 7 = eighth
        match c {
            'K' => {
                wk += 1;
                wtot += 1;
            }
            'k' => {
                bk += 1;
                btot += 1;
            }
            'P' => {
                wp += 1;
                wtot += 1;
                if rank == 0 || rank == 7 {
                    return None;
                }
            }
            'p' => {
                bp += 1;
                btot += 1;
                if rank == 0 || rank == 7 {
                    return None;
                }
            }
            'Q' | 'R' | 'B' | 'N' => wtot += 1,
            'q' | 'r' | 'b' | 'n' => btot += 1,
            '?' => {}
            _ => {}
        }
        if c != '?' {
            named += 1;
        }
    }
    let ok = wk == 1
        && bk == 1
        && wp <= 8
        && bp <= 8
        && wtot >= 2
        && wtot <= 16
        && btot >= 2
        && btot <= 16;
    if ok {
        Some(named)
    } else {
        None
    }
}

/// A position that can actually occur in a game: two kings, nothing
/// unclassified, sane material, and no pawn on a back rank. A random crop can
/// produce a stray `K` and `k`; it cannot produce a consistent army on top of
/// two flat alternating colours.
pub fn plausible(b: &fen::Board) -> bool {
    !b.iter().any(|&c| c == '?') && shape_ok(b).is_some()
}

/// Find the board and prove it is one.
///
/// Nine evenly spaced lines are everywhere: window chrome, wallpaper edges, a
/// spreadsheet, a file manager's icon grid. Locking onto the strongest lattice
/// alone used to pick those, crop a rectangle of desktop and then every square
/// read as `?` — which surfaced as "classifier needs recalibration" while the
/// classifier was fine. Every candidate is therefore cropped and read, and the
/// first one that looks like a chess position wins.
///
/// On a first run there are no prototypes to read with, so the strongest
/// lattice is accepted and calibration takes it from there.
pub fn detect_board(frame: &RgbImage, cfg: &Config) -> Result<BoardRect> {
    let cands = detect::find_boards(frame);
    if cands.is_empty() {
        bail!("no chessboard found; is the board fully visible?");
    }
    if cfg.prototypes.is_empty() {
        return Ok(cands[0]);
    }
    // A tooltip, a stream alert or a file manager floating over two squares
    // should not make detection fail outright: keep the most complete legal
    // shape seen and accept it if it is nearly all there. The scan loop recovers
    // by itself once the obstruction moves away.
    let mut partial: Option<(BoardRect, usize)> = None;
    for rect in &cands {
        let Ok(crop) = capture::crop(frame, rect) else {
            continue;
        };
        if let Ok(b) = read_board(&crop, cfg) {
            if let Some(named) = shape_ok(&b) {
                if named == 64 {
                    return Ok(*rect);
                }
                if partial.map_or(true, |(_, best)| named > best) {
                    partial = Some((*rect, named));
                }
            }
        }
    }
    if let Some((rect, named)) = partial {
        if named >= 60 {
            return Ok(rect);
        }
    }
    // Nothing validated. If the strongest grid still looks like a board (two
    // flat alternating colours), assume a theme we have not calibrated yet and
    // hand it back: calibration is how the user teaches it, and refusing here
    // would make a theme change impossible to recover from in the UI.
    if let Some(rect) = cands.first() {
        if let Ok(crop) = capture::crop(frame, rect) {
            let (share, dist) = detect::two_tone(&crop);
            if share >= 0.45 && dist >= 40.0 {
                return Ok(*rect);
            }
        }
    }
    bail!("found grid lines but no chess pieces in them; move the board fully into view or recalibrate")
}

/// Human-readable board for terminal/debug output.
pub fn print_board(b: &fen::Board) {
    for rank in (0..8u32).rev() {
        print!(" {} ", rank + 1);
        for file in 0..8u32 {
            let c = b[(rank * 8 + file) as usize];
            print!("{} ", if c == '.' { '.' } else { c });
        }
        println!();
    }
    println!("   a b c d e f g h");
}

pub fn placement_of(b: &fen::Board) -> String {
    b.iter().collect()
}