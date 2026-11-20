//! Generate a synthetic 640x640 board PNG so the pipeline can be tested without
//! a real screen or a real chess UI. Not a renderer -- just distinct ink shapes
//! per piece type so classification has something honest to cluster.
//!
//! cargo run --bin make_board -- /tmp/opencode/board.png

use image::{Rgb, RgbImage};

const SQ: u32 = 80;

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/opencode/board.png".into());
    let mut img = RgbImage::from_pixel(SQ * 8, SQ * 8, Rgb([240, 217, 181]));

    for r in 0..8u32 {
        for f in 0..8u32 {
            if (r + f) % 2 == 1 {
                for y in 0..SQ {
                    for x in 0..SQ {
                        img.put_pixel(f * SQ + x, r * SQ + y, Rgb([181, 136, 99]));
                    }
                }
            }
        }
    }

    // Position: either the standard start, or a FEN placement string as arg 2.
    let fen = std::env::args().nth(2);
    match fen {
        Some(placement) => render_fen(&mut img, &placement)?,
        None => {
            let back = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
            for (f, ch) in back.iter().enumerate() {
                draw_piece(&mut img, f as u32, 0, *ch, true);
                draw_piece(&mut img, f as u32, 7, ch.to_ascii_lowercase(), false);
            }
            for f in 0..8u32 {
                draw_piece(&mut img, f, 1, 'P', true);
                draw_piece(&mut img, f, 6, 'p', false);
            }
        }
    }

    img.save(&path)?;
    println!("wrote {path}");
    Ok(())
}

fn render_fen(img: &mut RgbImage, placement: &str) -> anyhow::Result<()> {
    let ranks: Vec<&str> = placement.split('/').collect();
    anyhow::ensure!(ranks.len() == 8, "FEN placement needs 8 ranks");
    for (i, row) in ranks.iter().enumerate() {
        let rank = 7 - i as u32; // FEN lists rank 8 first
        let mut file = 0u32;
        for ch in row.chars() {
            if let Some(n) = ch.to_digit(10) {
                file += n;
            } else {
                anyhow::ensure!(file < 8, "FEN rank overflows");
                draw_piece(img, file, rank, ch, ch.is_ascii_uppercase());
                file += 1;
            }
        }
        anyhow::ensure!(file == 8, "FEN rank does not fill 8 files");
    }
    Ok(())
}

fn shape(kind: char, u: f32, v: f32) -> bool {
    match kind {
        // pawn: small head on a flared base
        'p' => (u * u + (v - 0.22) * (v - 0.22) < 0.20) || (u.abs() < 0.42 && v > 0.45 && v < 0.85),
        // rook: block with crenellations
        'r' => u.abs() < 0.60 && v.abs() < 0.72 && !(v < -0.34 && u.abs() > 0.18 && u.abs() < 0.38),
        // bishop: tall narrow diamond
        'b' => u.abs() / 0.40 + v.abs() / 0.88 < 1.0,
        // knight: asymmetric head-and-neck silhouette
        'n' => {
            (v > -0.15 && v < 0.85 && u.abs() < 0.45)
                || (v < 0.1 && v > -0.8 && u > -0.55 && u < 0.15)
        }
        // queen: wide body with three spikes
        'q' => {
            (u.abs() < 0.68 && v > -0.25 && v < 0.8)
                || (v < -0.25
                    && v > -0.85
                    && ((u + 0.5).abs() < 0.13 || u.abs() < 0.13 || (u - 0.5).abs() < 0.13))
        }
        // king: tall cross on a base
        'k' => {
            (u.abs() < 0.16 && v.abs() < 0.88)
                || (v.abs() < 0.16 && u.abs() < 0.52)
                || (u.abs() < 0.5 && v > 0.55 && v < 0.88)
        }
        _ => false,
    }
}

fn draw_piece(img: &mut RgbImage, file: u32, rank: u32, piece: char, white: bool) {
    let (fill, edge) = if white {
        (Rgb([250, 250, 245]), Rgb([30, 30, 30]))
    } else {
        (Rgb([25, 25, 28]), Rgb([235, 235, 235]))
    };
    let cx = file as i32 * SQ as i32 + SQ as i32 / 2;
    let cy = (7 - rank) as i32 * SQ as i32 + SQ as i32 / 2;
    let rad = SQ as i32 / 2 - 6;
    let kind = piece.to_ascii_lowercase();

    let at = |dx: i32, dy: i32| shape(kind, dx as f32 / rad as f32, dy as f32 / rad as f32);

    for dy in -rad..=rad {
        for dx in -rad..=rad {
            if !at(dx, dy) {
                continue;
            }
            let border = !at(dx + 1, dy) || !at(dx - 1, dy) || !at(dx, dy + 1) || !at(dx, dy - 1);
            img.put_pixel(
                (cx + dx) as u32,
                (cy + dy) as u32,
                if border { edge } else { fill },
            );
        }
    }
}
