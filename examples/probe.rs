//! Debug probe: print the board-wide square colours and a few square descriptors.
//! cargo run --example probe -- <board.png> [square ...]

use chesscan::{classify, config::BoardRect};

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("board image path");
    let img = image::open(&path)?.to_rgb8();
    let rect = BoardRect { x: 0, y: 0, w: img.width(), h: img.height() };
    for name in std::env::args().skip(2) {
        let b = name.as_bytes();
        let file = (b[0] - b'a') as u32;
        let rank = (b[1] - b'1') as u32;
        let (x, y, w, h) = rect.square_rect(file, rank, true);
        let patch = image::imageops::crop_imm(&img, x, y, w, h).to_image();
        let d = classify::descriptor(&patch);
        println!(
            "{name}: ink={:.3} rgb={:?}",
            classify::ink_fraction(&d),
            classify::ink_rgb(&d)
        );
    }
    Ok(())
}