//! Generate a synthetic screenshot: board on a page with UI chrome around it.
//! Exists to test board auto-detection without needing a real chess.com window.
//!
//! cargo run --bin make_screen -- /tmp/shot.png [x y size]
//!
//! Pieces are drawn as centre blobs on purpose: they cover the middle of every
//! occupied square, which is exactly what the detector must ignore.

use image::{Rgb, RgbImage};

const W: u32 = 1600;
const H: u32 = 1000;

fn main() -> anyhow::Result<()> {
    let mut a = std::env::args().skip(1);
    let out = a.next().unwrap_or_else(|| "/tmp/opencode/shot.png".into());
    let x: u32 = a.next().unwrap_or_else(|| "620".into()).parse()?;
    let y: u32 = a.next().unwrap_or_else(|| "120".into()).parse()?;
    let size: u32 = a.next().unwrap_or_else(|| "640".into()).parse()?;

    let mut img = RgbImage::from_pixel(W, H, Rgb([32, 34, 40]));
    let board_src = a.next();

    // header bar
    fill(&mut img, 0, 0, W, 48, Rgb([48, 50, 60]));
    // left sidebar: fake list rows
    fill(&mut img, 0, 48, 300, H - 48, Rgb([40, 42, 50]));
    for i in 0..24 {
        let yy = 70 + i * 38;
        fill(&mut img, 16, yy, 260, 24, Rgb([54, 56, 66]));
    }
    // right chat panel
    fill(&mut img, W - 320, 48, 320, H - 48, Rgb([44, 46, 54]));
    for i in 0..20 {
        let yy = 70 + i * 44;
        fill(&mut img, W - 300, yy, 280, 30, Rgb([58, 60, 70]));
    }
    // board frame + grid (skipped when size is 0: negative test case)
    if size > 0 {
        fill(&mut img, x - 12, y - 12, size + 24, size + 24, Rgb([70, 60, 50]));
    }

    // Optional: paste a real board render instead of a synthetic checkerboard.
    if let Some(path) = board_src {
        let b = image::open(&path)?.to_rgb8();
        let b = image::imageops::resize(
            &b,
            size.max(1),
            size.max(1),
            image::imageops::FilterType::Triangle,
        );
        image::imageops::overlay(&mut img, &b, x as i64, y as i64);
        img.save(&out)?;
        println!("wrote {out} (pasted {path} as {size}x{size} at {x},{y})");
        return Ok(());
    }

    // checkerboard
    let light = Rgb([240, 217, 181]);
    let dark = Rgb([181, 136, 99]);
    let cell = size / 8;
    if cell > 0 {
        for r in 0..8u32 {
            for c in 0..8u32 {
                let col = if (r + c) % 2 == 0 { light } else { dark };
                fill(&mut img, x + c * cell, y + r * cell, cell, cell, col);
            }
        }
    }

    // centre blobs: proof that corner sampling works
    for r in 0..8u32 {
        for c in 0..8u32 {
            if r >= 2 && r <= 5 {
                continue; // empty middle ranks
            }
            let cx = x + c * cell + cell / 2;
            let cy = y + r * cell + cell / 2;
            let rad = cell / 3;
            fill(
                &mut img,
                cx - rad,
                cy - rad,
                rad * 2,
                rad * 2,
                Rgb([20, 20, 24]),
            );
        }
    }

    img.save(&out)?;
    println!("wrote {out} (board {size}x{size} at {x},{y})");
    Ok(())
}

fn fill(img: &mut RgbImage, x: u32, y: u32, w: u32, h: u32, c: Rgb<u8>) {
    for yy in y..(y + h).min(img.height()) {
        for xx in x..(x + w).min(img.width()) {
            img.put_pixel(xx, yy, c);
        }
    }
}