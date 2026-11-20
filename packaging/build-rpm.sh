#!/usr/bin/env bash
# Build an installable x86_64 RPM for Fedora from the prebuilt release binary.
# Runs on any host with cargo + rpmbuild (Debian works fine; the binary is
# forward compatible with newer glibc, which is all Fedora needs).
set -euo pipefail

NAME=chesscan
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VER=$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$ROOT/Cargo.toml" | head -1)
TOPDIR="$ROOT/dist/rpmbuild"

command -v rpmbuild >/dev/null || { echo "rpmbuild not found (apt install rpm)" >&2; exit 1; }

echo "==> building $NAME $VER"
cargo build --release --manifest-path "$ROOT/Cargo.toml"

rm -rf "$TOPDIR"
mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS,BUILDROOT}

STAGE="$TOPDIR/$NAME-$VER"
mkdir -p "$STAGE/packaging"
install -m 0755 "$ROOT/target/release/$NAME" "$STAGE/$NAME"
install -m 0755 "$ROOT/target/release/$NAME-gui" "$STAGE/$NAME-gui"
install -m 0644 "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/"
install -m 0644 "$ROOT/packaging/$NAME.1" "$ROOT/packaging/$NAME-gui.1" "$STAGE/packaging/"
install -m 0644 "$ROOT/packaging/$NAME.desktop" "$ROOT/packaging/$NAME-overlay.desktop" "$ROOT/packaging/$NAME.svg" "$STAGE/packaging/"

tar -czf "$TOPDIR/SOURCES/$NAME-$VER.tar.gz" -C "$TOPDIR" "$NAME-$VER"
sed "s/^Version:.*/Version:        $VER/" "$ROOT/packaging/$NAME.spec" > "$TOPDIR/SPECS/$NAME.spec"

echo "==> rpmbuild"
rpmbuild -bb "$TOPDIR/SPECS/$NAME.spec" \
    --define "_topdir $TOPDIR" \
    --define "_binary_payload w9.xzdio"

mkdir -p "$ROOT/dist"
find "$TOPDIR/RPMS" -name '*.rpm' -exec cp {} "$ROOT/dist/" \;
echo "==> done"
ls -lh "$ROOT"/dist/*.rpm