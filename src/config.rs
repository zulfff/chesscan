//! Persistent config: board rect on screen, orientation, paths, theme prototypes.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const CONFIG_PATH: &str = "chesscan.json";

/// Bump whenever the descriptor layout changes. Prototypes are stored as raw
/// feature vectors, so prototypes from an older layout are geometrically
/// incompatible: they do not fail loudly, they just misread pieces. Stamping
/// the revision and dropping stale prototypes forces a recalibration instead.
pub const CALIB_REV: u32 = 3;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BoardRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl BoardRect {
    /// Square size in fractional pixels. We keep it f64 because a 8x8 grid on a
    /// 615px-wide board does not divide evenly and naive integer math drifts a
    /// full square by rank 8.
    pub fn square(&self) -> (f64, f64) {
        (self.w as f64 / 8.0, self.h as f64 / 8.0)
    }

    /// Pixel bounds of square (file, rank) where file 0 = a-file, rank 0 = rank 1
    /// when `white_bottom` is true.
    pub fn square_rect(&self, file: u32, rank: u32, white_bottom: bool) -> (u32, u32, u32, u32) {
        let (sw, sh) = self.square();
        let (cx, cy) = if white_bottom {
            (file, rank)
        } else {
            (7 - file, rank)
        };
        let x0 = self.x as f64 + cx as f64 * sw;
        // Screen Y grows downward; rank 0 is the bottom of the board.
        let row_from_top = if white_bottom { 7 - cy } else { cy };
        let y0 = self.y as f64 + row_from_top as f64 * sh;
        (
            x0.round() as u32,
            y0.round() as u32,
            sw.round() as u32,
            sh.round() as u32,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub board: BoardRect,
    pub white_bottom: bool,
    pub engine_path: String,
    pub depth: u32,
    pub multipv: u32,
    /// Descriptor revision these prototypes were learned with.
    #[serde(default)]
    pub calibrate_rev: u32,
    /// Last position of the always-on-top overlay window, so it comes back where
    /// the user dragged it instead of jumping to the middle of the screen.
    #[serde(default)]
    pub overlay_pos: Option<[f32; 2]>,
    /// Learned piece prototypes. Key is a quantized centroid hash, value is a
    /// FEN piece char ('P','n','K',..) or '.' for empty.
    pub prototypes: Vec<Prototype>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prototype {
    pub piece: char,
    pub features: Vec<f32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            board: BoardRect {
                x: 0,
                y: 0,
                w: 640,
                h: 640,
            },
            white_bottom: true,
            engine_path: "stockfish".into(),
            depth: 18,
            multipv: 3,
            calibrate_rev: CALIB_REV,
            overlay_pos: None,
            prototypes: Vec::new(),
        }
    }
}

impl Config {
    pub fn load_or_default(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut cfg: Self =
            serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))?;
        if cfg.calibrate_rev != CALIB_REV && !cfg.prototypes.is_empty() {
            eprintln!(
                "note: piece prototypes were learned by an older version and no longer fit; recalibrate once."
            );
            cfg.prototypes.clear();
        }
        // Belt and braces for configs that were hand-edited or written by a
        // build that forgot to bump the revision. `dist` zips, so a short
        // feature vector does not fail loudly — it silently drops dimensions
        // and every piece starts reading as '?'.
        if !cfg.prototypes.is_empty()
            && cfg.prototypes.iter().any(|p| p.features.len() != crate::classify::DIMS)
        {
            eprintln!(
                "note: stored prototypes have the wrong descriptor size (want {}); recalibrate once.",
                crate::classify::DIMS
            );
            cfg.prototypes.clear();
        }
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("creating {}", dir.display()))?;
            }
        }
        // Always stamp the current revision so a prototype written by this
        // build is not discarded on the next load.
        let mut stamped = self.clone();
        stamped.calibrate_rev = CALIB_REV;
        let raw = serde_json::to_string_pretty(&stamped)?;
        std::fs::write(path, raw).with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }
}

/// Where the desktop app keeps its config: `$XDG_CONFIG_HOME/chesscan/config.json`.
pub fn app_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let base = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
    std::path::PathBuf::from(base).join("chesscan").join("config.json")
}

/// Resolve the config path. `CHESSCAN_CONFIG` wins, then an existing
/// `./chesscan.json` (so older setups keep working), then the XDG location.
pub fn resolve_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("CHESSCAN_CONFIG") {
        return std::path::PathBuf::from(p);
    }
    let local = std::path::PathBuf::from(CONFIG_PATH);
    let app = app_path();
    if !app.exists() && local.exists() {
        local
    } else {
        app
    }
}
