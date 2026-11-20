//! Screen capture front end.
//!
//! Two sources:
//!   * live  - grab the real screen through xcap (feature "live")
//!   * file  - read a PNG/JPEG frame (for debugging classification off a screenshot)
//!
//! Everything downstream works on a plain `image::RgbImage`, so the scanner never
//! cares where the pixels came from.

use anyhow::{bail, Context, Result};
use image::RgbImage;

use crate::config::BoardRect;

pub enum Source {
    #[cfg(feature = "live")]
    Screen {
        monitor: Option<usize>,
    },
    File {
        path: std::path::PathBuf,
    },
}

/// Would we be trying to capture a Wayland session? xcap cannot do that; the
/// portal + PipeWire route is a different backend entirely.
pub fn is_wayland() -> bool {
    let ty = std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);
    ty || std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Everything worth knowing when capture fails.
pub fn session_report() -> String {
    let mut s = String::new();
    for key in [
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "XDG_SESSION_ID",
    ] {
        s.push_str(&format!(
            "  {key:<20} {}\n",
            std::env::var(key).unwrap_or_else(|_| "(unset)".into())
        ));
    }
    #[cfg(feature = "live")]
    match xcap::Monitor::all() {
        Ok(list) => {
            s.push_str(&format!("  monitors             {}\n", list.len()));
            for (i, m) in list.iter().enumerate() {
                s.push_str(&format!(
                    "    [{i}] {:<18} {}x{}\n",
                    m.name(),
                    m.width(),
                    m.height()
                ));
            }
        }
        Err(e) => s.push_str(&format!("  monitors             error: {e}\n")),
    }
    #[cfg(not(feature = "live"))]
    s.push_str("  monitors             (built without the live feature)\n");
    s
}

impl Source {
    /// Return a full-frame capture of the display (or the file).
    pub fn grab(&self) -> Result<RgbImage> {
        match self {
            #[cfg(feature = "live")]
            Source::Screen { monitor } => {
                let monitors = xcap::Monitor::all().context("enumerating monitors")?;
                if monitors.is_empty() {
                    bail!("no monitors found");
                }
                let idx = monitor.unwrap_or(0).min(monitors.len() - 1);
                let shot = monitors[idx].capture_image().map_err(|e| {
                    if is_wayland() {
                        anyhow::anyhow!(
                            "screen capture failed ({e}): this is a Wayland session and the X11 \
                             capture backend cannot read it. Log in with \"GNOME on Xorg\", or \
                             run `chesscan --doctor` for details"
                        )
                    } else {
                        anyhow::anyhow!(
                            "screen capture failed ({e}) on monitor {idx}; try `--monitor` with \
                             another index, or run `chesscan --doctor`"
                        )
                    }
                })?;
                Ok(image::DynamicImage::ImageRgba8(shot).to_rgb8())
            }
            Source::File { path } => {
                let img =
                    image::open(path).with_context(|| format!("opening {}", path.display()))?;
                Ok(img.to_rgb8())
            }
        }
    }

    pub fn new(file: Option<std::path::PathBuf>, monitor: Option<usize>) -> Self {
        match file {
            Some(p) => Source::File { path: p },
            #[cfg(feature = "live")]
            None => Source::Screen { monitor },
            #[cfg(not(feature = "live"))]
            None => {
                panic!("built without the `live` feature; pass a file path");
            }
        }
    }
}

/// Crop the board region out of a full frame. Clamps, so a stale config whose
/// rect drifts off-screen after a resolution change does not panic.
pub fn crop(frame: &RgbImage, rect: &BoardRect) -> Result<RgbImage> {
    let (fw, fh) = (frame.width(), frame.height());
    let x = rect.x.min(fw.saturating_sub(1));
    let y = rect.y.min(fh.saturating_sub(1));
    let w = rect.w.min(fw - x).max(1);
    let h = rect.h.min(fh - y).max(1);
    if w < 32 || h < 32 {
        bail!("board rect too small after clamping ({w}x{h}); recalibrate");
    }
    Ok(image::imageops::crop_imm(frame, x, y, w, h).to_image())
}

/// Grab the 64 square patches for a board crop, in (file, rank) order.
pub fn square_patches(board: &RgbImage, white_bottom: bool) -> Vec<((u32, u32), RgbImage)> {
    let rect = BoardRect {
        x: 0,
        y: 0,
        w: board.width(),
        h: board.height(),
    };
    let mut out = Vec::with_capacity(64);
    for rank in 0..8u32 {
        for file in 0..8u32 {
            let (x, y, w, h) = rect.square_rect(file, rank, white_bottom);
            if w == 0 || h == 0 {
                continue;
            }
            out.push((
                (file, rank),
                image::imageops::crop_imm(board, x, y, w, h).to_image(),
            ));
        }
    }
    out
}
