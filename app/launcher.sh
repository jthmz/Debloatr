#!/bin/bash
# The program inside MAXAPACITY Debloat.app.
#
# Starts the helper (gui/server.mjs), which opens the window and stops by
# itself shortly after the window is closed. The helper runs on its own and
# this finishes at once, so macOS sees the app as closed while its window is
# open. Opening the app again therefore runs this again, and the helper that
# is already there brings up a new window.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)" || exit 1
SUPPORT="$HOME/Library/Application Support/MAXAPACITY Debloat"
LOG="$HOME/Library/Logs/maxapacity-debloat.log"

alert() {
  echo "$1" >&2
  # No dialog on a build machine: nobody is there to dismiss it.
  if [ -z "${CI:-}" ] && [ -x /usr/bin/osascript ]; then
    /usr/bin/osascript -e "display alert \"MAXAPACITY Debloat\" message \"$1\"" >/dev/null 2>&1
  fi
}

# ---- A copy to run from -----------------------------------------------------
# A downloaded app that is opened where it landed runs from a temporary place
# that macOS takes away once the app has finished, and this launcher finishes
# at once. Running from a copy also means that moving, updating or deleting
# the app cannot pull the files from under a helper that is still going.
# Each file is put in place whole, by rename, and only when it differs, so a
# tool run in progress never reads half a file.
place() {
  cmp -s "$1" "$2" && return 0
  cp "$1" "$2.new.$$" && mv -f "$2.new.$$" "$2"
}
RUN="$SUPPORT/app"
if mkdir -p "$RUN/gui" 2>/dev/null \
  && place "$RES/debloat.sh" "$RUN/debloat.sh" \
  && place "$RES/rules.tsv" "$RUN/rules.tsv" \
  && place "$RES/gui/server.mjs" "$RUN/gui/server.mjs" \
  && place "$RES/gui/ui.html" "$RUN/gui/ui.html" \
  && place "$RES/gui/magic.js" "$RUN/gui/magic.js"; then
  # Copies of downloaded files keep the download mark; these are only read.
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$RUN" 2>/dev/null
  fi
else
  RUN="$RES"
fi

# ---- Finding node and adb ----------------------------------------------------
# Apps do not get the Terminal's PATH. Start with where Homebrew puts things;
# add where Android Studio keeps adb, and a platform-tools folder unpacked
# into the home folder; then, in front of all that, where node and adb were
# when install.sh built this app, if it did. (Not Downloads, Documents or the
# Desktop: looking there makes macOS ask for permission.)
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for dir in "$HOME/Library/Android/sdk/platform-tools" "$HOME/platform-tools"; do
  [ -d "$dir" ] && PATH="$PATH:$dir"
done
if [ -f "$RES/paths" ]; then
  while IFS= read -r dir; do
    [ -d "$dir" ] && PATH="$dir:$PATH"
  done < "$RES/paths"
fi
export PATH

# The first node on the PATH that is new enough, then any that nvm installed.
NODE=""
TOO_OLD=""
find_node() {
  local dir
  local -a dirs
  IFS=: read -r -a dirs <<< "$PATH"
  for dir in "${dirs[@]}" "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$dir/node" ] || continue
    if "$dir/node" -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)' 2>/dev/null; then
      NODE="$dir/node"
      return 0
    fi
    TOO_OLD="$dir/node"
  done
  return 1
}

# The PATH of the shell the Terminal uses, which knows about anything set up
# in its start-up files. It can take a second or more, so it is the last
# resort, and it is given five seconds. What it finds goes in front: when the
# usual places fall short, the Terminal's own order is the one to follow.
shell_path() {
  local shell="${SHELL:-/bin/zsh}" out pid waited=0
  [ -x "$shell" ] || return 1
  out="$(mktemp "${TMPDIR:-/tmp}/debloat-path.XXXXXX")" || return 1
  # shellcheck disable=SC2016  # $PATH is for that shell to fill in, not this one
  "$shell" -ilc 'printf "\n__DEBLOAT_PATH__%s__END__\n" "$PATH"' < /dev/null > "$out" 2>/dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  kill "$pid" 2>/dev/null
  sed -n 's/.*__DEBLOAT_PATH__\(.*\)__END__.*/\1/p' "$out" | sed -n '1p'
  rm -f "$out"
}

if ! find_node || ! command -v adb >/dev/null 2>&1; then
  MORE="$(shell_path)"
  if [ -n "$MORE" ]; then
    PATH="$MORE:$PATH"
    export PATH
    [ -n "$NODE" ] || find_node
  fi
fi

if [ -z "$NODE" ]; then
  if [ -n "$TOO_OLD" ]; then
    alert "This needs Node.js 18 or newer. In Terminal, run: brew upgrade node"
  else
    alert "Node.js is needed to show the window. In Terminal, run: brew install node"
  fi
  exit 1
fi
if ! command -v adb >/dev/null 2>&1; then
  alert "adb is needed to reach the phone. In Terminal, run: brew install android-platform-tools"
  exit 1
fi

mkdir -p "$(dirname "$LOG")"
# The log gets a line or two per start; begin again before it grows large.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ]; then
  : > "$LOG"
fi
# This returns as soon as the helper says a window is on its way, and with a
# failure if the helper stopped before it could say so.
if ! "$NODE" "$RUN/gui/server.mjs" --window --exit-when-idle --background "$@" >> "$LOG" 2>&1; then
  alert "MAXAPACITY Debloat could not start. The reason is at the end of its log: $LOG"
  exit 1
fi
