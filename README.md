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

**Download it.** On the [Releases page](https://github.com/jthmz/Debloatr/releases), take
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
built. Without `adb` the window still opens, says so, and finds it by itself
once it is installed.

What you get:

- **Easy to read and to press**. The smallest words are 14 pixels tall, the
  rest 16 and up, and the buttons that matter are tall enough to hit
  without aiming. Each app has a
  picture for the kind of thing it is, the steps to connect a phone are
  drawn as well as written, and the words are plain ones. It is meant to be
  usable by anyone, older eyes and hands included.
- **Getting connected**. With no phone to talk to, the window does not show
  an error: it says which thing is missing (adb, the cable, USB debugging,
  or the answer to the phone's own "Allow USB debugging?" question) and
  gives the three steps, each with its picture, for whoever made the phone.
  It keeps looking, ticks each step off as the phone is seen to have got
  past it, and carries on by itself the moment the phone answers.
- **The wizard**. He stands on the Overview beside the phone, with everything
  that can go circling it: red for the installers that put apps back, amber
  for the rest, the same red and amber as on the phone's screen beside him.
  **Clean up with the wizard** gives him a screen of his own, where he walks
  you through it: he scans the phone, shows what he found, lets you untick
  what you want to keep, and takes the rest off. His lightning falls only on
  what the phone says is gone, each app's line gets its answer as the
  lightning reaches it, and at the end he says how many were removed, which
  Android would only let him switch off, and which the phone's maker has
  locked. Those he remembers, and does not offer again, and they are no
  longer counted anywhere as something to do. He offers to put back what can
  be put back, and to restart the phone, which he asks about first; he keeps
  his shades on for as long as the phone is clean. On the other pages he
  sits at the head of the page with one useful thing to say, and strikes the
  rows you remove. Pressing him, wherever he is, brings him out. In a window
  too narrow for him to stand beside his card, the card takes the window and
  he sits at its head.
- **What cannot be undone is never done for you**. Removing an app that
  came with the phone can be undone, and a cleanup starts with those
  ticked. Deleting one that was added later cannot, so those are never
  ticked for you: you tick them, they are marked in red as deleted for
  good, and they are asked about once more, by name, with keeping them as
  the answer under the keyboard. The lime button is never the one that
  deletes: a button that would is plain, with its words in red, and ends in
  "…" because it asks first. Answer that you would rather keep them and they
  are unticked again, so the lime button is back and only does what can be
  undone.
- **One at a time**. The apps under With a catch each have one. Instead of
  a list to puzzle over, they come one to a card: what it is, the catch,
  and two big buttons, Keep or Remove, at the foot of the window: in sight
  whatever its size, and in the same place from the first card to the last.
  Keep is the one under the keyboard. Nothing changes until the last card,
  and the tally, are agreed.
- **Names you can read**. The phone only gives package names. An app the
  rules name is called that ("Moto Gametime" for `com.motorola.gamemode`), a
  few dozen apps that turn up on many phones go by their own names ("Candy
  Crush Saga"), and anything else gets a name worked out from its package
  ("Motorola time weather widget" for `com.motorola.timeweatherwidget`),
  set lighter than a name that is known, because it is only a reading.
  Any row opens a panel with everything known about that app, its package
  name, and the buttons to act on it alone.
- **Overview**: what can go and the one button that deals with it; then
  **Checks**: whether an installer can still put apps back, whether anything
  has come back, and what else wants a look, each with the one thing to do
  about it; then what was changed lately, with a Restore beside each; and
  last the numbers, with how they moved since the scan before. **Review
  cleanup** is the cleanup without the wizard: everything it would do, in
  the order it would do it (what puts apps back goes first), split into
  what can be undone and what cannot.
- **The lists** from the scan, each with a filter, under plainer names than
  the terminal uses: **Safe to remove** is REMOVE, **With a catch** is ASK
  FIRST, **Unknown apps** is NOT CLASSIFIED. Tick apps and the actions for
  them appear: Remove, Silence, Delete for good or Restore. The pages most
  people never need (what is notifying, what nothing is known about, the
  log) fold away under **More**. Every page fits in the sidebar of a window
  of the size the app opens at; in a shorter one the list of pages scrolls,
  and says which way there is more.
- **Find anything** (the magnifier beside the name, or Cmd-K): any app the
  scan found, any page, anything the app can do, including fetching the
  community list.
- **Undo** on every change that has one, said at the foot of the sidebar
  where it is never on top of something to press, and **Recent changes**
  with a Restore beside each.
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

The wizard is drawn by the graphics card (WebGL), from `gui/magic.js`: no
libraries, nothing downloaded, and every shape built there from a few numbers.
He asks the helper for exactly what the list asks for. The wand beside the
app's name sends him away and brings him back, and says so each time, with an
Undo; without him the window is the plain one, with one button, **Review
cleanup**. His stage is dark in a light window too; everything else follows
the system's appearance. He holds still when the system asks for reduced
motion, draws less often when the window is not the one in front, and is
simply absent where there is no WebGL.

The app is a front for `debloat.sh`: it cannot do anything the commands below
cannot, and the same safety rules apply. It listens on this computer only, and
no other web page can talk to it. Nothing leaves this computer unless you ask:
fetching the community list is one download, and **Look it up on the web**
opens a search for a package name in your browser. It runs from a copy of
its files in `~/Library/Application Support/MAXAPACITY Debloat`, so it keeps
working if the app is moved or replaced while open. Its log is
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
| `community` | Downloads the community list of preinstalled apps, for phones the built-in rules do not cover. `community off` stops using it |

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

Some phones refuse the first of those for anything preinstalled; Android 17
does, by every report. The app is then switched off, and the result says
"switched off" beside it, in the terminal and in the app.

Regular apps (not preinstalled) are uninstalled for real, with their data.
`restore` cannot bring those back; it prints the Play Store link instead.

## Rules

`rules.tsv` decides what counts as junk: one line per rule with a tier, a
pattern matched against the package name, and the reason shown in the scan.
The file's header explains the tiers.

The app reads two things out of a reason. One that starts with a name and a
colon (`Verizon Cloud: Verizon's backup and storage service`) gives the app
that name in the window. What follows a semicolon (`...; games lose that
toolbar`) is shown as the catch when the app comes up under With a catch.

Your own rules go in `~/.maxapacity-debloat/rules.local.tsv`, same format.
They are read first, so they override the built-in list. For example, to keep
an app the built-in rules would remove:

```
keep  ^com\.motorola\.help$  I use it
```

## The community list

The built-in rules are written for Motorola and Verizon phones. For any other
phone, most preinstalled apps would land under NOT CLASSIFIED with nothing but
a folder name. This fills that in:

```bash
./debloat.sh community
```

In the app, the same thing is **Get the list** under Checks, or in Find
anything. It downloads the package list that
[Universal Android Debloater Next Generation](https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation)
keeps, several thousand preinstalled apps across makers and carriers, each
with a description and a rating. It needs `curl` and no phone. From then on:

- What the list rates **Recommended** shows under **ASK FIRST**, with the
  list's description as the reason. `apply` leaves these alone; only `apply
  --caution` offers them. The list calls an app safe to remove when most
  people will not miss it, and that can include a browser or a gallery you
  use, so read the reasons.
- What it rates **Advanced**, **Expert** or **Unsafe** stays under **NOT
  CLASSIFIED**, now with the list's description, so you know what a package
  is before you `remove` it by name.

Your own rules and the built-in ones are read first and always win, and the
packages under "What it will not touch" stay protected whatever the list
says. Run the command again to refresh the list; `./debloat.sh community off`
stops using it.

The list is not part of this tool or its downloads. It is fetched from that
project, which publishes it under the GPL-3.0, and kept in
`~/.maxapacity-debloat/community.tsv`.

To add a rule for something under NOT CLASSIFIED, find out what it is on the
phone first (`inspect` while it is on screen, or its folder hint in the scan).

## Files it keeps

`~/.maxapacity-debloat/community.tsv` is the community list, once downloaded.

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
fallbacks, the community list, a cable pulled mid-run, an attempt to pass a command through a
package name, and the layout and prompts on a real terminal
(`test/in_terminal.py`).

```bash
node --test test/gui.test.mjs
```

Does the same for the app's helper: that it refuses requests without its
token or for another host name, keeps going while a window is open however
quiet that window is, stops by itself once the window has gone, and is reused
rather than started twice; that a scan says which installers can still act;
and that the community list is fetched and dropped through the tool. It also
covers the window as far as it can without a screen: that the names,
pictures and descriptions people see are worked out as they should be, that
an app keeps its name and description after it has been removed, that the
wizard's drawing code is served and parses, that the page only asks it for
things it has, and that every pose, spell and stage runs against a WebGL
that draws nothing.

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

## Other tools

- [Universal Android Debloater Next Generation](https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation)
  is a desktop app for Windows, macOS and Linux that also works over `adb`
  without root. Its package list is kept by a community and covers far more
  makers than the rules here. It shows package names in one long list with
  filters, and you install `adb` yourself.
- [Canta](https://github.com/samolego/Canta) runs on the phone itself through
  Shizuku, so it needs no computer, and uses that same list. It shows each
  app's own name and icon.
- [ADB AppControl](https://adbappcontrol.com) is a Windows program with a
  wider remit: it manages apps in general. It shows names and icons once its
  helper app is installed on the phone.

What this one does that those do not:

- It is built around the installers that put apps back. It removes them
  first, shows which app installed what, says in every scan whether one can
  still act, and lists what has come back.
- It walks you through: getting connected, the cleanup, and the apps with a
  catch one at a time.
- It never reports a removal it has not checked, and says so when Android
  would only let an app be switched off, or not touched at all.
- Every change is logged, and `restore` and `reapply` work from the log.

What they do that this does not: Canta and ADB AppControl show the names and
icons apps give themselves. This knows the names its rules give and those of
a few dozen common apps, reads the rest from the package name, and draws a
picture for the kind of app rather than its icon. Its own rules are written
for Motorola and Verizon phones; for any other phone, the community list
those tools use is one click or one command away.

## Limits

- It manages apps. Anything built into the maker's system interface itself
  cannot be removed this way.
- App names are not available over `adb`, only package names and folders.
  The app shows the name a rule gives, or its own name for a few dozen
  common apps, and otherwise a name read from the package name, which may
  not be what the phone calls it. The package name is in the panel each row
  opens.
- The built-in rules cover the common installers and feeds plus Motorola and
  Verizon. For other makers and carriers, `community` brings in a list that
  covers them; without it they mostly land under NOT CLASSIFIED.
