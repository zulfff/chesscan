Name:           chesscan
Version:        0.1.0
Release:        1%{?dist}
Summary:        Live screen chess scanner with engine evaluation HUD

License:        MIT
URL:            https://example.invalid/chesscan
Source0:        %{name}-%{version}.tar.gz

ExclusiveArch:  x86_64

# The binary is prebuilt, so rpm's ELF dependency generator sees the direct
# DT_NEEDED entries but not these: winit and xcap dlopen them at runtime.
# Requiring the SONAME (rather than a package name) lets dnf pick whichever
# Fedora package provides it, including splits and renames.
Requires:       libX11.so.6()(64bit)
Requires:       libX11-xcb.so.1()(64bit)
Requires:       libXcursor.so.1()(64bit)
Requires:       libXi.so.6()(64bit)
Requires:       libxkbcommon.so.0()(64bit)
Requires:       libxkbcommon-x11.so.0()(64bit)
Requires:       libxcb.so.1()(64bit)
# The desktop app loads these through the GL loader, not DT_NEEDED.
Requires:       libEGL.so.1()(64bit)
Requires:       libGL.so.1()(64bit)

# Useful but not mandatory: --snapshot works with no engine installed.
Recommends:     stockfish

%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none

%description
chesscan captures a rectangle of the screen containing a chess board, reads the
pieces off it, converts the position to FEN, asks a UCI engine for the best
lines, and shows evaluation and win probability in an always-on-top panel.

Board detection is theme agnostic and requires no manual coordinates: it finds
the nine evenly spaced grid lines every board has, and rejects grid-like UI
clutter by checking that the crop is made of two clearly different flat colours
and reads as a legal-looking chess position. Recognition needs no sprite sheets
either; each square's background is taken from its corners, pixels far from it
become ink, and the resulting silhouette plus ink colour is the descriptor. The
64 descriptors are clustered once during calibration, labelled by the user, and
reused. Corner backgrounds also survive last-move highlights.

Use it for study and post-game review. Pointing it at rated online games is
cheating and will get the account banned.

%prep
%setup -q

%build
# Prebuilt static-ish x86_64 binary shipped in the source tarball.

%install
install -Dpm 0755 chesscan %{buildroot}%{_bindir}/chesscan
install -Dpm 0755 chesscan-gui %{buildroot}%{_bindir}/chesscan-gui
install -Dpm 0644 README.md %{buildroot}%{_docdir}/%{name}/README.md
install -Dpm 0644 LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE
install -Dpm 0644 packaging/chesscan.1 %{buildroot}%{_mandir}/man1/chesscan.1
install -Dpm 0644 packaging/chesscan-gui.1 %{buildroot}%{_mandir}/man1/chesscan-gui.1
install -Dpm 0644 packaging/chesscan.desktop %{buildroot}%{_datadir}/applications/chesscan.desktop
install -Dpm 0644 packaging/chesscan-overlay.desktop %{buildroot}%{_datadir}/applications/chesscan-overlay.desktop
install -Dpm 0644 packaging/chesscan.svg %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/chesscan.svg

%files
%{_bindir}/chesscan
%{_bindir}/chesscan-gui
%{_datadir}/applications/chesscan.desktop
%{_datadir}/applications/chesscan-overlay.desktop
%{_datadir}/icons/hicolor/scalable/apps/chesscan.svg
%{_docdir}/%{name}/README.md
%{_licensedir}/%{name}/LICENSE
%{_mandir}/man1/chesscan.1*
%{_mandir}/man1/chesscan-gui.1*

%changelog
* Fri Nov 20 2026 LO <lo@localhost> - 0.4.0-1
- Overlay mode (--overlay): small always-on-top stream-alert panel with win
  percentage, eval bar and top lines; position remembered; own desktop entry
- Detect and Calibrate hide the app window before capturing, so the scanner no
  longer reads its own window instead of the board
- Board detection validates candidates: two-tone colour evidence plus a
  legal-material check, so grid-like UI clutter is rejected instead of saved
- Per-square background from the corners: last-move highlights no longer turn
  a piece into an unreadable square
- Recalibrate once: learned prototypes from older versions are rejected

* Fri Nov 20 2026 LO <lo@localhost> - 0.3.0-1
- Desktop app (chesscan-gui) with live preview, arrow overlay and
  click-through calibration; installed with a desktop entry and icon
- Config moved to $XDG_CONFIG_HOME/chesscan/config.json

* Fri Nov 20 2026 LO <lo@localhost> - 0.2.0-1
- Automatic board detection from grid lines: no manual --rect needed
- Re-detect automatically when reads start failing (--auto)
- Record and win-probability HUD unchanged

* Fri Nov 20 2026 LO <lo@localhost> - 0.1.0-1
- Initial package