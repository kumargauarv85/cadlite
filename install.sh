#!/bin/sh
# CADLite Viewer installer. Default: per-user install into ~/.local (no root needed).
#   ./install.sh              install for the current user
#   sudo ./install.sh --system   install for all users into /usr/local
#   ./install.sh --uninstall  remove (add --system for a system install)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX="$HOME/.local"; ACTION=install
for a in "$@"; do case "$a" in --system) PREFIX=/usr/local;; --uninstall) ACTION=uninstall;; *) echo "Unknown option: $a" >&2; exit 2;; esac; done
LIB="$PREFIX/share/cadlite"; BIN="$PREFIX/bin"; APPS="$PREFIX/share/applications"; ICONS="$PREFIX/share/icons/hicolor/scalable/apps"
if [ "$ACTION" = uninstall ]; then
  rm -rf "$LIB/web" "$LIB/cadlite.py" "$LIB/README.md" "$LIB/engine"; rmdir "$LIB" 2>/dev/null || true; rm -f "$BIN/cadlite" "$APPS/cadlite.desktop" "$ICONS/cadlite.svg"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS" 2>/dev/null || true
  echo "CADLite Viewer removed from $PREFIX."; exit 0
fi
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required. Install it with your package manager and run this again." >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' || { echo "Python 3.6 or newer is required." >&2; exit 1; }
mkdir -p "$LIB" "$BIN" "$APPS" "$ICONS"
rm -rf "$LIB/web"; cp -r "$HERE/web" "$LIB/web"; cp "$HERE/cadlite.py" "$HERE/README.md" "$LIB/"
printf '#!/bin/sh\nexec python3 "%s/cadlite.py" "$@"\n' "$LIB" > "$BIN/cadlite"; chmod 755 "$BIN/cadlite"
sed "s|^Exec=cadlite|Exec=$BIN/cadlite|" "$HERE/cadlite.desktop" > "$APPS/cadlite.desktop"
cp "$HERE/web/icon.svg" "$ICONS/cadlite.svg"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$PREFIX/share/icons/hicolor" 2>/dev/null || true
echo "CADLite Viewer installed in $PREFIX."
echo "Start it from the application menu or run: $BIN/cadlite [file.dwg|file.dxf]"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: $BIN is not on your PATH; the menu entry works regardless.";; esac
if ! command -v ODAFileConverter >/dev/null 2>&1 && ! command -v dwg2dxf >/dev/null 2>&1; then
  echo "DXF files work now. For DWG files: open CADLite and click Set up DWG support, or run: $BIN/cadlite --setup-dwg"
fi
