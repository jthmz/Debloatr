#!/bin/bash
# Builds "MAXAPACITY Debloat.app" from this folder.
#
#   ./install.sh               build it and put it in ~/Applications
#   ./install.sh --open        and open it
#   ./install.sh --bundle DIR  only build it, into DIR. Nothing is installed,
#                              and it works on any system: the app in the
#                              release download is made this way
#   ./uninstall.sh             remove it
#
# The app is a folder macOS treats as an application: this tool's files, an
# icon, and a launcher that opens the window. Built here, on your Mac, from
# files you can read, it opens without the "Apple could not verify" prompt
# that a downloaded app gets.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)" || exit 1
NAME="MAXAPACITY Debloat"
BUNDLE_ID="com.maxapacity.debloat"

die() {
  echo "error: $*" >&2
  exit 1
}

MODE=install
OPEN=0
DEST="${DEBLOAT_APP_DIR:-$HOME/Applications}"
while [ $# -gt 0 ]; do
  case "$1" in
    --open) OPEN=1 ;;
    --bundle)
      [ $# -ge 2 ] || die "--bundle needs a folder to build into"
      MODE=bundle
      DEST="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
APP="$DEST/$NAME.app"

if [ "$MODE" = install ] && [ "$(uname -s)" != Darwin ]; then
  die "the app is for macOS. On Linux, run: node gui/server.mjs"
fi
for file in debloat.sh rules.tsv gui/server.mjs gui/ui.html app/Info.plist app/launcher.sh app/AppIcon.icns; do
  [ -f "$HERE/$file" ] || die "$file is missing; run this from the debloat folder"
done

VERSION="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$HERE/debloat.sh" | sed -n '1p')"
[ -n "$VERSION" ] || die "could not read the version from debloat.sh"

# Never replace something that is not this app.
if [ -e "$APP" ] && ! grep -q "$BUNDLE_ID" "$APP/Contents/Info.plist" 2>/dev/null; then
  die "$APP is there already and is not this app; move it away first"
fi

BUILD="$(mktemp -d "${TMPDIR:-/tmp}/debloat-app.XXXXXX")" || die "cannot create a temporary folder"
trap 'rm -rf "$BUILD"' EXIT
NEW="$BUILD/$NAME.app"
mkdir -p "$NEW/Contents/MacOS" "$NEW/Contents/Resources/gui" || die "cannot build in $BUILD"

sed "s/__VERSION__/$VERSION/g" "$HERE/app/Info.plist" > "$NEW/Contents/Info.plist" || die "cannot write Info.plist"
cp "$HERE/app/launcher.sh" "$NEW/Contents/MacOS/debloat-app" || die "cannot copy the launcher"
cp "$HERE/debloat.sh" "$HERE/rules.tsv" "$HERE/app/AppIcon.icns" "$NEW/Contents/Resources/" || die "cannot copy the tool"
cp "$HERE/gui/server.mjs" "$HERE/gui/ui.html" "$NEW/Contents/Resources/gui/" || die "cannot copy the window"
chmod 755 "$NEW/Contents/MacOS/debloat-app" "$NEW/Contents/Resources/debloat.sh"
chmod 644 "$NEW/Contents/Info.plist" "$NEW/Contents/Resources/rules.tsv" "$NEW/Contents/Resources/AppIcon.icns" \
  "$NEW/Contents/Resources/gui/server.mjs" "$NEW/Contents/Resources/gui/ui.html"

if [ "$MODE" = install ]; then
  # Apps do not get the Terminal's PATH. Note where node and adb are right
  # now, so the app finds the same ones this Terminal does, wherever they
  # were put. (An app built for download looks in the usual places instead.)
  : > "$NEW/Contents/Resources/paths"
  for tool in node adb; do
    found="$(command -v "$tool" 2>/dev/null)"
    case "$found" in
      /*) dirname "$found" >> "$NEW/Contents/Resources/paths" ;;
    esac
  done
fi

mkdir -p "$DEST" || die "cannot create $DEST"
rm -rf "$APP"
mv "$NEW" "$APP" || die "cannot put the app in $DEST"

if [ "$MODE" = bundle ]; then
  echo "Built $NAME $VERSION in $DEST"
  exit 0
fi

# Files that came from a download carry a mark that makes macOS question an
# app the first time it opens. This one was built here from files you chose to
# run, so the mark is cleared.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
fi
# Tell macOS the app is there, so Spotlight and Launchpad find it right away.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1
fi

echo "Installed $NAME $VERSION in $DEST"
if ! command -v node >/dev/null 2>&1; then
  echo "note: Node.js is not installed yet. The app needs it: brew install node"
elif ! node -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)' 2>/dev/null; then
  echo "note: the app needs Node.js 18 or newer and this is $(node --version). Run: brew upgrade node"
fi
command -v adb >/dev/null 2>&1 || echo "note: adb is not installed yet. The app needs it: brew install android-platform-tools"

if [ "$OPEN" -eq 1 ]; then
  open "$APP"
else
  echo "Open it from Spotlight (Cmd-Space, then type Debloat), or run: open \"$APP\""
fi
