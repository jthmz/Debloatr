#!/usr/bin/env bash
# Tests for debloat.sh, run against the simulated phone in fake_adb.py.
#
#   test/run.sh            run everything
#   test/run.sh -v         also print each test name as it runs
#
# The script under test is started with the same bash that runs this file, so
# `/bin/bash test/run.sh` on a Mac exercises it under bash 3.2 and BSD tools.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
SH="${BASH:-bash}"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/debloat-test.XXXXXX")" || exit 1
trap 'rm -rf "${WORK:?}"' EXIT

export PATH="$HERE/bin:$PATH"
export FAKE_ADB_STATE="$WORK/phone.json"
export DEBLOAT_STATE_DIR="$WORK/state"
unset NO_COLOR

OUT="$WORK/out.txt"
LOG="$DEBLOAT_STATE_DIR/FAKE123/changes.tsv"
RC=0
PASS=0
FAIL=0
NAME=""

ctl() { python3 "$HERE/fake_adb.py" ctl "$@"; }

# A new phone and no saved state.
fresh() {
  rm -rf "${WORK:?}/state"
  mkdir -p "$DEBLOAT_STATE_DIR"
  ctl init
}

t() {
  NAME="$1"
  [ "$VERBOSE" -eq 1 ] && printf '  %s\n' "$NAME"
  return 0
}

# ${1+"$@"} rather than "$@": older bash counts an empty "$@" as unset under -u.
run() {
  "$SH" "$ROOT/debloat.sh" ${1+"$@"} > "$OUT" 2>&1 < /dev/null
  RC=$?
}

# First argument is typed input, with \n for Enter.
run_in() {
  local input="$1"
  shift
  printf '%b' "$input" | "$SH" "$ROOT/debloat.sh" ${1+"$@"} > "$OUT" 2>&1
  RC=$?
}

ok() { PASS=$((PASS + 1)); }

bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL [%s] %s\n' "$NAME" "$1"
  sed 's/^/    | /' "$OUT" | sed -n '1,40p'
}

has() { if grep -qF -- "$1" "$OUT"; then ok; else bad "output should contain: $1"; fi; }
hasnt() { if grep -qF -- "$1" "$OUT"; then bad "output should not contain: $1"; else ok; fi; }
rc() { if [ "$RC" -eq "$1" ]; then ok; else bad "exit status should be $1, was $RC"; fi; }

# has_row STATUS PACKAGE: a result line with that status for that package.
has_row() {
  if grep -Eq -- "^  $1 +$2( |\$)" "$OUT"; then ok; else bad "should report '$1' for $2"; fi
}

# The rows under one "== TITLE" heading of a scan.
section() {
  awk -v h="== $1" 'index($0, h) == 1 { on = 1; next } on && /^== / { exit } on' "$OUT"
}
in_section() {
  if section "$1" | grep -qF -- "$2"; then ok; else bad "section '$1' should list: $2"; fi
}
not_in_section() {
  if section "$1" | grep -qF -- "$2"; then bad "section '$1' should not list: $2"; else ok; fi
}

# field PACKAGE KEY JSON: what the simulated phone holds.
field() {
  local got
  got="$(ctl get "$1" "$2")"
  if [ "$got" = "$3" ]; then ok; else bad "phone: $1.$2 should be $3, is $got"; fi
}

# logged PACKAGE ACTION: what the change log holds ("none" for no entry).
logged() {
  local got=""
  [ -f "$LOG" ] && got="$(awk -F'\t' -v p="$1" '$1 == p { print $2 }' "$LOG")"
  if [ "${got:-none}" = "$2" ]; then ok; else bad "log: $1 should be $2, is ${got:-none}"; fi
}

CHANGES='^(pm (uninstall|disable-user|enable|revoke|grant)|cmd package install-existing|cmd appops set|am force-stop)'
changed_nothing() {
  if ctl log | grep -Eq -- "$CHANGES"; then bad "no changing command should reach the phone"; else ok; fi
}

printf 'debloat.sh tests, bash %s\n' "$BASH_VERSION"

# ---------------------------------------------------------------------------
t "help, version and bad usage"
run --help;            rc 0; has "Usage: debloat.sh"
run;                   rc 0; has "Start with: debloat.sh scan"
# The version it prints is the one written in the script, whatever that is.
run --version;         rc 0; has "debloat.sh $(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$ROOT/debloat.sh" | sed -n '1p')"
if grep -Eq '^debloat\.sh [0-9]+\.[0-9]+\.[0-9]+$' "$OUT"; then ok; else bad "the version should be three numbers"; fi
run frobnicate;        rc 1; has "unknown command: frobnicate"
run --frob scan;       rc 1; has "unknown option: --frob"
run -s;                rc 1; has "needs a serial number"

# ---------------------------------------------------------------------------
t "finding the phone"
fresh
ctl top 'devices=[]'
run scan; rc 1; has "no phone found"
ctl top 'devices=[["FAKE123","unauthorized"]]'
run scan; rc 1; has "tap Allow"
ctl top 'devices=[["FAKE123","offline"]]'
run scan; rc 1; has "offline"
ctl top 'devices=[["AAA111","device"],["BBB222","device"]]'
run scan; rc 1; has "More than one phone"; has "BBB222"
run -s BBB222 scan; rc 0; has "MAXAPACITY debloat"
if [ -f "$DEBLOAT_STATE_DIR/BBB222/scan.txt" ]; then ok; else bad "scan should be saved per phone"; fi
run -s NOPE scan; rc 1; has "no phone with serial NOPE"

# ---------------------------------------------------------------------------
t "scan sorts every package into the right list"
fresh
run scan; rc 0
has "Phone:  moto g stylus - 2025 (mona), Android 16"
has "== REMOVE (7)"
for p in com.motorola.ccc.notification com.motorola.help com.LogiaGroup.LogiaDeck \
  com.vzw.hss.myverizon com.dti.folderlauncher com.facebook.appmanager com.glance.lockscreen; do
  in_section "REMOVE" "$p"
done
has "== ASK FIRST (3)"
in_section "ASK FIRST" com.motorola.moto
in_section "ASK FIRST" com.motorola.gamemode
in_section "ASK FIRST" com.verizon.mips.services
has "== KEPT ON PURPOSE (3)"
in_section "KEPT ON PURPOSE" com.motorola.vzw.phone.extensions
in_section "KEPT ON PURPOSE" com.vzw.apnlib
in_section "KEPT ON PURPOSE" com.verizon.remoteSimlock
not_in_section "ASK FIRST" com.vzw.apnlib
has "== ADDED BY A SPONSORED-APP INSTALLER (2)"
in_section "ADDED BY A SPONSORED" "com.candy.game"
in_section "ADDED BY A SPONSORED" "installed by com.dti.folderlauncher"
in_section "ADDED BY A SPONSORED" "com.block.puzzle"
in_section "ADDED BY ANOTHER" "com.weird.app"
# Updated by Facebook's stub: worth knowing, never bulk-removed.
in_section "ADDED BY ANOTHER" "com.instagram.android"
in_section "ADDED BY ANOTHER" "(Facebook's preinstalled installer and updater stubs)"
not_in_section "ADDED BY A SPONSORED" com.instagram.android
not_in_section "ADDED BY A SPONSORED" com.spotify.music
not_in_section "ADDED BY A SPONSORED" com.maxapacity.ride
not_in_section "ADDED BY A SPONSORED" com.sideloaded.tool
not_in_section "ADDED BY ANOTHER" com.spotify.music
in_section "NOTIFICATIONS UP" "com.motorola.ccc.notification"
in_section "NOTIFICATIONS UP" "under REMOVE"
in_section "NOTIFICATIONS UP" "put there by com.dti.folderlauncher"
has "== NOT CLASSIFIED (2)"
in_section "NOT CLASSIFIED" "product/app/TimeWeather"
in_section "NOT CLASSIFIED" "(updated since the factory)"
for p in com.motorola.skin.overlay com.motorola.launcher3 com.motorola.vzw.phone.extensions \
  com.android.systemui com.google.android.youtube com.motorola.help com.oldjunk.disabled; do
  not_in_section "NOT CLASSIFIED" "$p"
done
in_section "ALREADY OFF" "com.oldjunk.disabled"
in_section "ALREADY OFF" "com.gone.byothertool"
# Removed ones come first; overlays are counted, not listed; a removed package
# the rules would keep says so.
if [ "$(section "ALREADY OFF" | sed -n '1p' | awk '{ print $2 }')" = "removed" ]; then ok; else bad "ALREADY OFF should list removed packages first"; fi
not_in_section "ALREADY OFF" "com.motorola.android.launcher.overlay.att"
not_in_section "ALREADY OFF" "com.oem.euiccpartnerapp.overlay.tmo"
in_section "ALREADY OFF" "not listed: 2 carrier and skin overlays"
in_section "ALREADY OFF" "com.motorola.tracfone.rsu"
in_section "ALREADY OFF" "the rules would keep it: Tracfone SIM-unlock service"
# Switched off is not held against the keep rules: Android does that itself.
if section "ALREADY OFF" | grep -F "com.motorola.vzw.phone.extensions" | grep -qF "rules would keep"; then
  bad "a switched-off package should not be flagged against the keep rules"
else ok; fi
in_section "NEXT" "debloat.sh sponsored"
in_section "NEXT" "debloat.sh apply"
hasnt "CAME BACK"
changed_nothing
if [ -s "$DEBLOAT_STATE_DIR/FAKE123/scan.txt" ]; then ok; else bad "scan.txt should be written"; fi
if grep -q "$(printf '\033')" "$OUT" "$DEBLOAT_STATE_DIR/FAKE123/scan.txt"; then
  bad "no colour codes when output is not a terminal"
else ok; fi
if [ -z "$(ctl unknown)" ]; then ok; else bad "the tool sent a command the simulated phone does not know: $(ctl unknown)"; fi

# ---------------------------------------------------------------------------
t "scan --tsv gives the same lists in a form programs can read"
fresh
run scan --tsv; rc 0
has "$(printf 'meta\tphone\tmoto g stylus - 2025 (mona), Android 16')"
has "$(printf 'meta\tserial\tFAKE123')"
has "$(printf 'remove\tcom.motorola.help\tDevice Help app and its tips\tsystem')"
has "$(printf 'pushed\tcom.candy.game\tinstalled by com.dti.folderlauncher\tapp')"
has "$(printf 'keep\tcom.vzw.apnlib\t')"
has "$(printf 'off\tcom.gone.byothertool\tremoved\tsystem')"
if awk -F'\t' '$1 == "history" { if (NF != 7) bad = 1; next } NF < 3 || NF > 4 { bad = 1 } END { exit bad }' "$OUT"; then
  ok
else bad "tsv lines should have three or four fields, history lines seven"; fi
changed_nothing

# ---------------------------------------------------------------------------
t "each scan is remembered, so the next one can show what changed"
fresh
run scan; hasnt "Trend:"
run -y apply
run -y sponsored
run scan; has "Trend:  9 to clean up at the last scan, 1 now"
run scan --tsv
if [ "$(grep -c "^history$(printf '\t')" "$OUT")" -ge 3 ]; then ok; else bad "tsv should carry the scan history"; fi
has "$(printf 'change\tcom.motorola.help\tremoved\t')"
has "$(printf 'change\tcom.candy.game\tuninstalled\t')"

# ---------------------------------------------------------------------------
t "restart restarts the phone, and a dry run does not"
fresh
run -n restart; rc 0; has "would restart"
if [ "$(python3 -c 'import json,os;print(json.load(open(os.environ["FAKE_ADB_STATE"])).get("reboots",0))')" = "0" ]; then ok; else bad "a dry run should not restart the phone"; fi
run restart; rc 0; has "Restarting."
if [ "$(python3 -c 'import json,os;print(json.load(open(os.environ["FAKE_ADB_STATE"])).get("reboots",0))')" = "1" ]; then ok; else bad "restart should reach the phone once"; fi

# ---------------------------------------------------------------------------
t "dry run changes nothing"
fresh
run -n apply; rc 0
has "would remove"; has "Dry run: nothing was changed."
changed_nothing
logged com.motorola.help none
if [ -f "$DEBLOAT_STATE_DIR/FAKE123/baseline.txt" ]; then bad "dry run should not write a baseline"; else ok; fi

# ---------------------------------------------------------------------------
t "apply asks first; anything but yes is no"
fresh
run_in 'n\n' apply; rc 0; has "Nothing was changed."; changed_nothing
run apply;          rc 0; has "Nothing was changed."; changed_nothing
run_in '\n' apply;  rc 0; has "Nothing was changed."; changed_nothing

# ---------------------------------------------------------------------------
t "apply removes, and falls back to switching off, then silencing"
fresh
run -y apply; rc 2
has_row removed com.motorola.help
has_row removed com.motorola.ccc.notification
has_row removed com.LogiaGroup.LogiaDeck
has_row removed com.vzw.hss.myverizon
has_row "switched off" com.dti.folderlauncher
has_row silenced com.facebook.appmanager
has_row FAILED com.glance.lockscreen
has "Android refused every option (Failure [DELETE_FAILED_INTERNAL_ERROR])"
has "Done: 4 removed, 1 switched off, 1 silenced, 1 failed."
has "locked by the phone's maker"
has "2 apps an installer pushed are still on the phone"
field com.motorola.help installed false
field com.dti.folderlauncher enabled false
field com.dti.folderlauncher installed true
field com.facebook.appmanager notif_perm false
field com.facebook.appmanager ops '{"POST_NOTIFICATION": "ignore", "RUN_ANY_IN_BACKGROUND": "ignore", "RUN_IN_BACKGROUND": "ignore"}'
field com.glance.lockscreen installed true
field com.glance.lockscreen enabled true
logged com.motorola.help removed
logged com.dti.folderlauncher disabled
logged com.facebook.appmanager muted
logged com.glance.lockscreen none
# Tiers the plain apply must leave alone.
field com.motorola.moto installed true
field com.verizon.mips.services installed true
field com.vzw.apnlib installed true
field com.android.systemui installed true
if [ -s "$DEBLOAT_STATE_DIR/FAKE123/baseline.txt" ]; then ok; else bad "first change should save a baseline"; fi
# Second run: only the one that cannot be changed is left.
run -y apply; rc 2; has "1 to remove"; has_row FAILED com.glance.lockscreen

# ---------------------------------------------------------------------------
t "apply --caution adds the ask-first tier but never the keep tier"
fresh
run -y --caution apply
has_row removed com.motorola.moto
has_row removed com.motorola.gamemode
has_row removed com.verizon.mips.services
field com.vzw.apnlib installed true
field com.verizon.remoteSimlock installed true

# ---------------------------------------------------------------------------
t "pick one by one"
fresh
run_in 'p\ny\nn\nq\n' apply
has_row removed com.LogiaGroup.LogiaDeck
has_row skipped com.dti.folderlauncher
has "stopped"
field com.LogiaGroup.LogiaDeck installed false
field com.dti.folderlauncher enabled true
field com.motorola.help installed true

# ---------------------------------------------------------------------------
t "sponsored uninstalls only what a known sponsored-app installer added"
fresh
run_in 'n\n' sponsored; rc 0; has "pick one by one"; has "Nothing was changed."; changed_nothing
run -n sponsored; rc 0; has "would remove"; changed_nothing
run -y sponsored; rc 0
has_row uninstalled com.candy.game
has_row uninstalled com.block.puzzle
field com.candy.game installed absent
field com.weird.app installed true
field com.instagram.android installed true
field com.spotify.music installed true
field com.maxapacity.ride installed true
logged com.candy.game uninstalled
run -y sponsored; rc 0; has "No app on this phone was installed by a known sponsored-app installer."
has "added by other apps"

# ---------------------------------------------------------------------------
t "things that come back are reported and removed again"
fresh
run -y apply
run -y sponsored
ctl set com.motorola.help installed=true
ctl set com.dti.folderlauncher enabled=true
ctl add com.candy.game installer=com.dti.folderlauncher
run scan
has "== CAME BACK after being removed (3)"
in_section "CAME BACK" com.motorola.help
in_section "CAME BACK" com.dti.folderlauncher
in_section "CAME BACK" com.candy.game
in_section "NEXT" "debloat.sh reapply"
run -n reapply; has "put back by com.dti.folderlauncher"; has "would remove"
run -y reapply
has_row removed com.motorola.help
has_row "switched off" com.dti.folderlauncher
has_row uninstalled com.candy.game
field com.motorola.help installed false
field com.dti.folderlauncher enabled false
field com.candy.game installed absent
run scan; hasnt "CAME BACK"
run reapply; rc 0; has "Nothing has come back"

# ---------------------------------------------------------------------------
t "restore undoes each kind of change"
fresh
run -y apply
run -y sponsored
run restore; rc 0
has_row restored com.motorola.help
has_row restored com.dti.folderlauncher
has_row allowed com.facebook.appmanager
has_row "not restored" com.candy.game
has "https://play.google.com/store/apps/details?id=com.candy.game"
field com.motorola.help installed true
field com.dti.folderlauncher enabled true
field com.facebook.appmanager notif_perm true
field com.facebook.appmanager ops '{}'
logged com.motorola.help none
logged com.candy.game none
if [ -s "$LOG" ]; then bad "the change log should be empty after a full restore"; else ok; fi
run restore; rc 0; has "Nothing to restore"

# ---------------------------------------------------------------------------
t "restore by name, including what another tool removed"
fresh
run restore com.gone.byothertool; rc 0; has_row restored com.gone.byothertool
field com.gone.byothertool installed true
run restore com.oldjunk.disabled; rc 0; has_row restored com.oldjunk.disabled
field com.oldjunk.disabled enabled true
run restore com.nope.nothing; rc 2; has_row FAILED com.nope.nothing
has "no preinstalled app by that name"; hasnt "locked by the phone's maker"
run -n restore com.motorola.help; rc 0; has "would restore"

# ---------------------------------------------------------------------------
t "remove by name refuses what would break the phone"
fresh
# The last two names are attempts to smuggle a command to the phone's shell.
# shellcheck disable=SC2016
run remove com.android.systemui com.google.android.dialer com.motorola.launcher3 \
  com.google.android.inputmethod.latin com.not.there com.gone.byothertool \
  'bad;name' 'x$(reboot)' com.motorola.timeweatherwidget
rc 0
has_row skipped com.android.systemui;                 has "core system package"
has_row skipped com.google.android.dialer;            has "in use"
has_row skipped com.motorola.launcher3
has_row skipped com.google.android.inputmethod.latin
has_row skipped com.not.there;                        has "not on this phone"
has_row skipped com.gone.byothertool;                 has "already removed for this user"
has "not a package name"
has_row removed com.motorola.timeweatherwidget
field com.android.systemui installed true
field com.google.android.dialer installed true
if ctl log | grep -Eq 'bad|reboot|;|\$'; then bad "unchecked text reached the phone's shell"; else ok; fi
run remove; rc 1; has "name at least one package"
run --force remove com.google.android.dialer; has_row removed com.google.android.dialer

# ---------------------------------------------------------------------------
t "removing a regular app needs a yes, because it cannot be undone"
fresh
run_in 'n\n' remove com.spotify.music; has "deletes their data"; has "Nothing was changed."
field com.spotify.music installed true
run_in 'y\n' remove com.spotify.music; has_row uninstalled com.spotify.music
field com.spotify.music installed absent
run remove com.google.android.youtube; hasnt "deletes their data"; has_row removed com.google.android.youtube

# ---------------------------------------------------------------------------
t "mute keeps the app and silences it; restore lifts it"
fresh
run mute com.motorola.moto; rc 0; has_row silenced com.motorola.moto
has "notifications and background use blocked"
field com.motorola.moto installed true
field com.motorola.moto notif_perm false
logged com.motorola.moto muted
run scan; in_section "ALREADY OFF" "silenced, by this tool"
run restore com.motorola.moto; has_row allowed com.motorola.moto
field com.motorola.moto notif_perm true
field com.motorola.moto ops '{}'
run mute com.glance.lockscreen; rc 2; has_row FAILED com.glance.lockscreen
run mute com.android.systemui; has_row skipped com.android.systemui

# ---------------------------------------------------------------------------
t "inspect names what is on screen and who is notifying"
fresh
run inspect; rc 0
has "window  NotificationShade"
has "Nothing removable is in front"
has "In front: com.motorola.launcher3 (it is the home screen, phone, messaging or keyboard app in use)."
has "com.glance.lockscreen/com.glance.lockscreen.FeedWallpaper"
has "com.motorola.ccc.notification"
has "2 up; under REMOVE: Motorola's own promotional notifications"
has "3 up; put there by com.dti.folderlauncher"
ctl top 'focus="com.candy.game/com.candy.game.Main"' 'focused_app="com.candy.game/com.candy.game.Main"'
run inspect; has "In front: com.candy.game"; has "What it is: put there by com.dti.folderlauncher"
has "Remove it:  debloat.sh remove com.candy.game"
# An app drawing on the lock screen, as Glance does: Android's window, the app's activity.
ctl top 'focus="NotificationShade"' 'focused_app="com.glance.lockscreen/com.glance.spaceapp.Overlay"'
run inspect; has "In front: com.glance.lockscreen"; has "What it is: under REMOVE: Glance lock screen feed"
has "It is drawing on the lock screen or notification panel."
changed_nothing

# ---------------------------------------------------------------------------
t "watch reports installs as they happen and who made them"
fresh
run -y apply
ctl top 'appear_after={"com.late.game":{"calls":1,"installer":"com.dti.folderlauncher"},"com.motorola.help":{"calls":2,"installer":"null"}}'
DEBLOAT_WATCH_ROUNDS=3 run --every 1 watch; rc 0
has "NEW   com.late.game, installed by com.dti.folderlauncher"
has "                Digital Turbine: silently installs and reinstalls sponsored apps"
has "BACK  com.motorola.help, installed by adb or the system"
run --every soon watch; rc 1; has "whole number of seconds"

# ---------------------------------------------------------------------------
t "your own rules override the built-in ones"
fresh
printf 'keep ^com\\.motorola\\.help$ I use it\r\nsafe\t^com\\.motorola\\.timeweatherwidget$\tClock widget I do not use' \
  > "$DEBLOAT_STATE_DIR/rules.local.tsv"
run scan
in_section "KEPT ON PURPOSE" "I use it"
not_in_section "REMOVE" com.motorola.help
in_section "REMOVE" "Clock widget I do not use"
run -y apply
field com.motorola.help installed true
field com.motorola.timeweatherwidget installed false

# ---------------------------------------------------------------------------
t "a broken rules file is refused before anything is touched"
fresh
echo 'installer ^com\.pushy\. Pushy app pusher' > "$DEBLOAT_STATE_DIR/rules.local.tsv"
ctl add com.pushed.game installer=com.pushy.store
run scan; in_section "ADDED BY A SPONSORED" com.pushed.game
echo 'delete ^com\.foo\. Bad tier' > "$DEBLOAT_STATE_DIR/rules.local.tsv"
run -y apply; rc 1; has "unknown tier 'delete'"; changed_nothing
echo 'safe ^com\.(foo Unbalanced' > "$DEBLOAT_STATE_DIR/rules.local.tsv"
run -y apply; rc 1; has "does not compile"; changed_nothing
echo 'safe ^com\.foo\d+ Uses a digit escape' > "$DEBLOAT_STATE_DIR/rules.local.tsv"
run -y apply; rc 1; has "plain patterns"; changed_nothing
echo 'safe ^com\.foo\.' > "$DEBLOAT_STATE_DIR/rules.local.tsv"
run -y apply; rc 1; has "needs a pattern and a reason"; changed_nothing

# ---------------------------------------------------------------------------
t "a log from the first version of the tool is still honoured"
fresh
ctl set com.motorola.help installed=false
echo com.motorola.help > "$DEBLOAT_STATE_DIR/FAKE123.removed"
run restore; rc 0; has_row restored com.motorola.help
field com.motorola.help installed true

# ---------------------------------------------------------------------------
t "a dropped cable stops the run and is never read as a removal"
fresh
ctl top 'drop_after_cmd="pm uninstall"'
run -y apply; rc 1
has "lost the connection to the phone"
logged com.LogiaGroup.LogiaDeck none
hasnt "removed       com.dti"
ctl top 'down=false'
run -y apply; rc 2
has_row removed com.motorola.help
run scan; in_section "ALREADY OFF" "com.LogiaGroup.LogiaDeck"

# ---------------------------------------------------------------------------
# On a terminal the tool adds colour, fits its layout to the width and expects
# typed answers. in_terminal.py runs it inside a pseudo-terminal to reach that.
ESC="$(printf '\033')"
terminal() {
  local columns="$1" answers="$2"
  shift 2
  python3 "$HERE/in_terminal.py" "$columns" "$answers" "$SH" "$ROOT/debloat.sh" "$@" > "$WORK/raw.txt" 2>&1
  RC=$?
  sed "s/$ESC\[[0-9;]*m//g" "$WORK/raw.txt" > "$OUT"
}

t "in an 80-column terminal: bold headings, nothing runs off the edge"
fresh
terminal 80 "" scan; rc 0
if grep -q "$ESC\[1m== REMOVE" "$WORK/raw.txt"; then ok; else bad "headings should be bold on a terminal"; fi
WIDEST="$(awk '/^Saved to:/ { exit } { if (length($0) > m) m = length($0) } END { print m + 0 }' "$OUT")"
if [ "$WIDEST" -le 80 ]; then ok; else bad "a report line is $WIDEST columns wide in an 80-column terminal"; fi
has "      Digital Turbine: silently installs and reinstalls sponsored apps"
if grep -q "$ESC" "$DEBLOAT_STATE_DIR/FAKE123/scan.txt"; then bad "the saved scan should have no colour codes"; else ok; fi

t "in a wide terminal: package and reason share a line"
terminal 160 "" scan; rc 0
has "  com.dti.folderlauncher                         Digital Turbine: silently installs"

t "typed answers at the prompts"
fresh
terminal 80 "n" apply; rc 0; has "Nothing was changed."; changed_nothing
terminal 80 "p,y,n,q" apply
field com.LogiaGroup.LogiaDeck installed false
field com.dti.folderlauncher enabled true
has "stopped"
terminal 80 "y" apply; rc 2
field com.motorola.help installed false
WIDEST="$(awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }' "$OUT")"
if [ "$WIDEST" -le 80 ]; then ok; else bad "an apply line is $WIDEST columns wide in an 80-column terminal"; fi

# ---------------------------------------------------------------------------
t "a listing in an unexpected form is called out, not shown as empty"
fresh
ctl top 'odd_listing=true'
run scan; rc 0
has "this phone did not say which app installed what"
has "no folder hints"
run -y sponsored; rc 1; has "sponsored apps cannot be picked out"; changed_nothing
run -y apply; has_row removed com.motorola.help

# ---------------------------------------------------------------------------
t "a pattern the system grep rejects stops the run instead of emptying lists"
fresh
mkdir -p "$WORK/brokengrep"
printf '#!/bin/sh\necho "grep: empty (sub)expression" >&2\nexit 2\n' > "$WORK/brokengrep/grep"
chmod +x "$WORK/brokengrep/grep"
PATH="$WORK/brokengrep:$PATH" run scan; rc 1
has "cannot read one of the tool's own patterns"
changed_nothing

# ---------------------------------------------------------------------------
# The app. Everything here runs with its own home folder, so that nothing is
# read from or left in the real one, and with CI set, which keeps the launcher
# from putting up a dialog when a test makes it fail on purpose.
APPNAME="MAXAPACITY Debloat"
FAKEHOME="$WORK/home"
SUPPORT="$FAKEHOME/Library/Application Support/$APPNAME"
mkdir -p "$FAKEHOME" "$WORK/mac"
printf '#!/bin/sh\necho Darwin\n' > "$WORK/mac/uname"
chmod +x "$WORK/mac/uname"
WANT_VERSION="$(sed -n 's/^VERSION="\(.*\)"$/\1/p' "$ROOT/debloat.sh" | sed -n '1p')"

# has_app_files APP: what every build of the app must hold.
has_app_files() {
  local f
  for f in Contents/Info.plist Contents/MacOS/debloat-app Contents/Resources/debloat.sh \
    Contents/Resources/rules.tsv Contents/Resources/gui/server.mjs Contents/Resources/gui/ui.html \
    Contents/Resources/gui/magic.js Contents/Resources/AppIcon.icns; do
    if [ -f "$1/$f" ]; then ok; else bad "the app should contain $f"; fi
  done
  if [ -x "$1/Contents/MacOS/debloat-app" ]; then ok; else bad "the launcher should be executable"; fi
  if [ "$(head -c 4 "$1/Contents/Resources/AppIcon.icns")" = icns ]; then ok; else bad "the icon should be an .icns file"; fi
  if python3 -c 'import plistlib, sys
d = plistlib.load(open(sys.argv[1], "rb"))
assert d["CFBundleIdentifier"] == "com.maxapacity.debloat"
assert d["CFBundleExecutable"] == "debloat-app"
assert d["CFBundleIconFile"] == "AppIcon"
assert d["CFBundleShortVersionString"] == sys.argv[2] == d["CFBundleVersion"]' "$1/Contents/Info.plist" "$WANT_VERSION" 2>> "$OUT"; then
    ok
  else bad "Info.plist should be valid and carry version $WANT_VERSION"; fi
}

t "install.sh --bundle builds the app anywhere, with its icon and nothing about this machine"
BUNDLED="$WORK/bundle/$APPNAME.app"
HOME="$FAKEHOME" "$SH" "$ROOT/install.sh" --bundle "$WORK/bundle" > "$OUT" 2>&1; RC=$?
rc 0; has "Built $APPNAME $WANT_VERSION"
has_app_files "$BUNDLED"
if [ -e "$BUNDLED/Contents/Resources/paths" ]; then bad "an app built for download must not note this machine's paths"; else ok; fi
HOME="$FAKEHOME" "$SH" "$ROOT/install.sh" --bundle > "$OUT" 2>&1; RC=$?
rc 1; has "--bundle needs a folder"
HOME="$FAKEHOME" "$SH" "$ROOT/install.sh" --nonsense > "$OUT" 2>&1; RC=$?
rc 1; has "unknown option"

# Installing is for macOS. Elsewhere a stand-in uname lets it be tested too.
t "install.sh installs the app, updates it, and refuses to replace a stranger"
fresh
APP="$WORK/Applications/$APPNAME.app"
build_app() {
  HOME="$FAKEHOME" DEBLOAT_APP_DIR="$WORK/Applications" PATH="$WORK/mac:$PATH" "$SH" "$ROOT/install.sh" > "$OUT" 2>&1
  RC=$?
}
build_app; rc 0; has "Installed $APPNAME $WANT_VERSION"
has_app_files "$APP"
# An app does not get the Terminal's PATH, so the build notes where adb was.
if grep -qx "$HERE/bin" "$APP/Contents/Resources/paths" 2>/dev/null; then ok; else bad "the app should note where adb is"; fi
build_app; rc 0                                   # again: an update in place
mkdir -p "$WORK/Other/$APPNAME.app/Contents"
echo "someone else's app" > "$WORK/Other/$APPNAME.app/Contents/Info.plist"
HOME="$FAKEHOME" DEBLOAT_APP_DIR="$WORK/Other" PATH="$WORK/mac:$PATH" "$SH" "$ROOT/install.sh" > "$OUT" 2>&1; RC=$?
rc 1; has "is not this app"
if [ -f "$WORK/Other/$APPNAME.app/Contents/Info.plist" ]; then ok; else bad "a stranger's app must be left alone"; fi
HOME="$FAKEHOME" DEBLOAT_APP_DIR="$WORK/Other" "$SH" "$ROOT/uninstall.sh" > "$OUT" 2>&1; RC=$?
rc 1; has "leaving it alone"

if command -v node >/dev/null 2>&1; then
  PORT=$((21000 + $$ % 20000))
  # Prints what the helper answers; fails when nothing is listening.
  helper_get() {
    node -e '
      const [port, path, token] = process.argv.slice(1);
      const headers = token ? { "x-debloat-token": token } : {};
      require("http").get({ host: "127.0.0.1", port, path, headers }, res => res.pipe(process.stdout))
        .on("error", () => process.exit(1));
    ' "$PORT" "$@" 2>/dev/null
  }
  # Is anything listening? Unlike a request, this does not keep the helper up.
  helper_listening() {
    node -e '
      const socket = require("net").connect(Number(process.argv[1]), "127.0.0.1");
      socket.on("connect", () => { socket.destroy(); process.exit(0); });
      socket.on("error", () => process.exit(1));
    ' "$PORT" 2>/dev/null
  }
  # launch APP [NAME=value...]: start the app's launcher as macOS would, with
  # none of the Terminal's PATH, plus whatever the test adds.
  launch() {
    local app="$1"
    shift
    env PATH="/usr/bin:/bin" HOME="$FAKEHOME" CI=1 SHELL=/nonexistent DEBLOAT_GUI_PORT="$PORT" \
      DEBLOAT_GUI_GRACE_MS=8000 DEBLOAT_GUI_IDLE_MS=1000 ${1+"$@"} \
      "$app/Contents/MacOS/debloat-app" --no-open > "$OUT" 2>&1
    RC=$?
  }
  # Waits for the helper's page, then for its answer about the phone.
  PAGE=""
  TOKEN=""
  helper_up() {
    PAGE=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      PAGE="$(helper_get /)" && [ -n "$PAGE" ] && break
      sleep 0.3
    done
    case "$PAGE" in
      *"<title>$APPNAME</title>"*) ok ;;
      *) bad "the launcher should bring the helper up"; cat "$FAKEHOME/Library/Logs/maxapacity-debloat.log" 2>/dev/null ;;
    esac
    TOKEN="$(printf '%s\n' "$PAGE" | sed -n 's/.*name="debloat-token" content="\([0-9a-f]*\)".*/\1/p')"
    case "$(helper_get /api/phones "$TOKEN")" in
      *FAKE123*) ok ;;
      *) bad "the helper should reach the phone through adb" ;;
    esac
  }
  # With nobody at its window, the helper stops by itself.
  helper_stops() {
    local stopped=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
      if ! helper_listening; then
        stopped=1
        break
      fi
      sleep 0.3
    done
    if [ "$stopped" -eq 1 ]; then ok; else bad "the helper should stop once nobody has its window open"; fi
  }

  t "the installed app starts its helper on its own, finding node and adb where install.sh noted them"
  launch "$APP"; rc 0                             # it returned: the helper runs by itself
  helper_up
  helper_stops

  t "the downloaded app finds node and adb through the shell, and outlives its own folder"
  # No note of where things are; the shell the Terminal uses knows.
  NODE_DIR="$(dirname "$(command -v node)")"
  printf '#!/bin/sh\necho "noise from a start-up file"\nprintf "\\n__DEBLOAT_PATH__%%s__END__\\n" "%s:%s:/usr/bin:/bin"\n' \
    "$NODE_DIR" "$HERE/bin" > "$WORK/fakeshell"
  chmod +x "$WORK/fakeshell"
  rm -rf "${SUPPORT:?}"
  launch "$BUNDLED" SHELL="$WORK/fakeshell"; rc 0
  helper_up
  case "$PAGE" in
    *"name=\"debloat-version\" content=\"$WANT_VERSION\""*) ok ;;
    *) bad "the page should carry version $WANT_VERSION" ;;
  esac
  if [ -f "$SUPPORT/app/debloat.sh" ] && [ -f "$SUPPORT/app/gui/server.mjs" ] && [ -f "$SUPPORT/app/gui/magic.js" ]; then ok; else bad "the app should run from a copy in its support folder"; fi
  # macOS takes a downloaded app's temporary folder away once the app has
  # finished, which for this one is at once. The helper must not notice.
  rm -rf "${WORK:?}/bundle"
  case "$(helper_get /api/scan "$TOKEN")" in
    *'"ok":true'*) ok ;;
    *) bad "the helper should go on working after the app's folder has gone" ;;
  esac
  case "$(helper_get /)" in
    *"<title>$APPNAME</title>"*) ok ;;
    *) bad "the helper should go on serving its page after the app's folder has gone" ;;
  esac
  helper_stops
  HOME="$FAKEHOME" "$SH" "$ROOT/install.sh" --bundle "$WORK/bundle" > /dev/null 2>&1

  t "the launcher says so when the helper cannot start, instead of doing nothing"
  cp -R "$WORK/bundle" "$WORK/broken"
  echo 'this is not a program (' > "$WORK/broken/$APPNAME.app/Contents/Resources/gui/server.mjs"
  launch "$WORK/broken/$APPNAME.app" SHELL="$WORK/fakeshell"; rc 1
  has "could not start"
  if helper_listening; then bad "nothing should be left running"; else ok; fi

  # The next two depend on adb not being somewhere the launcher looks first.
  if [ -x /opt/homebrew/bin/adb ] || [ -x /usr/local/bin/adb ] || [ -x /usr/bin/adb ] || [ -x /bin/adb ]; then
    printf '  (skipped two launcher tests: this machine has an adb of its own in a usual place)\n'
  else
    t "the downloaded app finds adb where Android Studio keeps it"
    mkdir -p "$FAKEHOME/Library/Android/sdk/platform-tools" "$FAKEHOME/platform-tools"
    printf '#!/bin/sh\nexec "%s/bin/adb" "$@"\n' "$HERE" > "$FAKEHOME/Library/Android/sdk/platform-tools/adb"
    chmod +x "$FAKEHOME/Library/Android/sdk/platform-tools/adb"
    ln -s "$(command -v node)" "$FAKEHOME/platform-tools/node"   # stands in for a node in a usual place
    launch "$BUNDLED"; rc 0
    helper_up
    helper_stops
    rm -rf "${FAKEHOME:?}/Library/Android" "${FAKEHOME:?}/platform-tools"

    t "the launcher says what is missing instead of opening a dead window"
    launch "$BUNDLED" HOME="$WORK/emptyhome"; rc 1
    has "needed"
    if helper_listening; then bad "nothing should have been started"; else ok; fi
  fi
else
  printf '  (skipped: no node here)\n'
fi

t "tools/package.sh makes the two downloads, and the app in its zip can still be run"
if command -v zip >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
  HOME="$FAKEHOME" "$SH" "$ROOT/tools/package.sh" "$WORK/dist" > "$OUT" 2>&1; RC=$?
  rc 0
  APP_ZIP="$WORK/dist/MAXAPACITY-Debloat-$WANT_VERSION-mac.zip"
  SRC_ZIP="$WORK/dist/maxapacity-debloat-$WANT_VERSION.zip"
  if [ -s "$APP_ZIP" ] && [ -s "$SRC_ZIP" ]; then ok; else bad "both zips should be written"; fi
  # Alone in its zip: unzipping must leave the app itself, not a folder around it.
  if [ "$(unzip -Z -1 "$APP_ZIP" | cut -d/ -f1 | sort -u)" = "$APPNAME.app" ]; then ok; else bad "the app zip should hold the app and nothing else"; fi
  mkdir -p "$WORK/unzipped"
  unzip -q "$APP_ZIP" -d "$WORK/unzipped"
  has_app_files "$WORK/unzipped/$APPNAME.app"
  for f in install.sh uninstall.sh debloat.sh rules.tsv gui/server.mjs gui/ui.html gui/magic.js app/launcher.sh app/Info.plist app/AppIcon.icns; do
    if unzip -Z -1 "$SRC_ZIP" | grep -qx "$APPNAME/$f"; then ok; else bad "the tool zip should hold $f"; fi
  done
else
  printf '  (skipped: no zip here)\n'
fi

t "uninstall.sh removes the app and its working copy, and nothing else"
mkdir -p "$SUPPORT/app"
HOME="$FAKEHOME" DEBLOAT_APP_DIR="$WORK/Applications" "$SH" "$ROOT/uninstall.sh" > "$OUT" 2>&1; RC=$?
rc 0; has "Removed $APP"; has "working copy"
if [ -e "$APP" ] || [ -e "$SUPPORT" ]; then bad "the app and its working copy should be gone"; else ok; fi
HOME="$FAKEHOME" DEBLOAT_APP_DIR="$WORK/Applications" "$SH" "$ROOT/uninstall.sh" > "$OUT" 2>&1; RC=$?
rc 0; has "Nothing to remove"

# ---------------------------------------------------------------------------
# The community list, served from a file in place of the network.
LIST="$WORK/uad_lists.json"
export DEBLOAT_COMMUNITY_URL="file://$LIST"
COMMUNITY="$DEBLOAT_STATE_DIR/community.tsv"
TAB="$(printf '\t')"
cat > "$LIST" <<'JSON'
{
  "com.motorola.timeweatherwidget": {
    "list": "Oem",
    "description": "Time and weather \"widget\".\nSafe to remove.",
    "dependencies": [],
    "neededBy": [],
    "labels": [],
    "removal": "Recommended"
  },
    "com.motorola.mystery": {
    "list": "Oem",
    "description": "Does something\tnobody is sure of.",
    "removal": "Expert"
  },
  "com.motorola.help": {
    "list": "Oem",
    "description": "The list would remove what a built-in rule decides.",
    "removal": "Recommended"
  },
  "com.motorola.launcher3": {
    "list": "Oem",
    "description": "The home screen.",
    "removal": "Recommended"
  },
  "com.glance.lockscreen; reboot": {
    "list": "Oem",
    "description": "Not a package name.",
    "removal": "Recommended"
  },
  "com.unrated.thing": {
    "list": "Oem",
    "description": "A rating this tool does not know.",
    "removal": "Whenever"
  }
}
JSON

t "scan points to the community list while it is not in use"
fresh
run scan; rc 0; has "debloat.sh community"

t "community needs no phone and saves what it understood"
fresh
ctl top 'devices=[]'
run community; rc 0
has "Saved the community list: 4 packages"
has "3 it recommends removing"
if [ "$(wc -l < "$COMMUNITY" | tr -d ' ')" -eq 4 ]; then ok; else bad "community.tsv should hold 4 rows"; fi
if grep -q 'reboot' "$COMMUNITY" || grep -q 'unrated' "$COMMUNITY"; then
  bad "a name that is not a package, or an unknown rating, must be left out"
else ok; fi
if grep -q "^com.motorola.mystery${TAB}note${TAB}community list, expert: Does something nobody is sure of.\$" "$COMMUNITY"; then
  ok
else bad "an Expert entry should be a note, in one line of plain text"; fi

t "what the list recommends joins ASK FIRST; the rest explains NOT CLASSIFIED"
fresh
run community; rc 0
run scan; rc 0
in_section "ASK FIRST" "com.motorola.timeweatherwidget"
in_section "ASK FIRST" 'community list: Time and weather "widget". Safe to remove.'
not_in_section "REMOVE" "com.motorola.timeweatherwidget"
has "== NOT CLASSIFIED (1)"
in_section "NOT CLASSIFIED" "community list, expert: Does something nobody is sure of."
hasnt "To learn what most of those are"

t "the built-in rules and the core packages win over the community list"
not_in_section "ASK FIRST" "com.motorola.help"
in_section "REMOVE" "Device Help app and its tips"
not_in_section "ASK FIRST" "com.motorola.launcher3"

t "apply leaves the community list's picks alone without --caution"
run -n -y apply; rc 0; hasnt "com.motorola.timeweatherwidget"
run -n -y apply --caution; rc 0; has "com.motorola.timeweatherwidget"

t "a list that cannot be read, or fetched, leaves the copy in use alone"
cp "$COMMUNITY" "$WORK/before.tsv"
printf '{"minified":{"removal":"Recommended"}}\n' > "$LIST"
run community; rc 1; has "not in the form this tool reads"
if cmp -s "$COMMUNITY" "$WORK/before.tsv"; then ok; else bad "community.tsv should be unchanged"; fi
rm -f "$LIST"
run community; rc 1; has "could not download the community list"
if cmp -s "$COMMUNITY" "$WORK/before.tsv"; then ok; else bad "community.tsv should be unchanged"; fi

t "community off stops using it"
run community off; rc 0; has "no longer used"
if [ -e "$COMMUNITY" ]; then bad "community.tsv should be gone"; else ok; fi
run community off; rc 0; has "was not in use"
run scan; rc 0; has "== NOT CLASSIFIED (2)"
run community com.example.app; rc 1; has "takes no package names"

# ---------------------------------------------------------------------------
t "a phone with hundreds of apps is still quick"
fresh
ctl bulk 600
START=$(date +%s)
run scan; rc 0; has "== NOT CLASSIFIED (602)"
TOOK=$(( $(date +%s) - START ))
if [ "$TOOK" -le 20 ]; then ok; else bad "scan of 630 packages took ${TOOK}s"; fi

# ---------------------------------------------------------------------------
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
