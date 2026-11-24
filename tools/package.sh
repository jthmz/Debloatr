#!/usr/bin/env bash
# Makes the two downloads, in DIR (default: the current folder):
#
#   MAXAPACITY-Debloat-<version>-mac.zip   the app, ready to open
#   maxapacity-debloat-<version>.zip       the command-line tool, the window
#                                          and install.sh, for the Terminal
#                                          and for Linux
#
#   tools/package.sh [DIR]
#
# Neither holds the tests. Works on any system with zip.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$PWD}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

VERSION="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$HERE/debloat.sh" | sed -n '1p')"
if [ -z "$VERSION" ]; then
  echo "error: could not read the version from debloat.sh" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/debloat-pack.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# The app, alone in its zip, so that unzipping leaves the app itself where the
# download landed. zip records the launcher's permission to run; without it
# the folder would not open as an app.
bash "$HERE/install.sh" --bundle "$STAGE/app" > /dev/null
APP_ZIP="$OUT/MAXAPACITY-Debloat-$VERSION-mac.zip"
rm -f "$APP_ZIP"
(cd "$STAGE/app" && zip -q -r -X -y "$APP_ZIP" "MAXAPACITY Debloat.app")

# The tool and what the app is built from.
ROOT="$STAGE/src/MAXAPACITY Debloat"
mkdir -p "$ROOT/gui" "$ROOT/app"
cp "$HERE/debloat.sh" "$HERE/rules.tsv" "$HERE/install.sh" "$HERE/uninstall.sh" "$HERE/README.md" "$ROOT/"
cp "$HERE/gui/server.mjs" "$HERE/gui/ui.html" "$HERE/gui/magic.js" "$ROOT/gui/"
cp "$HERE/app/Info.plist" "$HERE/app/launcher.sh" "$HERE/app/AppIcon.icns" "$ROOT/app/"
chmod 755 "$ROOT/debloat.sh" "$ROOT/install.sh" "$ROOT/uninstall.sh" "$ROOT/app/launcher.sh"
SRC_ZIP="$OUT/maxapacity-debloat-$VERSION.zip"
rm -f "$SRC_ZIP"
(cd "$STAGE/src" && zip -q -r -X "$SRC_ZIP" "MAXAPACITY Debloat")

echo "wrote $APP_ZIP"
echo "wrote $SRC_ZIP"
