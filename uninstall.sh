#!/bin/bash
# Removes "MAXAPACITY Debloat.app" and the working copy it runs from.
# Your scan history and change log stay.
set -u

NAME="MAXAPACITY Debloat"
BUNDLE_ID="com.maxapacity.debloat"
SUPPORT="$HOME/Library/Application Support/$NAME"

# Where install.sh puts the app, and where a downloaded one is usually dragged.
if [ -n "${DEBLOAT_APP_DIR:-}" ]; then
  set -- "$DEBLOAT_APP_DIR"
else
  set -- "$HOME/Applications" /Applications
fi

REMOVED=0
for dest in "$@"; do
  app="$dest/$NAME.app"
  [ -e "$app" ] || continue
  if ! grep -q "$BUNDLE_ID" "$app/Contents/Info.plist" 2>/dev/null; then
    echo "error: $app is not this app; leaving it alone" >&2
    exit 1
  fi
  rm -rf "$app" || exit 1
  echo "Removed $app"
  REMOVED=1
done
if [ -d "$SUPPORT" ]; then
  rm -rf "$SUPPORT" || exit 1
  echo "Removed its working copy in $SUPPORT"
  REMOVED=1
fi

if [ "$REMOVED" -eq 0 ]; then
  echo "Nothing to remove: there is no $NAME.app in $*."
  exit 0
fi
echo "Your scan history and change log are still in ~/.maxapacity-debloat."
echo "They are what 'restore' reads; delete that folder only if you are done with them."
