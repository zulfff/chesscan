//! Automatic chess board detection.
//!
//! Colour-parity detection was my first attempt and it is the wrong instinct:
//! it breaks the moment a piece covers more than half a square, and it breaks
//! again when the user changes board theme. Looking at how this is actually done
//! (MilanWhite/chessboard-detection-opencv, Elucidation/tensorflow_chessbot,
//! ARChessAnalyzer) the robust signal is the **grid lines**:
//!
//!   * a board is 8x8 squares, therefore 9 horizontal and 9 vertical lines
//!   * those lines are long, straight, and evenly spaced
//!   * that is true for every theme, every piece set, every colour scheme
//!   * OpenCV's own docs note that `findChessboardCorners` fails when pieces
//!     are present, which is exactly why contour/Hough approaches exist
//!
//! So: build a row profile of horizontal edge energy and a column profile of
//! vertical edge energy, find peaks in each, then search for the 9-peak lattice
//! with equal spacing. Spacing must match within a few percent on both axes,
//! because a board is square.

use image::RgbImage;

use crate::config::BoardRect;

struct Gray {
    w: usize,
    h: usize,
    p: Vec<u8>,
}

impl Gray {
    fn from_rgb(img: &RgbImage) -> Self {
        let (w, h) = (img.width() as usize, img.height() as usize);
        let mut p = Vec::with_capacity(w * h);
        for px in img.pixels() {
            // Rec.601 integer luma.
            p.push(((px[0] as u32 * 77 + px[1] as u32 * 150 + px[2] as u32 * 29) >> 8) as u8);
        }
        Gray { w, h, p }
    }

    #[inline]
    fn at(&self, x: usize, y: usize) -> u8 {
        self.p[y.min(self.h - 1) * self.w + x.min(self.w - 1)]
    }
}

const EDGE_T: i32 = 22;

/// Per-row count of pixels that sit on a vertical colour change. Peaks here are
/// horizontal grid lines.
fn h_profile(g: &Gray) -> Vec<u32> {
    let mut prof = vec![0u32; g.h];
    for y in 1..g.h - 1 {
        let mut n = 0;
        for x in 1..g.w - 1 {
            let dy = g.at(x, y + 1) as i32 - g.at(x, y - 1) as i32;
            if dy.abs() > EDGE_T {
                n += 1;
            }
        }
        prof[y] = n;
    }
    prof
}

/// Per-column count of pixels on a horizontal colour change.
fn v_profile(g: &Gray) -> Vec<u32> {
    let mut prof = vec![0u32; g.w];
    for x in 1..g.w - 1 {
        let mut n = 0;
        for y in 1..g.h - 1 {
            let dx = g.at(x + 1, y) as i32 - g.at(x - 1, y) as i32;
            if dx.abs() > EDGE_T {
                n += 1;
            }
        }
        prof[x] = n;
    }
    prof
}

/// Local maxima above a floor. The floor is a fraction of the image dimension,
/// so a long board edge dominates short UI lines.
fn peaks(prof: &[u32], floor: u32) -> Vec<(usize, u32)> {
    let mut out = Vec::new();
    for i in 1..prof.len().saturating_sub(1) {
        if prof[i] >= floor && prof[i] >= prof[i - 1] && prof[i] >= prof[i + 1] {
            // Collapse a plateau to its strongest pixel.
            if let Some(last) = out.last() {
                let (lp, _): (usize, u32) = *last;
                if i - lp <= 2 {
                    if prof[i] > prof[lp] {
                        out.pop();
                        out.push((i, prof[i]));
                    }
                    continue;
                }
            }
            out.push((i, prof[i]));
        }
    }
    out
}

/// Search for 9 evenly spaced peaks. This is the board: 8 squares, 9 lines.
/// Returns every valid lattice (start, spacing, score), best first. Returning
/// only the single best per axis is a trap: periodic UI clutter (text rows,
/// scrollbars, another window's grid) can outscore the board on one axis, and
/// the squareness check then rejects the whole frame even though the true
/// board lattice exists further down the list. The axes must be matched
/// jointly, in `find_board`.
fn lattices(cands: &[(usize, u32)], min_sp: f32, max_sp: f32) -> Vec<(f32, f32, f32)> {
    let mut out: Vec<(f32, f32, f32)> = Vec::new();

    for i in 0..cands.len() {
        for j in (i + 1)..cands.len() {
            let span = cands[j].0 as f32 - cands[i].0 as f32;
            if span <= 0.0 {
                continue;
            }
            let sp = span / 8.0;
            if sp < min_sp || sp > max_sp {
                continue;
            }
            // Every one of the nine lines must actually be there. min strength,
            // not sum: one missing line means this is not a board.
            // Tolerance scales with spacing: sites render squares at fractional
            // CSS pixels, so per-line rounding accumulates to ~3px drift across
            // a 740px board. A fixed ±2px vetoed the whole lattice over that.
            let tol = (sp * 0.035).max(2.0);
            let mut min_strength = u32::MAX;
            let mut all = true;
            for k in 0..9 {
                let want = cands[i].0 as f32 + k as f32 * sp;
                let mut hit = 0u32;
                for (pos, strength) in cands {
                    if (*pos as f32 - want).abs() <= tol && *strength > hit {
                        hit = *strength;
                    }
                }
                if hit == 0 {
                    all = false;
                    break;
                }
                min_strength = min_strength.min(hit);
            }
            if !all {
                continue;
            }
            out.push((cands[i].0 as f32, sp, min_strength as f32));
        }
    }
    out.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(32);
    out
}

/// How strongly a crop looks like a chessboard: a board is dominated by two
/// flat colours (the light and dark squares) that are clearly distinct. A
/// wallpaper gradient, a wall of text and window chrome fail one or both.
/// Returns (share of the two most populated quantised colours, distance between
/// them). Cheap: 4-bit bins, every other pixel.
pub fn two_tone(img: &RgbImage) -> (f32, f32) {
    // 16 levels per channel.
    let mut bins = vec![(0u32, [0u64; 3]); 4096];
    let mut total = 0u32;
    let mut y = 0;
    while y < img.height() {
        let mut x = 0;
        while x < img.width() {
            let p = img.get_pixel(x, y);
            let key = ((p[0] as usize >> 4) << 8) | ((p[1] as usize >> 4) << 4) | (p[2] as usize >> 4);
            let b = &mut bins[key];
            b.0 += 1;
            b.1[0] += p[0] as u64;
            b.1[1] += p[1] as u64;
            b.1[2] += p[2] as u64;
            total += 1;
            x += 2;
        }
        y += 2;
    }
    let total = total.max(1) as f32;
    let mut best: Vec<(u32, [f32; 3])> = bins
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, s)| {
            let count = *n;
            let nf = count as f32;
            (count, [s[0] as f32 / nf, s[1] as f32 / nf, s[2] as f32 / nf])
        })
        .collect();
    best.sort_by(|a, b| b.0.cmp(&a.0));
    let first = best.first().copied().unwrap_or((0, [0.0; 3]));
    let second = best.get(1).copied().unwrap_or(first);
    let share = (first.0 + second.0) as f32 / total;
    let dist = {
        let (r, g, b) = (
            first.1[0] - second.1[0],
            first.1[1] - second.1[1],
            first.1[2] - second.1[2],
        );
        (r * r + g * g + b * b).sqrt()
    };
    (share, dist)
}

/// Locate every candidate board in a screenshot, best first.
///
/// A lattice only proves that nine evenly spaced lines exist. Window chrome,
/// wallpaper edges and spreadsheet grids produce those too, so callers that
/// want a real board must validate the crop (see `read::detect_board`).
/// Returns the inner 8x8 play areas; frames and coordinate borders are excluded
/// because they are not part of the grid.
pub fn find_boards(img: &RgbImage) -> Vec<BoardRect> {
    let g = Gray::from_rgb(img);
    let dbg = std::env::var("CHESSCAN_DEBUG").is_ok();
    if g.w.min(g.h) < 160 {
        return Vec::new();
    }

    let hprof = h_profile(&g);
    let vprof = v_profile(&g);

    // A grid line spans most of the board. Require it to cover at least 8% of the
    // full image dimension before it is even considered.
    let hfloor = (g.w as u32 / 12).max(24);
    let vfloor = (g.h as u32 / 12).max(24);
    let hp = peaks(&hprof, hfloor);
    let vp = peaks(&vprof, vfloor);

    if dbg {
        eprintln!("h peaks: {:?}", hp.iter().take(48).collect::<Vec<_>>());
        eprintln!("v peaks: {:?}", vp.iter().take(48).collect::<Vec<_>>());
    }

    let min_sp = 14.0;
    let max_sp = (g.w.min(g.h) as f32) / 8.0 + 1.0;

    let hl = lattices(&hp, min_sp, max_sp);
    let vl = lattices(&vp, min_sp, max_sp);

    if dbg {
        eprintln!("h lattices: {:?}", &hl[..hl.len().min(5)]);
        eprintln!("v lattices: {:?}", &vl[..vl.len().min(5)]);
    }

    // A board is square: both axes must have the same square size. Match the
    // axes jointly and keep every agreeing pair, so clutter winning on one axis
    // cannot veto the real board on the other.
    let mut pairs: Vec<(f32, f32, f32, f32)> = Vec::new(); // score, y, x, spacing
    for a in &hl {
        for b in &vl {
            let ratio = a.1 / b.1;
            if !(0.92..=1.08).contains(&ratio) {
                continue;
            }
            let sc = a.2.min(b.2);
            pairs.push((sc, a.0, b.0, (a.1 + b.1) / 2.0));
        }
    }
    pairs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // A detected peak is one pixel of the transition, not the boundary itself:
    // the colour flips between `peak` and `peak + 1`, so both pixels can score
    // equally and the low side wins the tie. The play area starts at the first
    // board pixel, i.e. half a pixel past the peak. Ignoring that leaves every
    // square one pixel out of phase with the calibration crop, and subtle
    // pieces (a knight against a rook) drift to the rejection threshold when
    // the rect is re-detected later. Round(peak + 0.5) is the boundary.
    let mut out: Vec<(f32, BoardRect)> = Vec::new(); // strength, rect
    for (score, y0, x0, sp) in pairs {
        let x = (x0 + 0.5).round().max(0.0) as usize;
        let y = (y0 + 0.5).round().max(0.0) as usize;
        let size = (sp * 8.0).round() as usize;
        if size < 120 || x + size > g.w || y + size > g.h {
            continue;
        }
        // Neighbouring peaks can describe the same board; keep the strongest.
        if out.iter().any(|(_, o)| {
            (o.x as i64 - x as i64).abs() <= 2
                && (o.y as i64 - y as i64).abs() <= 2
                && (o.w as i64 - size as i64).abs() <= 4
        }) {
            continue;
        }
        if dbg {
            eprintln!("lattice: x={x} y={y} size={size} spacing={sp:.1} score={score:.0}");
        }
        out.push((
            score,
            BoardRect {
                x: x as u32,
                y: y as u32,
                w: size as u32,
                h: size as u32,
            },
        ));
        if out.len() >= 64 {
            break;
        }
    }

    // Rank by chess evidence before returning: a real board is two flat,
    // clearly distinct colours, and that is what tells it apart from a text
    // lattice or a wallpaper edge that also happens to score well on edges.
    let mut ranked: Vec<(bool, f32, BoardRect)> = out
        .into_iter()
        .map(|(strength, r)| {
            let crop = image::imageops::crop_imm(img, r.x, r.y, r.w, r.h).to_image();
            let (share, dist) = two_tone(&crop);
            let pass = share >= 0.45 && dist >= 40.0;
            if dbg {
                eprintln!(
                    "candidate {}x{} at {},{} strength={strength:.0} share={share:.2} dist={dist:.0} {}",
                    r.w, r.h, r.x, r.y,
                    if pass { "PASS" } else { "reject" }
                );
            }
            (pass, strength, r)
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    ranked.truncate(24);
    ranked.into_iter().map(|(_, _, r)| r).collect()
}

/// The single best lattice, unvalidated. Prefer `read::detect_board`, which
/// checks that the crop actually contains chess pieces.
pub fn find_board(img: &RgbImage) -> Option<BoardRect> {
    find_boards(img).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    /// 8x8 checkerboard at an arbitrary native size.
    fn checkerboard(w: u32, h: u32) -> RgbImage {
        let mut img = RgbImage::from_pixel(w, h, Rgb([240, 217, 181]));
        for y in 0..h {
            for x in 0..w {
                if ((x * 8 / w) + (y * 8 / h)) % 2 == 1 {
                    img.put_pixel(x, y, Rgb([181, 136, 99]));
                }
            }
        }
        img
    }

    #[test]
    fn finds_the_play_area_exactly() {
        // The rect must start on the first board pixel, not one pixel early:
        // calibration and scanning both crop with this rect, and a one-pixel
        // phase shift between them pushes pieces toward the reject threshold.
        let mut page = RgbImage::from_pixel(520, 420, Rgb([32, 34, 40]));
        image::imageops::overlay(&mut page, &checkerboard(320, 320), 37, 51);
        let r = find_board(&page).expect("board should be found");
        assert_eq!((r.x, r.y, r.w, r.h), (37, 51, 320, 320));
    }

    #[test]
    fn accepts_non_square_screens() {
        let mut page = RgbImage::from_pixel(1400, 700, Rgb([32, 34, 40]));
        image::imageops::overlay(&mut page, &checkerboard(480, 480), 900, 110);
        let r = find_board(&page).expect("board should be found");
        assert_eq!((r.x, r.y, r.w, r.h), (900, 110, 480, 480));
    }

    #[test]
    fn rejects_a_page_without_a_board() {
        let page = RgbImage::from_pixel(520, 420, Rgb([32, 34, 40]));
        assert!(find_board(&page).is_none());
    }

    #[test]
    fn two_tone_separates_a_board_from_noise() {
        let cb = checkerboard(320, 320);
        let (share, dist) = two_tone(&cb);
        assert!(share > 0.9, "share {share}");
        assert!(dist > 60.0, "dist {dist}");
        let flat = RgbImage::from_pixel(320, 320, Rgb([40, 41, 45]));
        let (_, d2) = two_tone(&flat);
        assert!(d2 < 2.0, "flat dist {d2}");
    }
}