//! Turning pixels into pieces.
//!
//! The naive approach is template matching against a sprite sheet. It works on
//! exactly one theme, breaks at any other DPI, and dies when a site ships a new
//! piece set. Instead we estimate the *background* of each square locally, mask
//! out whatever is not background, and describe the resulting silhouette plus
//! ink colour. That descriptor is roughly theme independent: a knight is a horse
//! shape whether it is ivory on walnut or blue on grey.
//!
//! Then we cluster 64 descriptors with k-means once per theme, you label the
//! clusters by typing 13 characters, and the prototypes live in config forever.

use image::RgbImage;

use crate::config::Prototype;

/// Descriptor layout: [0..64) 8x8 ink-coverage grid, [64..67) ink RGB,
/// [67] ink luma relative to the square background, [68] edge hardness.
pub const DIMS: usize = 69;

const GRID: usize = 8;

/// Colour quantisation for the per-square histogram: 16 levels per channel.
const QSHIFT: u32 = 4;

fn rgb_dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (r, g, bl) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    (r * r + g * g + bl * bl).sqrt()
}

/// Canonical patch size. Descriptors must compare across board sizes: a king's
/// cross is ~3px wide on a 112px square but ~2px on a 92px one, and the raw 8x8
/// coverage grid bins those differently, so prototypes learned on a big board
/// misread the same piece on a small one. Resampling every patch to one size
/// first makes thin features average out the same way at any scale.
const CANON: u32 = 96;

/// Below this ink coverage a square is empty. Real piece art covers 8-70% of a
/// square; coordinate labels and edge bleed sit around 2%, so 4% separates them
/// without ever eating a real piece.
pub const EMPTY_INK: f32 = 0.04;

/// Background colour of one square, sampled from its four corners.
///
/// Every earlier attempt estimated the square's background from its dominant
/// colour, and every one of them broke when a piece covered more than half the
/// square: the "background" flipped to the piece, and the descriptor described
/// the board left around the piece instead of the piece. Corners fix that
/// structurally — chess piece art is centred and never reaches them — and they
/// also absorb board tints: after a move chess.com paints the last-move squares
/// yellow, and corners simply report the tinted colour as the background.
fn corner_background(patch: &RgbImage, x0: usize, y0: usize, w: usize, h: usize) -> [f32; 3] {
    let cw = ((w as f32 * 0.22) as usize).clamp(2, w.max(2));
    let ch = ((h as f32 * 0.22) as usize).clamp(2, h.max(2));
    let mut r: Vec<u8> = Vec::with_capacity(4 * cw * ch);
    let mut g: Vec<u8> = Vec::with_capacity(4 * cw * ch);
    let mut b: Vec<u8> = Vec::with_capacity(4 * cw * ch);
    let corners = [
        (x0, y0),
        (x0 + w - cw, y0),
        (x0, y0 + h - ch),
        (x0 + w - cw, y0 + h - ch),
    ];
    for (cx, cy) in corners {
        for yy in cy..(cy + ch).min(y0 + h) {
            for xx in cx..(cx + cw).min(x0 + w) {
                let p = patch.get_pixel(xx as u32, yy as u32);
                r.push(p[0]);
                g.push(p[1]);
                b.push(p[2]);
            }
        }
    }
    // Median, not mean: a coordinate label or a stray antialiased edge in one
    // corner must not drag the estimated background.
    let med = |v: &mut Vec<u8>| -> f32 {
        v.sort_unstable();
        v[v.len() / 2] as f32
    };
    [med(&mut r), med(&mut g), med(&mut b)]
}

pub fn descriptor(patch: &RgbImage) -> Vec<f32> {
    let canon = image::imageops::resize(patch, CANON, CANON, image::imageops::FilterType::Triangle);
    let patch = &canon;
    // Ignore the outer 12% of the square. Detection and cropping are only
    // accurate to a pixel or two, grid lines bleed into cell borders, and UI
    // chrome can overlap the outermost file (a browser scrollbar clipped the
    // h-file in testing). Chess piece art sits well inside the square, so a
    // deeper inset keeps the whole silhouette while dropping all of that.
    let (fw, fh) = (patch.width().max(1), patch.height().max(1));
    let ix = ((fw as f32 * 0.12) as u32).min(fw / 2);
    let iy = ((fh as f32 * 0.12) as u32).min(fh / 2);
    let w = (fw - 2 * ix).max(1) as usize;
    let h = (fh - 2 * iy).max(1) as usize;
    let x0 = ix as usize;
    let y0 = iy as usize;

    // --- ink mask: anything far from this square's own background ---
    // The background comes from the corners, so highlights and board tints are
    // included automatically. White on cream is the hardest pair (~50 apart),
    // black on green ~80; 30 separates both while ignoring antialiasing.
    let bg = corner_background(patch, x0, y0, w, h);
    let mut cov = [0f32; GRID * GRID];
    let mut cnt = [0f32; GRID * GRID];
    let mut ink_px = 0f32; // masked pixel count, for the RMS edge hardness
    let mut ink_sq = 0f32;
    // Modal colour of the masked pixels: the piece's body. A weighted mean is
    // useless here — a white king's drop shadow and dark outline are few pixels
    // with huge square-colour distance, and they dragged the mean down to grey,
    // where it collided with a black king's descriptor.
    let mut mbins = std::collections::HashMap::<u32, (u32, [u64; 3])>::new();

    for yy in 0..h {
        for xx in 0..w {
            let p = patch.get_pixel((x0 + xx) as u32, (y0 + yy) as u32);
            let c = [p[0] as f32, p[1] as f32, p[2] as f32];
            let gx = (xx * GRID) / w;
            let gy = (yy * GRID) / h;
            let cell = (gy.min(GRID - 1)) * GRID + gx.min(GRID - 1);
            cnt[cell] += 1.0;

            let dsq = rgb_dist(c, bg);
            if dsq > 30.0 {
                cov[cell] += 1.0;
                ink_sq += dsq * dsq;
                ink_px += 1.0;
                let key = ((p[0] as u32 >> QSHIFT) << 8)
                    | ((p[1] as u32 >> QSHIFT) << 4)
                    | (p[2] as u32 >> QSHIFT);
                let e = mbins.entry(key).or_insert((0, [0; 3]));
                e.0 += 1;
                e.1[0] += p[0] as u64;
                e.1[1] += p[1] as u64;
                e.1[2] += p[2] as u64;
            }
        }
    }

    let mut out = Vec::with_capacity(DIMS);
    for i in 0..GRID * GRID {
        out.push(if cnt[i] > 0.0 { cov[i] / cnt[i] } else { 0.0 });
    }

    if ink_px > 0.0 {
        let [r, g, b] = mbins
            .values()
            .max_by_key(|(n, _)| *n)
            .map(|(n, s)| {
                let n = (*n).max(1) as f32;
                [s[0] as f32 / n, s[1] as f32 / n, s[2] as f32 / n]
            })
            .unwrap_or([0.0; 3]);
        // Colour dims are weighted up: 64 shape dims otherwise drown out the one
        // signal that separates a white knight from a black one.
        const CW: f32 = 2.5;
        out.push(r / 255.0 * CW);
        out.push(g / 255.0 * CW);
        out.push(b / 255.0 * CW);
        // Absolute ink luma, independent of which square it stands on.
        out.push((r * 0.299 + g * 0.587 + b * 0.114) / 255.0 * CW);
        // Edge hardness: RMS distance of masked pixels from the square colours,
        // i.e. how solidly the ink stands out. Flat art vs outlined art.
        out.push((ink_sq / ink_px).sqrt().min(255.0) / 255.0);
    } else {
        out.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0]);
    }
    // Below the classifier's own empty threshold this square is empty for every
    // downstream purpose. Return the exact empty point, so a near-empty sliver
    // of board edge cannot steal one of the 13 calibration clusters from a real
    // piece type and force two pieces to share a prototype.
    if ink_fraction(&out) < EMPTY_INK {
        return vec![0.0; DIMS];
    }
    out
}

pub fn ink_fraction(d: &[f32]) -> f32 {
    d[..64].iter().sum::<f32>() / 64.0
}

/// Ink colour recorded in the descriptor, back in 0-255.
pub fn ink_rgb(d: &[f32]) -> [f32; 3] {
    [d[64] / 2.5 * 255.0, d[65] / 2.5 * 255.0, d[66] / 2.5 * 255.0]
}

pub fn dist(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt()
}

/// Nearest prototype and its distance, no rejection. Used by `classify` and by
/// `--dump-squares`, which needs the raw distance to tell a rescaling problem
/// from a genuinely unknown piece.
pub fn nearest(d: &[f32], protos: &[Prototype]) -> (char, f32) {
    let mut best = ('?', f32::MAX);
    for p in protos {
        let dd = dist(d, &p.features);
        if dd < best.1 {
            best = (p.piece, dd);
        }
    }
    best
}

/// Best prototype, its distance, and the distance to the closest prototype with
/// a *different* piece label.
///
/// Two clusters can legitimately carry the same label (the same piece on a
/// highlighted and an unhighlighted square), so the runner-up has to skip those
/// or every ordinary piece would look ambiguous.
pub fn nearest_two(d: &[f32], protos: &[Prototype]) -> (char, f32, f32) {
    let (piece, best) = nearest(d, protos);
    let mut runner = f32::MAX;
    for p in protos {
        if p.piece == piece {
            continue;
        }
        let dd = dist(d, &p.features);
        if dd < runner {
            runner = dd;
        }
    }
    (piece, best, runner)
}

/// How much closer the winner must be than the nearest *different* piece before
/// the read is trusted. Descriptors from real boards spread ~1.0 from their own
/// prototype, while the closest distinct pair (rook/bishop) sits ~2.0 apart, so
/// a 0.15 gap is comfortably below the noise and still catches the genuinely
/// borderline square. When two pieces are this close the honest answer is `?`,
/// not a coin flip that later reaches the engine as a queen.
pub const AMBIGUITY_MARGIN: f32 = 0.15;

/// Nearest prototype. Returns '.' when the square is essentially blank, or '?'
/// when the best match is too far to trust or too close to a different piece.
/// Better to refuse than to hallucinate a queen.
pub fn classify(d: &[f32], protos: &[Prototype], max_dist: f32) -> char {
    if ink_fraction(d) < EMPTY_INK {
        return '.';
    }
    let (piece, dd, runner) = nearest_two(d, protos);
    if dd > max_dist {
        return '?';
    }
    if runner - dd < AMBIGUITY_MARGIN {
        return '?';
    }
    piece
}

// ---------------------------------------------------------------------------
// k-means for one-time calibration
// ---------------------------------------------------------------------------

fn mean_of(cluster: &[&Vec<f32>]) -> Vec<f32> {
    let mut m = vec![0f32; DIMS];
    for v in cluster {
        for (i, x) in v.iter().enumerate() {
            m[i] += x;
        }
    }
    let n = cluster.len().max(1) as f32;
    for x in m.iter_mut() {
        *x /= n;
    }
    m
}

/// Deterministic k-means with farthest-point seeding. Naive "every Nth sample"
/// init is a trap on a chess board: 32 of 64 squares are empty, so most seeds
/// collapse into the empty cluster and you end up with 8 real classes out of 13.
/// Farthest-point seeding guarantees the seeds are spread across descriptor space.
pub fn kmeans(samples: &[Vec<f32>], k: usize, iters: usize) -> Vec<Vec<f32>> {
    let k = k.min(samples.len()).max(1);

    let mut centroids: Vec<Vec<f32>> = vec![samples[0].clone()];
    while centroids.len() < k {
        let mut best = (0usize, f32::MIN);
        for (i, s) in samples.iter().enumerate() {
            let d = centroids
                .iter()
                .map(|c| dist(s, c))
                .fold(f32::MAX, f32::min);
            if d > best.1 {
                best = (i, d);
            }
        }
        centroids.push(samples[best.0].clone());
    }

    for _ in 0..iters {
        let mut buckets: Vec<Vec<&Vec<f32>>> = vec![Vec::new(); k];
        for s in samples {
            let mut bi = 0;
            let mut bd = f32::MAX;
            for (i, c) in centroids.iter().enumerate() {
                let d = dist(s, c);
                if d < bd {
                    bd = d;
                    bi = i;
                }
            }
            buckets[bi].push(s);
        }
        for (i, b) in buckets.iter().enumerate() {
            if !b.is_empty() {
                centroids[i] = mean_of(b);
            }
        }
    }
    centroids
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A descriptor with a fixed silhouette (ink = `shape`) and one ink colour.
    fn desc(shape: f32, colour: f32) -> Vec<f32> {
        let mut v = vec![0.0; DIMS];
        for x in v.iter_mut().take(64) {
            *x = shape;
        }
        for x in v.iter_mut().skip(64) {
            *x = colour;
        }
        v
    }

    fn proto(piece: char, d: Vec<f32>) -> Prototype {
        Prototype { piece, features: d }
    }

    #[test]
    fn confident_read_is_kept() {
        let protos = vec![proto('Q', desc(0.3, 0.5)), proto('n', desc(0.3, 0.9))];
        assert_eq!(classify(&desc(0.3, 0.5), &protos, 1.05), 'Q');
    }

    #[test]
    fn blank_square_is_empty() {
        let protos = vec![proto('Q', desc(0.3, 0.5))];
        assert_eq!(classify(&vec![0.0; DIMS], &protos, 1.05), '.');
    }

    #[test]
    fn far_from_every_prototype_is_unknown() {
        let protos = vec![proto('Q', desc(0.3, 0.5))];
        assert_eq!(classify(&desc(0.3, 1.0), &protos, 0.2), '?');
    }

    #[test]
    fn two_different_pieces_nearly_equidistant_is_unknown() {
        // The descriptor sits between Q and n. Guessing here is exactly how a
        // knight becomes a queen on a dark square.
        let protos = vec![proto('Q', desc(0.3, 0.50)), proto('n', desc(0.3, 0.52))];
        assert_eq!(classify(&desc(0.3, 0.51), &protos, 1.05), '?');
    }

    #[test]
    fn duplicate_labels_do_not_count_as_ambiguity() {
        // Two clusters for the same piece (normal and highlighted) must not
        // veto the read just because they are close to each other.
        let protos = vec![
            proto('Q', desc(0.3, 0.50)),
            proto('Q', desc(0.3, 0.505)),
            proto('n', desc(0.3, 0.95)),
        ];
        assert_eq!(classify(&desc(0.3, 0.5), &protos, 1.05), 'Q');
    }
}
