# MAXAPACITY debloat

Removes preinstalled junk from an Android phone over `adb`: carrier and maker
preloads, lock screen feeds, and the hidden installer apps that put removed
apps back. No root and no unlocked bootloader needed, so it works on
carrier-locked phones.

Nothing is deleted from the phone's system. Preinstalled apps are removed for
the current user only, and `restore` (or a factory reset) brings them back.

## Before you start

- `adb` on your computer. On a Mac: `brew install android-platform-tools`.
- USB debugging on the phone: Settings > About phone, tap **Build number**
  seven times, then Settings > System > Developer options > **USB debugging**.
  Plug in and accept the prompt on the phone.

## The Mac app

**Download it.** On the repository's Releases page, take
`MAXAPACITY-Debloat-<version>-mac.zip`. Unzip it (Safari does that by itself)
and open **MAXAPACITY Debloat**.

The first time, macOS stops it, because the app is not signed with an Apple
developer account:

- macOS 15 or newer: click **Done**, then open System Settings > Privacy &
  Security, scroll down to Security and click **Open Anyway**.
- Older versions: Control-click the app, choose **Open**, then **Open** again.

After that it opens with a double-click. Drag it to Applications to keep it.

If macOS does not offer that, or calls the app damaged, clear the mark it puts
on downloads:

```bash
xattr -dr com.apple.quarantine ~/Downloads/"MAXAPACITY Debloat.app"
```

**Or build it on your own Mac**, which skips that prompt, because the app is
then made here from files you can read. From this folder, or from the
`maxapacity-debloat-<version>.zip` download:

```bash
bash install.sh --open
```

That puts the app in `~/Applications` and opens it. Either way, `bash
uninstall.sh` removes it.

The app needs Node.js 18 or newer and `adb`:
`brew install node android-platform-tools`. It looks for them where Homebrew
and Android Studio put them, and failing that asks the shell your Terminal
uses. An app built by `install.sh` also remembers where they were when it was
built.

What you get:

- **Overview**: what the last scan found, how that moved since the scan
  before, and one button, **Review cleanup**. The review lists everything it
  would do, ticked, split into what can be undone and what cannot. Untick what
  you want to keep.
- **The lists** from the scan, each with a filter. Tick apps and the actions
  for them appear: Remove, Silence, Uninstall or Restore.
- **Undo** on every change that has one, and **Recent changes** with a Restore
  beside each.
- **Activity**: what is on the phone's screen right now, a live watch for
  installs, and the phone's own answer to everything the app asked.
- **Restart phone**, offered after a cleanup, so the lock and home screens
  catch up. The app scans again by itself once the phone is back.

It opens in a window of its own when Chrome, Edge or Brave is installed, and
in your default browser otherwise. It follows the system's light or dark
appearance. The app runs for as long as its window is open, in front or not,
and quits a few seconds after you close it. Opening the app while a window is
open gives you a fresh window in place of the old one, and opening a newer
version takes over from an older one that is still running.

The app is a front for `debloat.sh`: it cannot do anything the commands below
cannot, and the same safety rules apply. It listens on this computer only, and
no other web page can talk to it. It runs from a copy of its files in
`~/Library/Application Support/MAXAPACITY Debloat`, so it keeps working if the
app is moved or replaced while open. Its log is
`~/Library/Logs/maxapacity-debloat.log`.

To run the window without the app (also on Linux):

```bash
node gui/server.mjs
```

## Use it from the terminal

```bash
./debloat.sh scan
```

`scan` changes nothing. It sorts every app into lists and ends with the
commands to run next, in order. The usual sequence is:

```bash
./debloat.sh sponsored
```

```bash
./debloat.sh apply
```

```bash
./debloat.sh restart
```

Every command that changes something shows what it will do and asks first.
Answer `p` to go through the list one by one.

| Command | What it does |
|---|---|
| `scan` | Read-only report, also saved to `~/.maxapacity-debloat/<serial>/scan.txt` |
| `inspect` | What is on screen now and which apps have notifications up. Run it while the junk is showing |
| `watch` | Stays running and reports each app that gets installed, and which app installed it |
| `apply` | Removes the **REMOVE** list. `--caution` adds the **ASK FIRST** list |
| `sponsored` | Uninstalls the apps a sponsored-app installer added |
| `reapply` | Removes again whatever has come back |
| `remove <package>...` | Removes specific packages |
| `mute <package>...` | Keeps an app but blocks its notifications and background activity |
| `restore [<package>...]` | Undo. With no package, everything this tool changed |
| `restart` | Restarts the phone, so its lock and home screens catch up |

Options: `-n` shows what would happen without doing it, `-y` skips the
questions, `-s <serial>` picks a phone when several are attached. `--help`
lists the rest.

## The lists in a scan

| List | Meaning |
|---|---|
| **CAME BACK** | Something you removed is on the phone again |
| **REMOVE** | Matches a rule marked safe. `apply` removes these |
| **ASK FIRST** | Matches a rule with a real downside, shown next to it. Only `apply --caution` removes these |
| **KEPT ON PURPOSE** | Matches a rule that says the phone needs it |
| **ADDED BY A SPONSORED-APP INSTALLER** | Regular apps that Digital Turbine, Aura or a similar service put on the phone |
| **ADDED BY ANOTHER APP** | Apps installed or last updated by something other than you or an app store. Left alone |
| **NOTIFICATIONS UP RIGHT NOW** | Which apps are notifying, and what the tool knows about each |
| **NOT CLASSIFIED** | Preinstalled apps no rule covers, with the folder they live in as a hint. Left alone |
| **ALREADY OFF** | Switched off or removed for this user, by this tool or any other |

## Why removed apps come back

Most debloaters remove the visible apps and leave the service that installed
them. Carrier and budget phones ship with one (Digital Turbine is the common
one), and it quietly reinstalls sponsored apps. `apply` removes those
installers, `sponsored` removes what they already installed, `scan` shows
which app installed what, and `watch` catches an install as it happens.

Run `scan` again after a system update. Updates can re-enable what was
removed; `reapply` puts it right.

## What it will not touch

- Android itself, Google Play services, the chipset services, and the Motorola
  pieces needed to update, set up, show a home screen and stay on the network.
- The home screen, phone, messaging and keyboard apps in use at that moment.

`remove` and `mute` refuse these unless you add `--force`. Rules never match
them.

Everything else is yours to decide. The tool cannot know what an unclassified
maker app does, so removing one by name is at your own risk: if something
stops working, `restore` it, and if the phone will not start, a factory reset
brings every preinstalled app back.

## When Android refuses

For each package the tool tries, in order: remove it for this user, switch it
off, then silence it (block its notifications and background activity). It
reports which one took. A phone maker can lock a package against all three;
that shows as `FAILED` and nothing about it is changed.

Regular apps (not preinstalled) are uninstalled for real, with their data.
`restore` cannot bring those back; it prints the Play Store link instead.

## Rules

`rules.tsv` decides what counts as junk: one line per rule with a tier, a
pattern matched against the package name, and the reason shown in the scan.
The file's header explains the tiers.

Your own rules go in `~/.maxapacity-debloat/rules.local.tsv`, same format.
They are read first, so they override the built-in list. For example, to keep
an app the built-in rules would remove:

```
keep  ^com\.motorola\.help$  I use it
```

To add a rule for something under NOT CLASSIFIED, find out what it is on the
phone first (`inspect` while it is on screen, or its folder hint in the scan).

## Files it keeps

Under `~/.maxapacity-debloat/<phone serial>/`:

- `changes.tsv`: what was done to which package. `restore` and `reapply` read it.
- `history.tsv`: the counts from each scan, so the next one can show the trend.
- `baseline.txt`: the phone's app list before the first change.
- `scan.txt`: the latest scan.

## Tests

The tests are in the repository, not in the download.

```bash
test/run.sh
```

Runs every command against a simulated phone (`test/fake_adb.py`): the
fallbacks, a cable pulled mid-run, an attempt to pass a command through a
package name, and the layout and prompts on a real terminal
(`test/in_terminal.py`).

```bash
node --test test/gui.test.mjs
```

Does the same for the app's helper: that it refuses requests without its
token or for another host name, keeps going while a window is open however
quiet that window is, stops by itself once the window has gone, and is reused
rather than started twice.

`tools/package.sh` makes the two downloads: the app in a zip of its own, and
the tool with what the app is built from. CI attaches both to a draft release
on every push. A version that has no release yet gets one when it reaches
`main`: raise `VERSION` in `debloat.sh` to publish the next. `tools/make_icon.py`
redraws the icon, as `gui/icon.png` and as the `app/AppIcon.icns` the app
carries.

CI runs it on Linux, under bash 3.2 (the version macOS ships), and, on a
branch, on macOS itself whenever the script, the app or the tests change; the
macOS run also builds the real app and opens it the way a double-click does. `test/bin/grep` gives the Linux
runs one piece of macOS strictness that once let a bug through: a pattern with
an empty alternative, like `(|a)`, is an error there.

## Limits

- It manages apps. Anything built into the maker's system interface itself
  cannot be removed this way.
- App names are not available over `adb`, only package names and folders.
- The built-in rules cover the common installers and feeds plus Motorola and
  Verizon. Other makers and carriers mostly land under NOT CLASSIFIED until
  rules are added.
