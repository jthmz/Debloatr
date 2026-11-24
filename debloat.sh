#!/usr/bin/env bash
#
# MAXAPACITY debloat
#
# Removes preinstalled junk from an Android phone over adb: carrier and maker
# preloads, lock screen feeds, and the hidden installer apps that put removed
# apps back. No root and no unlocked bootloader needed.
#
# Nothing is deleted from the system image. Preinstalled packages are removed
# "for the current user", so `restore` (or a factory reset) brings them back.
# Usage and the reasoning behind each step are in README.md next to this file.
#
# Written for the bash 3.2 and BSD tools that ship with macOS; runs the same
# on Linux. test/run.sh exercises every command against a simulated phone.

VERSION="1.3.0"

set -u
set -f
set -o pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd)" || exit 1
RULES_BUILTIN="$HERE/rules.tsv"
STATE_ROOT="${DEBLOAT_STATE_DIR:-$HOME/.maxapacity-debloat}"
RULES_LOCAL="$STATE_ROOT/rules.local.tsv"
# The community list, once `debloat.sh community` has fetched it:
# "package<TAB>caution|note<TAB>what the list says about it". It is the package
# list of Universal Android Debloater Next Generation, which that project
# publishes under the GPL-3.0; it is downloaded, never shipped with this tool.
COMMUNITY="$STATE_ROOT/community.tsv"
COMMUNITY_URL="${DEBLOAT_COMMUNITY_URL:-https://raw.githubusercontent.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation/main/resources/assets/uad_lists.json}"
TAB="$(printf '\t')"

# What a package name looks like. Everything sent to the phone is checked
# against this first, because `adb shell` hands its arguments to a shell there.
PKG_RE='^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$'

# Never changed by a rule, and refused by `remove` and `mute` without --force:
# Android itself, Google Play services and the system modules, chipset
# services, and the Motorola pieces the phone needs to update, set up, show a
# home screen and stay on the carrier's network.
PROTECTED='^(android|com\.android\..*|com\.google\.android\.(gms|gms\..*|gsf|ext\..*|permissioncontroller|packageinstaller|setupwizard|webview|trichromelibrary|modulemetadata|networkstack.*|cellbroadcast.*|documentsui|providers\..*|overlay\..*|partnersetup|configupdater|onetimeinitializer|tts|as|as\..*)|com\.google\.mainline\..*|com\.qualcomm\..*|com\.qti\..*|vendor\.qti\..*|org\.codeaurora\..*|com\.quicinc\..*|com\.mediatek\..*|com\.motorola\.android\..*|com\.motorola\.(ccc\.ota|launcher3|launcherconfig|setup|entitlement|coresettingsext|carriersettingsext|msimsettings|faceunlock)|com\.motorola\.omadm\..*|com\.motorola\.vzw\..*)$'

# Installers that are expected: app stores the owner chose, the system
# installer (browser and file-manager installs), adb (shown as null, or as
# nothing at all, which is dropped before this is applied) and the maker's own
# system updater. No empty alternative here: BSD grep, the one on macOS,
# rejects "(|a)" as an error where GNU grep accepts it.
TRUSTED_INSTALLER='^(null|com\.android\.vending|com\.google\.android\.packageinstaller|com\.android\.packageinstaller|com\.android\.shell|org\.fdroid\.fdroid|com\.aurora\.store|com\.amazon\.venezia|com\.sec\.android\.app\.samsungapps|com\.motorola\.ccc\.ota)$'

SERIAL=""
YES=0
DRY=0
CAUTION=0
FORCE=0
COLOR=auto
TSV=0
EVERY=5
CMD=""
PKGS=""

N_REMOVED=0
N_OFF=0
N_MUTED=0
N_RESTORED=0
N_MANUAL=0
N_SKIPPED=0
N_FAILED=0
LOCKED=0

HAVE_INSTALLERS=1
HAVE_PATHS=1
WIDTH=0
OUTCOME=""
DETAIL=""
CHOICE=""
TMP=""

C_BOLD=""
C_DIM=""
C_RED=""
C_GREEN=""
C_YELLOW=""
C_OFF=""

# ---- Output ---------------------------------------------------------------

say() { printf '%s\n' "$*"; }

warn() { printf '%s\n' "$*" >&2; }

die() {
  printf '%s\n' "${C_RED}error:${C_OFF} $*" >&2
  exit 1
}

usage() {
  cat <<EOF
MAXAPACITY debloat $VERSION
Remove preinstalled junk from an Android phone over adb, including the hidden
installers that put removed apps back. No root needed; changes can be undone.

Usage: debloat.sh [options] <command> [package ...]

Look (changes nothing)
  scan               Full report: what would be removed and why, what another
                     app installed, what has come back, what is unclassified
  inspect            What is on screen right now and which apps have
                     notifications up. Run it while the junk is showing
  watch              Keep running and report every app that gets installed,
                     and which app installed it

More rules (needs no phone)
  community          Download the community list of preinstalled apps, which
                     covers many more makers. What it recommends removing
                     joins ASK FIRST; the rest explains NOT CLASSIFIED
  community off      Stop using it and delete the downloaded copy

Change (asks first)
  apply              Remove everything listed under REMOVE in the scan
                     (--caution also takes the ASK FIRST list)
  sponsored          Uninstall the apps a sponsored-app installer added
  reapply            Remove again whatever has come back since you removed it
  remove PKG ...     Remove the named packages
  mute PKG ...       Keep an app but block its notifications and background use
  restore [PKG ...]  Undo. With no package: everything this tool changed
  restart            Restart the phone, so its lock and home screens catch up

Options
  -s, --serial ID    Which phone, when more than one is attached
  -y, --yes          Do not ask before changing things
  -n, --dry-run      Show what would happen; change nothing
      --caution      With apply: include the ASK FIRST list
      --force        With remove and mute: allow core and in-use packages
      --every SECS   With watch: seconds between checks (default 5)
      --no-color     Plain output
      --tsv          With scan: tab-separated lists for other programs
  -h, --help         This text
      --version      Version

Start with: debloat.sh scan
EOF
}

setup_color() {
  if [ "$COLOR" = auto ]; then
    if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
      COLOR=1
    else
      COLOR=0
    fi
  fi
  if [ "$COLOR" = 1 ]; then
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_OFF=$'\033[0m'
  fi
}

# One result line: status word, package, optional note. Colour marks the
# outcome only: green done, yellow partial, red failed, dim nothing happened.
row() {
  local status="$1" pkg="$2" note="${3:-}" c=""
  case "$status" in
    removed | uninstalled | restored | allowed) c="$C_GREEN" ;;
    "switched off" | silenced | "not restored") c="$C_YELLOW" ;;
    FAILED) c="$C_RED" ;;
    *) c="$C_DIM" ;;
  esac
  if [ -z "$note" ]; then
    printf '  %s%-13s%s %s\n' "$c" "$status" "$C_OFF" "$pkg"
  elif [ "$WIDTH" -gt 0 ] && [ $((62 + ${#note})) -gt "$WIDTH" ]; then
    # Too wide for this terminal: the note goes under the package, wrapped.
    printf '  %s%-13s%s %s\n' "$c" "$status" "$C_OFF" "$pkg"
    printf '%s\n' "$note" | fold -s -w "$((WIDTH > 36 ? WIDTH - 17 : 20))" | sed 's/^/                /'
  else
    printf '  %s%-13s%s %-44s %s\n' "$c" "$status" "$C_OFF" "$pkg" "$note"
  fi
}

heading() { printf '%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

first_line() { printf '%s\n' "$1" | sed -n '1p' | cut -c1-160; }

in_file() { grep -qxF -- "$1" "$2" 2>/dev/null; }

valid_pkg() { printf '%s\n' "$1" | grep -Eq -- "$PKG_RE"; }

# ---- Talking to the phone -------------------------------------------------

adb_() {
  if [ -n "$SERIAL" ]; then adb -s "$SERIAL" "$@"; else adb "$@"; fi
}

# Run a command on the phone. stdin is closed so adb cannot swallow the input
# of a loop or a prompt; carriage returns are stripped.
phone() { adb_ shell "$@" </dev/null 2>&1 | tr -d '\r'; }

link_ok() { [ "$(adb_ get-state 2>/dev/null | tr -d '\r')" = device ]; }

lost_link() {
  link_ok || die "lost the connection to the phone. Plug it back in and run the command again; it picks up where it stopped."
  die "the phone stopped answering. Unlock it and run the command again."
}

# Like phone, for queries that have to work.
ask_phone() {
  local out
  if ! out="$(phone "$@")"; then
    link_ok || die "lost the connection to the phone. Plug it back in and run the command again."
    die "the phone refused: $* ($(first_line "$out"))"
  fi
  printf '%s\n' "$out"
}

pick_device() {
  command -v adb >/dev/null 2>&1 \
    || die "adb is not installed. On a Mac: brew install android-platform-tools"
  local listing count state
  listing="$(adb devices 2>/dev/null | tr -d '\r' \
    | awk 'seen && NF == 2 { print $1 "\t" $2 } /^List of devices/ { seen = 1 }')"
  count="$(printf '%s\n' "$listing" | grep -c .)"
  if [ -n "$SERIAL" ]; then
    state="$(printf '%s\n' "$listing" | awk -F'\t' -v s="$SERIAL" '$1 == s { print $2 }')"
    [ -n "$state" ] || die "no phone with serial $SERIAL is attached (check with: adb devices)"
  else
    [ "$count" -gt 0 ] || die "no phone found. Plug it in, turn on USB debugging (Settings > System > Developer options) and accept the prompt on the phone."
    if [ "$count" -gt 1 ]; then
      warn "More than one phone is attached. Pick one with -s <serial>:"
      printf '%s\n' "$listing" | sed 's/^/  /' >&2
      exit 1
    fi
    SERIAL="${listing%%"$TAB"*}"
    state="${listing#*"$TAB"}"
  fi
  case "$state" in
    device) ;;
    unauthorized) die "the phone has not allowed this computer yet. Unlock it, tap Allow on the 'Allow USB debugging?' prompt, then run this again." ;;
    offline) die "the phone is offline. Unplug it, plug it back in and try again." ;;
    *) die "the phone is in '$state' mode. Start it normally into Android and try again." ;;
  esac
}

start_session() {
  pick_device
  STATE="$STATE_ROOT/$SERIAL"
  mkdir -p "$STATE" || die "cannot create $STATE"
  LOG="$STATE/changes.tsv"
  if [ ! -f "$LOG" ] && [ -s "$STATE_ROOT/$SERIAL.removed" ]; then
    # Log from the first version of this tool: one package per line.
    awk -v OFS='\t' 'NF { print $1, "removed", "-" }' "$STATE_ROOT/$SERIAL.removed" > "$LOG"
  fi
  [ -f "$LOG" ] || : > "$LOG"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/debloat.XXXXXX")" || die "cannot create a temporary folder"
  trap 'if [ -n "$TMP" ]; then rm -rf "$TMP"; fi' EXIT

  USER_ID="$(phone am get-current-user | sed -n '1p')"
  case "$USER_ID" in '' | *[!0-9]*) USER_ID=0 ;; esac
  local model codename release
  model="$(phone getprop ro.product.model | sed -n '1p')"
  codename="$(phone getprop ro.product.device | sed -n '1p')"
  release="$(phone getprop ro.build.version.release | sed -n '1p')"
  PHONE="${model:-Android phone}${codename:+ ($codename)}, Android ${release:-?}"
}

# ---- Rules ----------------------------------------------------------------

# A pattern this system's grep cannot compile would make every list built with
# it come out empty without a word. Check the built-in ones up front.
check_patterns() {
  local re rc
  for re in "$PKG_RE" "$PROTECTED" "$TRUSTED_INSTALLER"; do
    printf 'x\n' | grep -Eq -- "$re" 2>/dev/null
    rc=$?
    [ "$rc" -le 1 ] || die "this computer's grep cannot read one of the tool's own patterns. Nothing was changed; please report this."
  done
}

# Local rules come first so the owner's choices win over the built-in list.
load_rules() {
  [ -f "$RULES_BUILTIN" ] || die "rules.tsv is missing next to debloat.sh"
  {
    if [ -f "$RULES_LOCAL" ]; then
      cat "$RULES_LOCAL"
      echo
    fi
    cat "$RULES_BUILTIN"
  } | tr -d '\r' > "$TMP/rules"
  if [ -f "$COMMUNITY" ]; then
    cat "$COMMUNITY" > "$TMP/community"
  else
    : > "$TMP/community"
  fi

  local tier re why rc rules=0
  while read -r tier re why <&3 || [ -n "$tier" ]; do
    case "$tier" in '' | '#'*) continue ;; esac
    case "$tier" in
      installer | safe | caution | keep) ;;
      *) die "rules: unknown tier '$tier' on the rule for $re (use installer, safe, caution or keep)" ;;
    esac
    if [ -z "$re" ] || [ -z "$why" ]; then
      die "rules: '$tier $re' needs a pattern and a reason"
    fi
    # The same pattern is read by grep here and by awk when classifying; these
    # two constructs are where their dialects part ways.
    case "$re" in
      *\\[A-Za-z0-9]* | *'{'*) die "rules: '$re' uses a \\d-style escape or {n,m}; keep to plain patterns" ;;
    esac
    printf 'x\n' | grep -Eq -- "$re"
    rc=$?
    [ "$rc" -le 1 ] || die "rules: pattern does not compile: $re"
    rules=$((rules + 1))
  done 3< "$TMP/rules"
  [ "$rules" -gt 0 ] || die "rules.tsv has no rules in it"
}

# $1: file of package names. Prints "package<TAB>tier<TAB>reason" using the
# first rule that matches; tier is "none" when no rule does. The community
# list is asked only then, so every rule here and in rules.local.tsv wins over
# it. It can raise a package to "caution", never further; for the rest it
# only supplies the reason, and the tier stays "none".
classify() {
  awk -v OFS='\t' '
    FILENAME == ARGV[2] {
      if (split($0, field, "\t") >= 3) {
        ctier[field[1]] = field[2]
        cwhy[field[1]] = field[3]
      }
      next
    }
    FILENAME == ARGV[1] {
      if ($0 ~ /^[ \t]*#/ || $0 ~ /^[ \t]*$/) next
      n++
      tier[n] = $1
      re[n] = $2
      w = $0
      sub(/^[ \t]*[^ \t]+[ \t]+[^ \t]+[ \t]+/, "", w)
      why[n] = w
      next
    }
    {
      t = "none"
      w = ""
      for (i = 1; i <= n; i++) {
        if ($0 ~ re[i]) {
          t = tier[i]
          w = why[i]
          break
        }
      }
      if (t == "none" && ($0 in ctier)) {
        if (ctier[$0] == "caution") t = "caution"
        w = cwhy[$0]
      }
      print $0, t, w
    }
  ' "$TMP/rules" "$TMP/community" "$1"
}

# ---- What is on the phone -------------------------------------------------

names() { sed -n 's/^package://p' | sort -u; }

# The home screen, phone and messaging apps and the keyboard in use right now.
# Taking any of them away can leave the phone unusable until another is set.
essentials() {
  local role
  {
    for role in HOME DIALER SMS; do
      phone cmd role get-role-holders --user "$USER_ID" "android.app.role.$role"
    done
    phone settings --user "$USER_ID" get secure default_input_method | sed 's|/.*$||'
  } | tr ';' '\n' | tr ',' '\n' | tr ' ' '\n' | grep -E -- "$PKG_RE" | sort -u
}

snapshot() {
  local u="$USER_ID"
  ask_phone pm list packages --user "$u" | names > "$TMP/installed" || exit 1
  [ -s "$TMP/installed" ] || die "the phone sent back an empty app list. Unlock it and try again."
  ask_phone pm list packages -s --user "$u" | names > "$TMP/system" || exit 1
  ask_phone pm list packages -3 --user "$u" | names > "$TMP/third" || exit 1
  ask_phone pm list packages -d --user "$u" | names > "$TMP/disabled" || exit 1
  ask_phone pm list packages -u --user "$u" | names > "$TMP/all" || exit 1
  # "package:com.app  installer=com.store" -> "com.app<TAB>com.store"
  ask_phone pm list packages -3 -i --user "$u" \
    | sed -n -e 's/ *$//' -e "s/^package:\([^ ]*\) *installer=\(.*\)\$/\1${TAB}\2/p" \
    | sort -u > "$TMP/installers" || exit 1
  # "package:/product/app/Foo/Foo.apk=com.foo" -> "com.foo<TAB>/product/app/Foo/Foo.apk"
  ask_phone pm list packages -s -f -u --user "$u" \
    | sed -n "s/^package:\(.*\)=\([^=]*\)\$/\2${TAB}\1/p" \
    | sort -u > "$TMP/paths" || exit 1

  # If a listing did not come back in the form read above, say so in the
  # report rather than showing an empty list as if there were nothing to find.
  HAVE_INSTALLERS=1
  if [ -s "$TMP/third" ] && [ ! -s "$TMP/installers" ]; then HAVE_INSTALLERS=0; fi
  HAVE_PATHS=1
  if [ -s "$TMP/system" ] && [ ! -s "$TMP/paths" ]; then HAVE_PATHS=0; fi

  essentials > "$TMP/essential"
  {
    grep -E -- "$PROTECTED" "$TMP/all"
    cat "$TMP/essential"
  } | sort -u > "$TMP/blocked"
  classify "$TMP/installed" > "$TMP/class"
  [ "$(count_lines "$TMP/class")" -eq "$(count_lines "$TMP/installed")" ] \
    || die "could not sort the phone's apps against the rules. Nothing was changed; please report this."
}

# stdin: lines whose first tab-separated field is a package. Drops the ones
# that must not be touched and the ones already switched off or silenced.
actionable() {
  awk -F'\t' '
    FILENAME == ARGV[1] || FILENAME == ARGV[2] { skip[$1] = 1; next }
    FILENAME == ARGV[3] { if ($2 == "muted") skip[$1] = 1; next }
    !($1 in skip)
  ' "$TMP/blocked" "$TMP/disabled" "$LOG" -
}

# Why a package must be left alone; prints nothing when it may be changed.
blocked_reason() {
  if in_file "$1" "$TMP/essential"; then
    echo "it is the home screen, phone, messaging or keyboard app in use"
  elif printf '%s\n' "$1" | grep -Eq -- "$PROTECTED"; then
    echo "core system package"
  fi
}

# Apps that were installed by something other than the owner. Writes
#   $TMP/sponsored  "app<TAB>installer"   the installer is a known sponsored-app
#                                         installer (rule tier "installer")
#   $TMP/foreign    "app<TAB>installer<TAB>what the installer is, if a rule says"
# Only the first list is ever removed in bulk. An app that merely got its last
# update from, say, Facebook's updater lands in the second and is left alone.
installer_lists() {
  cut -f2 "$TMP/installers" | awk 'NF' | sort -u | grep -Ev -- "$TRUSTED_INSTALLER" > "$TMP/inst_names"
  classify "$TMP/inst_names" > "$TMP/inst_class"
  : > "$TMP/sponsored"
  : > "$TMP/foreign"
  awk -F'\t' -v OFS='\t' -v sponsored="$TMP/sponsored" -v foreign="$TMP/foreign" '
    FILENAME == ARGV[1] { tier[$1] = $2; why[$1] = $3; next }
    FILENAME == ARGV[2] { blocked[$1] = 1; next }
    ($2 in tier) && !($1 in blocked) {
      if (tier[$2] == "installer") print $1, $2 > sponsored
      else print $1, $2, why[$2] > foreign
    }
  ' "$TMP/inst_class" "$TMP/blocked" "$TMP/installers"
}

# Logged changes that no longer hold: "package<TAB>what was done".
came_back() {
  awk -F'\t' -v OFS='\t' '
    FILENAME == ARGV[1] { inst[$1] = 1; next }
    FILENAME == ARGV[2] { off[$1] = 1; next }
    ($2 == "removed" || $2 == "uninstalled") && ($1 in inst) { print $1, $2 }
    $2 == "disabled" && ($1 in inst) && !($1 in off) { print $1, $2 }
  ' "$TMP/installed" "$TMP/disabled" "$LOG"
}

# Apps with notifications up right now: "count<TAB>package", busiest first.
notification_sources() {
  phone dumpsys notification \
    | sed -n 's/.*NotificationRecord(.*pkg=\([A-Za-z0-9_.]*\).*/\1/p' \
    | sort | uniq -c | sort -rn | awk '{ print $1 "\t" $2 }'
}

# The same, as "package<TAB>how many are up; what this tool knows about it".
# Needs installer_lists to have run.
notification_rows() {
  notification_sources > "$TMP/notif"
  awk -F'\t' -v OFS='\t' '
    BEGIN {
      label["installer"] = label["safe"] = "under REMOVE"
      label["caution"] = "under ASK FIRST"
      label["keep"] = "kept on purpose"
    }
    FILENAME == ARGV[1] { if ($2 != "none") tag[$1] = label[$2] ": " $3; next }
    FILENAME == ARGV[2] { tag[$1] = "put there by " $2; next }
    { print $2, $1 " up" (($2 in tag) ? "; " tag[$2] : "") }
  ' "$TMP/class" "$TMP/sponsored" "$TMP/notif"
}

# ---- Change log -----------------------------------------------------------

log_put() {
  {
    awk -F'\t' -v p="$1" '$1 != p' "$LOG"
    printf '%s\t%s\t%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$LOG.new"
  mv "$LOG.new" "$LOG"
}

log_del() {
  awk -F'\t' -v p="$1" '$1 != p' "$LOG" > "$LOG.new"
  mv "$LOG.new" "$LOG"
}

log_action() { awk -F'\t' -v p="$1" '$1 == p { print $2 }' "$LOG"; }

# A copy of the phone's app list before this tool first changed anything.
ensure_baseline() {
  [ -f "$STATE/baseline.txt" ] && return 0
  phone pm list packages -f -u --user "$USER_ID" > "$STATE/baseline.txt"
}

# ---- Changing one package -------------------------------------------------

# 0 when installed for this user. Stops the run if the phone stops answering,
# so a dropped cable is never mistaken for "it is gone".
is_installed() {
  local out
  out="$(phone pm list packages --user "$USER_ID" "$1")" || lost_link
  printf '%s\n' "$out" | grep -qxF -- "package:$1"
}

is_disabled() {
  local out
  out="$(phone pm list packages -d --user "$USER_ID" "$1")" || lost_link
  printf '%s\n' "$out" | grep -qxF -- "package:$1"
}

# Block an app's notifications and background activity without removing it.
# Succeeds when the background restriction took; MUTE_NOTE says whether the
# notification permission could be taken away as well.
MUTE_NOTE=""
do_mute() {
  local pkg="$1" op out
  out="$(phone pm revoke --user "$USER_ID" "$pkg" android.permission.POST_NOTIFICATIONS)"
  if [ -z "$out" ]; then
    MUTE_NOTE="notifications and background use blocked"
  else
    MUTE_NOTE="background use blocked; Android would not block its notifications, turn them off in Settings > Notifications"
  fi
  for op in POST_NOTIFICATION RUN_IN_BACKGROUND RUN_ANY_IN_BACKGROUND; do
    phone cmd appops set --user "$USER_ID" "$pkg" "$op" ignore > /dev/null
  done
  phone am force-stop --user "$USER_ID" "$pkg" > /dev/null
  out="$(phone cmd appops get --user "$USER_ID" "$pkg" RUN_ANY_IN_BACKGROUND)"
  printf '%s\n' "$out" | grep -q 'ignore'
}

do_unmute() {
  local pkg="$1" op
  phone pm grant --user "$USER_ID" "$pkg" android.permission.POST_NOTIFICATIONS > /dev/null
  for op in POST_NOTIFICATION RUN_IN_BACKGROUND RUN_ANY_IN_BACKGROUND; do
    phone cmd appops set --user "$USER_ID" "$pkg" "$op" default > /dev/null
  done
}

# Take a package off the phone as far as Android allows: remove it for this
# user, else switch it off, else silence it. Sets OUTCOME to removed,
# uninstalled (a regular app: gone, not restorable from here), disabled, muted
# or failed, and DETAIL to the phone's first complaint.
do_remove() {
  local pkg="$1" out third=0
  OUTCOME=failed
  DETAIL=""
  in_file "$pkg" "$TMP/third" && third=1

  out="$(phone pm uninstall --user "$USER_ID" "$pkg")"
  if ! is_installed "$pkg"; then
    if [ "$third" -eq 1 ]; then OUTCOME=uninstalled; else OUTCOME=removed; fi
    return 0
  fi
  DETAIL="$(first_line "$out")"

  out="$(phone pm disable-user --user "$USER_ID" "$pkg")"
  if is_disabled "$pkg"; then
    OUTCOME=disabled
    return 0
  fi
  [ -n "$DETAIL" ] || DETAIL="$(first_line "$out")"

  if do_mute "$pkg"; then
    OUTCOME=muted
    return 0
  fi
  return 1
}

act_remove() {
  local pkg="$1"
  if [ "$DRY" -eq 1 ]; then
    row "would remove" "$pkg"
    return 0
  fi
  do_remove "$pkg"
  case "$OUTCOME" in
    removed)
      log_put "$pkg" removed
      row removed "$pkg"
      N_REMOVED=$((N_REMOVED + 1))
      ;;
    uninstalled)
      log_put "$pkg" uninstalled
      row uninstalled "$pkg"
      N_REMOVED=$((N_REMOVED + 1))
      ;;
    disabled)
      log_put "$pkg" disabled
      row "switched off" "$pkg" "Android would not remove it"
      N_OFF=$((N_OFF + 1))
      ;;
    muted)
      log_put "$pkg" muted
      row silenced "$pkg" "cannot be removed or switched off; $MUTE_NOTE"
      N_MUTED=$((N_MUTED + 1))
      ;;
    *)
      row FAILED "$pkg" "Android refused every option${DETAIL:+ ($DETAIL)}"
      N_FAILED=$((N_FAILED + 1))
      LOCKED=1
      ;;
  esac
}

act_mute() {
  local pkg="$1"
  if [ "$DRY" -eq 1 ]; then
    row "would silence" "$pkg"
    return 0
  fi
  if do_mute "$pkg"; then
    log_put "$pkg" muted
    row silenced "$pkg" "$MUTE_NOTE"
    N_MUTED=$((N_MUTED + 1))
  else
    link_ok || lost_link
    row FAILED "$pkg" "the phone would not restrict it"
    N_FAILED=$((N_FAILED + 1))
    LOCKED=1
  fi
}

# $2: what this tool did to it (from the log), or "unknown" for a package
# another tool removed.
act_restore() {
  local pkg="$1" action="$2" out
  if [ "$DRY" -eq 1 ]; then
    row "would restore" "$pkg"
    return 0
  fi
  case "$action" in
    muted)
      do_unmute "$pkg"
      log_del "$pkg"
      row allowed "$pkg" "notifications and background use allowed again"
      N_RESTORED=$((N_RESTORED + 1))
      ;;
    uninstalled)
      log_del "$pkg"
      if is_installed "$pkg"; then
        row restored "$pkg" "already back on the phone"
        N_RESTORED=$((N_RESTORED + 1))
      else
        row "not restored" "$pkg" "a regular app: https://play.google.com/store/apps/details?id=$pkg"
        N_MANUAL=$((N_MANUAL + 1))
      fi
      ;;
    *)
      out="$(phone cmd package install-existing --user "$USER_ID" "$pkg")"
      phone pm enable --user "$USER_ID" "$pkg" > /dev/null
      if is_installed "$pkg" && ! is_disabled "$pkg"; then
        log_del "$pkg"
        row restored "$pkg"
        N_RESTORED=$((N_RESTORED + 1))
      else
        case "$out" in
          *"doesn't exist"* | *NameNotFound* | *"Unknown package"*)
            row FAILED "$pkg" "this phone has no preinstalled app by that name"
            ;;
          *) row FAILED "$pkg" "$(first_line "$out")" ;;
        esac
        N_FAILED=$((N_FAILED + 1))
      fi
      ;;
  esac
}

# ---- Asking ---------------------------------------------------------------

# Read one line of answer into REPLY_LINE; $1 is what to assume at end of
# input. A typed Enter already moves the cursor down; piped input does not.
REPLY_LINE=""
answer() {
  REPLY_LINE=""
  read -r REPLY_LINE || REPLY_LINE="$1"
  [ -t 0 ] || printf '\n'
}

# Sets CHOICE to all, pick or none. Anything but a clear yes is a no.
ask_scope() {
  local a=""
  if [ "$YES" -eq 1 ] || [ "$DRY" -eq 1 ]; then
    CHOICE=all
    return 0
  fi
  printf '%s [y]es / [p]ick one by one / [n]o: ' "$1"
  answer n
  a="$REPLY_LINE"
  case "$a" in
    y | Y | yes) CHOICE=all ;;
    p | P | pick) CHOICE=pick ;;
    *) CHOICE=none ;;
  esac
}

confirm() {
  local a=""
  if [ "$YES" -eq 1 ] || [ "$DRY" -eq 1 ]; then return 0; fi
  printf '%s [y/n]: ' "$1"
  answer n
  a="$REPLY_LINE"
  case "$a" in y | Y | yes) return 0 ;; *) return 1 ;; esac
}

# Run one action over a file of "package<TAB>note" lines. The list is read on
# descriptor 3 so the prompts can still read the keyboard.
run_list() {
  local action="$1" file="$2" pkg note a
  while IFS="$TAB" read -r pkg note <&3; do
    [ -n "$pkg" ] || continue
    if [ "$CHOICE" = pick ]; then
      printf '  %s  [y/n/q]: ' "$pkg"
      answer q
      a="$REPLY_LINE"
      case "$a" in
        y | Y) ;;
        q | Q)
          say "  stopped"
          break
          ;;
        *)
          row skipped "$pkg"
          N_SKIPPED=$((N_SKIPPED + 1))
          continue
          ;;
      esac
    fi
    case "$action" in
      remove) act_remove "$pkg" ;;
      mute) act_mute "$pkg" ;;
      restore) act_restore "$pkg" "$note" ;;
    esac
  done 3< "$file"
}

# Print a file of "package<TAB>note" rows. If any row is too wide for the
# terminal, the whole list is stacked (note under its package, wrapped at word
# breaks) so it stays even instead of running off the edge.
show_list() {
  awk -F'\t' -v width="$WIDTH" '
    function wrapped(text, indent, max,    word, count, i, line, out) {
      count = split(text, word, " ")
      line = ""
      out = ""
      for (i = 1; i <= count; i++) {
        if (line != "" && length(line) + 1 + length(word[i]) > max) {
          out = out indent line "\n"
          line = word[i]
        } else {
          line = (line == "" ? word[i] : line " " word[i])
        }
      }
      return out indent line
    }
    {
      n++
      name[n] = $1
      note[n] = $2
      if (width > 0 && $2 != "" && length(sprintf("  %-46s %s", $1, $2)) > width) stack = 1
    }
    END {
      room = (width > 26 ? width - 6 : 20)
      for (i = 1; i <= n; i++) {
        if (note[i] == "") print "  " name[i]
        else if (stack) { print "  " name[i]; print wrapped(note[i], "      ", room) }
        else printf "  %-46s %s\n", name[i], note[i]
      }
    }
  ' "$1"
}

# Sets WIDTH to the columns available on screen, or 0 (no limit) when output
# is not a terminal. Asks the terminal itself; tput is only a fallback, since
# inside $( ) it cannot see the screen and on some systems answers 80 whatever
# the real width.
set_width() {
  WIDTH=0
  [ -t 1 ] || return 0
  WIDTH="$(stty size 2>/dev/null < /dev/tty | awk '{ print $2 }')"
  case "$WIDTH" in '' | *[!0-9]* | 0) WIDTH="$(tput cols 2>/dev/null)" ;; esac
  case "$WIDTH" in '' | *[!0-9]* | 0) WIDTH=80 ;; esac
}

count_lines() {
  if [ -f "$1" ]; then awk 'NF { n++ } END { print n + 0 }' "$1"; else echo 0; fi
}

summary() {
  local parts=""
  [ "$N_REMOVED" -gt 0 ] && parts="$parts, $N_REMOVED removed"
  [ "$N_OFF" -gt 0 ] && parts="$parts, $N_OFF switched off"
  [ "$N_MUTED" -gt 0 ] && parts="$parts, $N_MUTED silenced"
  [ "$N_RESTORED" -gt 0 ] && parts="$parts, $N_RESTORED restored"
  [ "$N_MANUAL" -gt 0 ] && parts="$parts, $N_MANUAL to reinstall from the Play Store"
  [ "$N_SKIPPED" -gt 0 ] && parts="$parts, $N_SKIPPED skipped"
  [ "$N_FAILED" -gt 0 ] && parts="$parts, $N_FAILED failed"
  if [ "$DRY" -eq 1 ]; then
    say "Dry run: nothing was changed."
  elif [ -n "$parts" ]; then
    say "Done: ${parts#, }."
  else
    say "Nothing was changed."
  fi
}

finish() {
  summary
  if [ "$LOCKED" -eq 1 ]; then
    say "What failed is locked by the phone's maker. 'debloat.sh inspect' shows whether"
    say "it still posts notifications; Settings > Apps may let you turn those off."
  fi
  [ "$N_FAILED" -eq 0 ] || exit 2
  exit 0
}

begin() {
  setup_color
  set_width
  check_patterns
  start_session
  load_rules
  snapshot
}

# ---- Commands -------------------------------------------------------------

# Work out every list the report shows, as "package<TAB>note" files in $TMP.
scan_lists() {
  installer_lists
  awk -F'\t' -v OFS='\t' '$2 == "safe" || $2 == "installer" { print $1, $3 }' "$TMP/class" \
    | actionable > "$TMP/l_safe"
  awk -F'\t' -v OFS='\t' '$2 == "caution" { print $1, $3 }' "$TMP/class" | actionable > "$TMP/l_caution"
  awk -F'\t' -v OFS='\t' '$2 == "keep" { print $1, $3 }' "$TMP/class" > "$TMP/l_keep"
  came_back | awk -F'\t' -v OFS='\t' '{ print $1, "was " $2 }' > "$TMP/l_back"
  awk -F'\t' -v OFS='\t' '{ print $1, "installed by " $2 }' "$TMP/sponsored" > "$TMP/l_sponsored"
  awk -F'\t' -v OFS='\t' '{ print $1, "installed by " $2 ($3 != "" ? " (" $3 ")" : "") }' \
    "$TMP/foreign" > "$TMP/l_foreign"

  notification_rows > "$TMP/l_notif"

  # Preinstalled packages no rule covers, with where their APK lives as a hint
  # to what they are. Resource overlays are skinning data, not apps.
  awk -F'\t' -v OFS='\t' '
    FILENAME == ARGV[1] || FILENAME == ARGV[2] { skip[$1] = 1; next }
    FILENAME == ARGV[3] { if ($2 != "none") skip[$1] = 1; else said[$1] = $3; next }
    FILENAME == ARGV[4] { path[$1] = $2; next }
    ($1 in skip) || $1 ~ /^com\.google\./ { next }
    {
      p = path[$1]
      if (index(p, "/overlay/") > 0) next
      if (index(p, "/data/") == 1) {
        hint = "(updated since the factory)"
      } else {
        # "/product/priv-app/Foo/Foo.apk" -> "product/priv-app/Foo"
        n = split(p, part, "/")
        hint = ""
        for (i = 2; i < n; i++) hint = hint (hint == "" ? "" : "/") part[i]
      }
      if (said[$1] != "") hint = hint (hint == "" ? "" : "; ") said[$1]
      print $1, hint
    }
  ' "$TMP/blocked" "$TMP/disabled" "$TMP/class" "$TMP/paths" "$TMP/system" > "$TMP/l_unknown"

  # Switched off or removed for this user, by this tool or anything else.
  # Resource overlays are left out and only counted: a phone carries one per
  # carrier and skin, and Android itself keeps all but the matching ones off.
  classify "$TMP/all" > "$TMP/class_all"
  {
    awk -F'\t' -v OFS='\t' -v overlays="$TMP/overlays_off" '
      FILENAME == ARGV[1] { did[$1] = 1; next }
      FILENAME == ARGV[2] { inst[$1] = 1; next }
      FILENAME == ARGV[3] { path[$1] = $2; next }
      FILENAME == ARGV[4] { if ($2 == "keep") keep[$1] = $3; next }
      FILENAME == ARGV[5] { state[$1] = "switched off"; next }
      !($1 in inst) { state[$1] = "removed" }
      ($1 in state) {
        if (index(path[$1], "/overlay/") > 0 || index($1, ".overlay") > 0) { print $1 > overlays; next }
        note = state[$1] (($1 in did) ? ", by this tool" : "")
        # Android switches plenty off by itself, so only a removed package is
        # held against the keep rules.
        if (($1 in keep) && state[$1] == "removed") note = note "; the rules would keep it: " keep[$1]
        print $1, note
      }
    ' "$LOG" "$TMP/installed" "$TMP/paths" "$TMP/class_all" "$TMP/disabled" "$TMP/all"
    awk -F'\t' -v OFS='\t' '$2 == "muted" { print $1, "silenced, by this tool" }' "$LOG"
  } | sort -t "$TAB" -k2,2 -k1,1 > "$TMP/l_off"
  [ -f "$TMP/overlays_off" ] || : > "$TMP/overlays_off"
}

# The report itself; laid out for $WIDTH columns.
render_report() {
  local n_back n_safe n_caution n_keep n_sponsored n_foreign n_notif n_unknown n_off n_overlays before now step=1
  n_back="$(count_lines "$TMP/l_back")"
  n_safe="$(count_lines "$TMP/l_safe")"
  n_caution="$(count_lines "$TMP/l_caution")"
  n_keep="$(count_lines "$TMP/l_keep")"
  n_sponsored="$(count_lines "$TMP/l_sponsored")"
  n_foreign="$(count_lines "$TMP/l_foreign")"
  n_notif="$(count_lines "$TMP/l_notif")"
  n_unknown="$(count_lines "$TMP/l_unknown")"
  n_off="$(count_lines "$TMP/l_off")"

  say "MAXAPACITY debloat $VERSION"
  say "Phone:  $PHONE"
  say "Apps:   $(count_lines "$TMP/installed") installed ($(count_lines "$TMP/system") preinstalled, $(count_lines "$TMP/third") added), $(count_lines "$TMP/disabled") switched off"
  before="$(previous_cleanup)"
  now="$(cleanup_count)"
  if [ -n "$before" ] && [ "$before" -ne "$now" ]; then
    say "Trend:  $before to clean up at the last scan, $now now"
  fi

  if [ "$n_back" -gt 0 ]; then
    say ""
    say "== CAME BACK after being removed ($n_back)"
    show_list "$TMP/l_back"
  fi

  say ""
  say "== REMOVE ($n_safe)"
  show_list "$TMP/l_safe"

  say ""
  say "== ASK FIRST ($n_caution)"
  show_list "$TMP/l_caution"

  if [ "$n_keep" -gt 0 ]; then
    say ""
    say "== KEPT ON PURPOSE ($n_keep)"
    show_list "$TMP/l_keep"
  fi

  say ""
  say "== ADDED BY A SPONSORED-APP INSTALLER ($n_sponsored)"
  show_list "$TMP/l_sponsored"
  if [ "$HAVE_INSTALLERS" -eq 0 ]; then
    say "  (this phone did not say which app installed what, so this cannot be filled in)"
  fi

  if [ "$n_foreign" -gt 0 ]; then
    say ""
    say "== ADDED BY ANOTHER APP ($n_foreign)   left alone"
    show_list "$TMP/l_foreign"
  fi

  if [ "$n_notif" -gt 0 ]; then
    say ""
    say "== NOTIFICATIONS UP RIGHT NOW ($n_notif)"
    show_list "$TMP/l_notif"
  fi

  say ""
  say "== NOT CLASSIFIED ($n_unknown)"
  show_list "$TMP/l_unknown"
  if [ "$HAVE_PATHS" -eq 0 ]; then
    say "  (no folder hints: this phone did not say where its apps are stored)"
  fi

  say ""
  say "== ALREADY OFF ($n_off)"
  show_list "$TMP/l_off"
  n_overlays="$(count_lines "$TMP/overlays_off")"
  if [ "$n_overlays" -gt 0 ]; then
    say "  (not listed: $n_overlays carrier and skin overlays that Android switches off by itself)"
  fi

  say ""
  say "== NEXT"
  if [ "$n_back" -gt 0 ]; then
    say "  $step. debloat.sh reapply           remove the $n_back that came back"
    step=$((step + 1))
  fi
  if [ "$n_sponsored" -gt 0 ]; then
    say "  $step. debloat.sh sponsored         uninstall the $n_sponsored apps an installer pushed"
    step=$((step + 1))
  fi
  if [ "$n_safe" -gt 0 ]; then
    say "  $step. debloat.sh apply             remove the $n_safe under REMOVE"
    step=$((step + 1))
  fi
  if [ "$n_caution" -gt 0 ]; then
    say "  $step. debloat.sh apply --caution   plus the $n_caution under ASK FIRST (read why first)"
    step=$((step + 1))
  fi
  if [ "$step" -eq 1 ]; then
    say "  Nothing the rules know about is left to remove."
  else
    say "  $step. debloat.sh restart           restart so lock and home screens update"
  fi
  if [ "$n_unknown" -gt 0 ]; then
    say "  NOT CLASSIFIED is left alone. Remove one with: debloat.sh remove <package>"
    if [ ! -f "$COMMUNITY" ]; then
      say "  To learn what most of those are: debloat.sh community"
    fi
  fi
}

# How many apps there are to clean up: everything under REMOVE, everything a
# sponsored-app installer added and everything that came back, counted once
# each (something that came back is usually also under REMOVE).
cleanup_count() {
  cut -f1 "$TMP/l_safe" "$TMP/l_sponsored" "$TMP/l_back" | sort -u | awk 'NF { n++ } END { print n + 0 }'
}

# One row per scan in $STATE/history.tsv, newest last:
#   time  installed  preinstalled  added  switched-off  to-clean-up  ask  notifying  unclassified  off
# "time" is seconds since 1970. Kept to the last 200 scans.
record_scan() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date +%s)" \
    "$(count_lines "$TMP/installed")" "$(count_lines "$TMP/system")" "$(count_lines "$TMP/third")" \
    "$(count_lines "$TMP/disabled")" "$(cleanup_count)" "$(count_lines "$TMP/l_caution")" \
    "$(count_lines "$TMP/l_notif")" "$(count_lines "$TMP/l_unknown")" "$(count_lines "$TMP/l_off")" \
    >> "$STATE/history.tsv"
  tail -n 200 "$STATE/history.tsv" > "$STATE/history.tsv.new" && mv "$STATE/history.tsv.new" "$STATE/history.tsv"
}

# What there was to clean up at the scan before this one; nothing when this
# is the first.
previous_cleanup() {
  awk -F'\t' '{ prev = last; last = $6 } END { if (NR > 1) print prev }' "$STATE/history.tsv"
}

# The scan as tab-separated lines, for programs (the GUI reads this):
#   meta<TAB>key<TAB>value
#   history<TAB>time<TAB>installed<TAB>to-clean-up<TAB>ask<TAB>notifying<TAB>off      (oldest first)
#   change<TAB>package<TAB>what was done<TAB>when                                  (oldest first)
#   <list><TAB>package<TAB>note<TAB>system|app|locked
# "app" marks a regular app, whose removal cannot be undone from here;
# "locked" one this tool refuses to remove or silence.
emit_tsv() {
  local pair
  printf 'meta\tversion\t%s\n' "$VERSION"
  printf 'meta\tphone\t%s\n' "$PHONE"
  printf 'meta\tserial\t%s\n' "$SERIAL"
  printf 'meta\tinstalled\t%s\n' "$(count_lines "$TMP/installed")"
  printf 'meta\tpreinstalled\t%s\n' "$(count_lines "$TMP/system")"
  printf 'meta\tadded\t%s\n' "$(count_lines "$TMP/third")"
  printf 'meta\tswitched_off\t%s\n' "$(count_lines "$TMP/disabled")"
  printf 'meta\toverlays_off\t%s\n' "$(count_lines "$TMP/overlays_off")"
  printf 'meta\thave_installers\t%s\n' "$HAVE_INSTALLERS"
  printf 'meta\thave_paths\t%s\n' "$HAVE_PATHS"
  tail -n 30 "$STATE/history.tsv" \
    | awk -F'\t' -v OFS='\t' '{ print "history", $1, $2, $6, $7, $8, $10 }'
  awk -F'\t' -v OFS='\t' 'NF >= 2 { print "change", $1, $2, ($3 == "" ? "-" : $3) }' "$LOG"
  for pair in back:l_back remove:l_safe ask:l_caution keep:l_keep pushed:l_sponsored \
    other:l_foreign notifying:l_notif unknown:l_unknown off:l_off; do
    awk -F'\t' -v OFS='\t' -v list="${pair%%:*}" '
      FILENAME == ARGV[1] { app[$1] = 1; next }
      FILENAME == ARGV[2] { locked[$1] = 1; next }
      {
        kind = (($1 in app) ? "app" : "system")
        if (($1 in locked) && list != "off") kind = "locked"
        print list, $1, $2, kind
      }
    ' "$TMP/third" "$TMP/blocked" "$TMP/${pair#*:}"
  done
}

# The community list arrives as JSON, one entry per package:
#   "com.example.app": {
#     "list": "Oem",
#     "description": "What it is.\nWhat removing it breaks.",
#     "removal": "Recommended"
#   },
# It is written one field to a line, which is what this reads; a JSON string
# cannot hold a real line break. Only "Recommended" becomes something `apply
# --caution` offers. "Advanced", "Expert" and "Unsafe" are kept as notes.
# Nothing in it is trusted: names are checked like any other package name and
# control characters are dropped before a description is ever printed.
community_rows() {
  tr -d '\r' | tr '\000-\010\013-\037\177' ' ' | awk -v OFS='\t' '
    function value(line) {
      sub(/^[ \t]*"[A-Za-z]+"[ \t]*:[ \t]*"/, "", line)
      sub(/",?[ \t]*$/, "", line)
      return line
    }
    function plain(text,    cut) {
      gsub(/\\[nrt]/, " ", text)
      gsub(/\\"/, "\"", text)
      gsub(/\\\\/, "\\", text)
      gsub(/[ \t]+/, " ", text)
      sub(/^ /, "", text)
      sub(/ $/, "", text)
      if (length(text) > 150) {
        text = substr(text, 1, 150)
        cut = match(text, / [^ ]*$/)
        if (cut > 60) text = substr(text, 1, cut - 1)
        text = text " ..."
      }
      return text
    }
    /^[ \t]*"[^"]+"[ \t]*:[ \t]*\{[ \t]*$/ {
      pkg = $0
      sub(/^[ \t]*"/, "", pkg)
      sub(/".*$/, "", pkg)
      what = ""
      removal = ""
      next
    }
    /^[ \t]*"description"[ \t]*:[ \t]*"/ { what = plain(value($0)); next }
    /^[ \t]*"removal"[ \t]*:[ \t]*"/ { removal = value($0); next }
    /^[ \t]*\},?[ \t]*$/ {
      if (pkg ~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/) {
        if (what == "") what = "no description"
        if (removal == "Recommended") print pkg, "caution", "community list: " what
        else if (removal == "Advanced") print pkg, "note", "community list, advanced: " what
        else if (removal == "Expert") print pkg, "note", "community list, expert: " what
        else if (removal == "Unsafe") print pkg, "note", "community list, unsafe to remove: " what
      }
      pkg = ""
    }
  ' | sort -u
}

cmd_community() {
  local total ask
  case "$PKGS" in
    "") ;;
    " off")
      if [ -f "$COMMUNITY" ]; then
        rm -f "$COMMUNITY" || die "cannot delete $COMMUNITY"
        say "The community list is no longer used. Its copy in $COMMUNITY is deleted."
      else
        say "The community list was not in use."
      fi
      exit 0
      ;;
    *) die "community takes no package names (see: debloat.sh --help)" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is needed to download the list, and it is not installed"
  mkdir -p "$STATE_ROOT" || die "cannot create $STATE_ROOT"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/debloat.XXXXXX")" || die "cannot create a temporary folder"
  trap 'if [ -n "$TMP" ]; then rm -rf "$TMP"; fi' EXIT
  curl -fsSL --max-time 120 -o "$TMP/list.json" -- "$COMMUNITY_URL" 2>/dev/null \
    || die "could not download the community list from $COMMUNITY_URL. The copy in use, if any, is unchanged."
  community_rows < "$TMP/list.json" > "$TMP/community"
  total="$(count_lines "$TMP/community")"
  [ "$total" -gt 0 ] \
    || die "the community list is not in the form this tool reads. The copy in use, if any, is unchanged; please report this."
  ask="$(awk -F'\t' '$2 == "caution" { n++ } END { print n + 0 }' "$TMP/community")"
  if ! { cp "$TMP/community" "$COMMUNITY.new" && mv -f "$COMMUNITY.new" "$COMMUNITY"; }; then
    die "cannot write $COMMUNITY"
  fi
  say "Saved the community list: $total packages, in $COMMUNITY"
  say "  $ask it recommends removing. Those on your phone now show under ASK FIRST."
  say "  $((total - ask)) it advises care with. Those show their note under NOT CLASSIFIED."
  say "Your own rules and the built-in ones still come first."
  say "It is the list of Universal Android Debloater Next Generation (GPL-3.0)."
  say "Run this again to refresh it. To stop using it: debloat.sh community off"
  exit 0
}

cmd_scan() {
  begin
  scan_lists
  record_scan
  if [ "$TSV" -eq 1 ]; then
    emit_tsv
    exit 0
  fi
  local screen="$WIDTH"
  WIDTH=0
  render_report > "$STATE/scan.txt"
  WIDTH="$screen"
  if [ "$COLOR" = 1 ]; then
    render_report | sed "s/^== .*\$/${C_BOLD}&${C_OFF}/"
  else
    render_report
  fi
  say ""
  say "Saved to: $STATE/scan.txt"
  if command -v pbcopy >/dev/null 2>&1; then
    say "Copy it to the clipboard: pbcopy < \"$STATE/scan.txt\""
  fi
  exit 0
}

cmd_apply() {
  begin
  local n
  awk -F'\t' -v OFS='\t' -v caution="$CAUTION" '
    $2 == "safe" || $2 == "installer" || (caution == 1 && $2 == "caution") { print $1, $3 }
  ' "$TMP/class" | actionable > "$TMP/todo"
  n="$(count_lines "$TMP/todo")"
  heading "$PHONE"
  if [ "$n" -eq 0 ]; then
    say "Nothing to remove: no installed app matches the rules."
    exit 0
  fi
  say "$n to remove for this user (undo any time with: debloat.sh restore)"
  show_list "$TMP/todo"
  ask_scope "Remove them?"
  if [ "$CHOICE" = none ]; then
    say "Nothing was changed."
    exit 0
  fi
  [ "$DRY" -eq 1 ] || ensure_baseline
  run_list remove "$TMP/todo"
  if [ "$DRY" -ne 1 ]; then
    installer_lists
    n="$(count_lines "$TMP/sponsored")"
    if [ "$n" -gt 0 ]; then
      say "$n apps an installer pushed are still on the phone: debloat.sh sponsored"
    fi
    say "Restart the phone so its lock and home screens catch up: debloat.sh restart"
  fi
  finish
}

cmd_sponsored() {
  begin
  installer_lists
  local n
  awk -F'\t' -v OFS='\t' '{ print $1, "installed by " $2 }' "$TMP/sponsored" > "$TMP/todo"
  n="$(count_lines "$TMP/todo")"
  heading "$PHONE"
  if [ "$HAVE_INSTALLERS" -eq 0 ]; then
    die "this phone did not say which app installed what, so sponsored apps cannot be picked out. Use 'debloat.sh scan' and remove them by name."
  fi
  if [ "$n" -eq 0 ]; then
    say "No app on this phone was installed by a known sponsored-app installer."
    if [ -s "$TMP/foreign" ]; then
      say "Some apps were added by other apps and are left alone; see: debloat.sh scan"
    fi
    exit 0
  fi
  say "$n apps were put on the phone by a sponsored-app installer."
  say "They are regular apps: uninstalling deletes their data, and the only way back"
  say "is the Play Store. If you use one of them, pick one by one."
  show_list "$TMP/todo"
  ask_scope "Uninstall them?"
  if [ "$CHOICE" = none ]; then
    say "Nothing was changed."
    exit 0
  fi
  [ "$DRY" -eq 1 ] || ensure_baseline
  run_list remove "$TMP/todo"
  [ "$DRY" -eq 1 ] || say "Now run 'debloat.sh apply' to remove the installers too, or these come back."
  finish
}

cmd_reapply() {
  begin
  local n
  # Say who put each one back, when Android knows.
  came_back | awk -F'\t' -v OFS='\t' '
    FILENAME == ARGV[1] { by[$1] = $2; next }
    { print $1, "was " $2 (($1 in by) && by[$1] != "" && by[$1] != "null" ? "; put back by " by[$1] : "") }
  ' "$TMP/installers" - | actionable > "$TMP/todo"
  n="$(count_lines "$TMP/todo")"
  heading "$PHONE"
  if [ "$n" -eq 0 ]; then
    say "Nothing has come back since you removed it."
    exit 0
  fi
  say "$n came back after being removed:"
  show_list "$TMP/todo"
  ask_scope "Remove them again?"
  if [ "$CHOICE" = none ]; then
    say "Nothing was changed."
    exit 0
  fi
  run_list remove "$TMP/todo"
  finish
}

# Shared by remove and mute: check each named package and build the work list.
named_targets() {
  local pkg why
  : > "$TMP/todo"
  [ -n "$PKGS" ] || die "name at least one package, for example: debloat.sh $CMD com.example.app"
  for pkg in $PKGS; do
    if ! valid_pkg "$pkg"; then
      row skipped "$pkg" "not a package name"
      N_SKIPPED=$((N_SKIPPED + 1))
    elif ! in_file "$pkg" "$TMP/installed"; then
      if in_file "$pkg" "$TMP/all"; then
        row skipped "$pkg" "already removed for this user"
      else
        row skipped "$pkg" "not on this phone; check the name with: debloat.sh scan"
      fi
      N_SKIPPED=$((N_SKIPPED + 1))
    else
      why="$(blocked_reason "$pkg")"
      if [ -n "$why" ] && [ "$FORCE" -ne 1 ]; then
        row skipped "$pkg" "$why (--force overrides)"
        N_SKIPPED=$((N_SKIPPED + 1))
      else
        printf '%s\t\n' "$pkg" >> "$TMP/todo"
      fi
    fi
  done
}

cmd_remove() {
  begin
  heading "$PHONE"
  named_targets
  CHOICE=all
  if [ -s "$TMP/todo" ]; then
    # Preinstalled apps can be restored; regular apps and their data cannot.
    if awk -F'\t' '
      FILENAME == ARGV[1] { third[$1] = 1; next }
      ($1 in third) { found = 1 }
      END { exit !found }
    ' "$TMP/third" "$TMP/todo"; then
      if ! confirm "This uninstalls regular apps and deletes their data. Continue?"; then
        say "Nothing was changed."
        exit 0
      fi
    fi
    [ "$DRY" -eq 1 ] || ensure_baseline
    run_list remove "$TMP/todo"
  fi
  finish
}

cmd_mute() {
  begin
  heading "$PHONE"
  named_targets
  CHOICE=all
  [ -s "$TMP/todo" ] && run_list mute "$TMP/todo"
  finish
}

cmd_restore() {
  begin
  local pkg action
  heading "$PHONE"
  : > "$TMP/todo"
  if [ -z "$PKGS" ]; then
    cut -f1,2 "$LOG" > "$TMP/todo"
    if [ ! -s "$TMP/todo" ]; then
      say "Nothing to restore: this tool has not changed anything on this phone."
      say "To bring back something another tool removed: debloat.sh restore <package>"
      exit 0
    fi
  else
    for pkg in $PKGS; do
      if ! valid_pkg "$pkg"; then
        row skipped "$pkg" "not a package name"
        N_SKIPPED=$((N_SKIPPED + 1))
        continue
      fi
      action="$(log_action "$pkg")"
      printf '%s\t%s\n' "$pkg" "${action:-unknown}" >> "$TMP/todo"
    done
  fi
  CHOICE=all
  run_list restore "$TMP/todo"
  finish
}

cmd_inspect() {
  begin
  installer_lists
  local windows focus app pkg known why
  heading "$PHONE"

  windows="$(phone dumpsys window)"
  focus="$(printf '%s\n' "$windows" | sed -n 's/.*mCurrentFocus=[A-Za-z]*{[^ ]* [^ ]* \([^ }]*\).*/\1/p' | sed -n '1p')"
  app="$(printf '%s\n' "$windows" | sed -n 's/.*mFocusedApp=[A-Za-z]*{[^ ]* [^ ]* \([^ }]*\).*/\1/p' | sed -n '1p')"
  pkg="${app%%/*}"
  say ""
  heading "== ON SCREEN NOW"
  say "  window  ${focus:-unknown}"
  say "  app     ${app:-unknown}"

  # The lock screen and notification panel are Android's own window, but an
  # app can still be drawing on them. If the app in front is neither Android
  # nor the home screen, it is the thing to look at.
  if [ -n "$pkg" ] && valid_pkg "$pkg" && ! in_file "$pkg" "$TMP/blocked"; then
    known="$(awk -F'\t' -v p="$pkg" '
      BEGIN {
        label["installer"] = label["safe"] = "under REMOVE"
        label["caution"] = "under ASK FIRST"
        label["keep"] = "kept on purpose"
      }
      $1 == p && $2 != "none" { print label[$2] ": " $3 }
    ' "$TMP/class")"
    [ -n "$known" ] || known="$(awk -F'\t' -v p="$pkg" '$1 == p { print "put there by " $2 }' "$TMP/sponsored")"
    say ""
    say "  In front: $pkg"
    [ -z "$known" ] || say "  What it is: $known"
    case "$focus" in
      *NotificationShade* | *Keyguard*) say "  It is drawing on the lock screen or notification panel." ;;
    esac
    say "  Remove it:  debloat.sh remove $pkg"
  else
    why=""
    [ -z "$pkg" ] || why="$(blocked_reason "$pkg")"
    say ""
    if [ -n "$why" ]; then
      say "  In front: $pkg ($why)."
    fi
    say "  Nothing removable is in front. On the lock screen, junk is then either a"
    say "  notification (listed below) or a lock screen wallpaper service."
  fi

  say ""
  heading "== WALLPAPER AND LOCK SCREEN SERVICES"
  phone dumpsys wallpaper | grep -o 'ComponentInfo{[^}]*}' \
    | sed 's/^ComponentInfo{\(.*\)}$/  \1/' | sort -u > "$TMP/wall"
  if [ -s "$TMP/wall" ]; then cat "$TMP/wall"; else say "  (none reported)"; fi

  notification_rows > "$TMP/l_notif"
  say ""
  heading "== NOTIFICATIONS UP RIGHT NOW"
  if [ -s "$TMP/l_notif" ]; then
    show_list "$TMP/l_notif"
    say ""
    say "Remove a source with 'debloat.sh remove <package>', or keep the app and"
    say "silence it with 'debloat.sh mute <package>'."
  else
    say "  (none)"
  fi
  exit 0
}

cmd_restart() {
  setup_color
  start_session
  heading "$PHONE"
  if [ "$DRY" -eq 1 ]; then
    say "Dry run: the phone would restart."
    exit 0
  fi
  adb_ reboot || die "the phone did not take the restart."
  say "Restarting. The phone drops off USB for a minute; scan again once it is back."
  exit 0
}

# Every package with the app that installed it: "package<TAB>installer".
watch_list() {
  ask_phone pm list packages -i --user "$USER_ID" \
    | sed -n -e 's/ *$//' -e "s/^package:\([^ ]*\) *installer=\(.*\)\$/\1${TAB}\2/p" | sort -u
}

cmd_watch() {
  setup_color
  check_patterns
  start_session
  load_rules
  local rounds=0 max="${DEBLOAT_WATCH_ROUNDS:-0}" pkg by note tag
  case "$EVERY" in '' | *[!0-9]* | 0) die "--every needs a whole number of seconds" ;; esac

  watch_list > "$TMP/prev" || exit 1
  heading "$PHONE"
  if [ -t 1 ]; then
    say "Watching for installs. Use the phone as normal; press Ctrl-C to stop."
  else
    say "Watching for installs. Use the phone as normal."
  fi
  while :; do
    sleep "$EVERY"
    watch_list > "$TMP/cur" || exit 1
    comm -13 "$TMP/prev" "$TMP/cur" > "$TMP/new"
    if [ -s "$TMP/new" ]; then
      cut -f2 "$TMP/new" | sort -u > "$TMP/inst_names"
      classify "$TMP/inst_names" > "$TMP/inst_class"
      while IFS="$TAB" read -r pkg by <&3; do
        tag="NEW "
        [ -n "$(log_action "$pkg")" ] && tag="BACK"
        note="$(awk -F'\t' -v p="$by" '$1 == p && $2 != "none" { print $3 }' "$TMP/inst_class")"
        case "$by" in '' | null) by="adb or the system" ;; esac
        printf '%s  %s  %s, installed by %s\n' "$(date +%H:%M:%S)" "$tag" "$pkg" "$by"
        [ -z "$note" ] || printf '                %s\n' "$note"
      done 3< "$TMP/new"
    fi
    mv "$TMP/cur" "$TMP/prev"
    rounds=$((rounds + 1))
    if [ "$max" -gt 0 ] && [ "$rounds" -ge "$max" ]; then break; fi
  done
  exit 0
}

# ---- Entry ----------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    -s | --serial)
      [ $# -ge 2 ] || die "$1 needs a serial number (see: adb devices)"
      SERIAL="$2"
      shift 2
      ;;
    --every)
      [ $# -ge 2 ] || die "--every needs a number of seconds"
      EVERY="$2"
      shift 2
      ;;
    -y | --yes) YES=1; shift ;;
    -n | --dry-run) DRY=1; shift ;;
    --caution) CAUTION=1; shift ;;
    --force) FORCE=1; shift ;;
    --no-color) COLOR=0; shift ;;
    --tsv) TSV=1; shift ;;
    -h | --help | help) usage; exit 0 ;;
    --version) say "debloat.sh $VERSION"; exit 0 ;;
    -*) die "unknown option: $1 (see: debloat.sh --help)" ;;
    *)
      if [ -z "$CMD" ]; then
        CMD="$1"
      else
        PKGS="$PKGS $1"
      fi
      shift
      ;;
  esac
done

case "$CMD" in
  scan) cmd_scan ;;
  inspect | focus) cmd_inspect ;;
  watch) cmd_watch ;;
  apply) cmd_apply ;;
  sponsored) cmd_sponsored ;;
  reapply) cmd_reapply ;;
  remove) cmd_remove ;;
  mute) cmd_mute ;;
  restore) cmd_restore ;;
  restart) cmd_restart ;;
  community) cmd_community ;;
  "") usage; exit 0 ;;
  *) die "unknown command: $CMD (see: debloat.sh --help)" ;;
esac
