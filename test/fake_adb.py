#!/usr/bin/env python3
"""A stand-in for `adb` that simulates one Android phone, for testing debloat.sh.

The phone's state lives in the JSON file named by $FAKE_ADB_STATE. Only the
adb and Android shell commands debloat.sh uses are implemented; anything else
is recorded under "unknown" so a test can fail on it.

    fake_adb.py devices | get-state | [-s SERIAL] shell <command...>
    fake_adb.py ctl init                      write the default phone
    fake_adb.py ctl add PKG key=value ...     add a package
    fake_adb.py ctl set PKG key=value ...     change a package
    fake_adb.py ctl del PKG
    fake_adb.py ctl get PKG key               print one field ("absent" if no such package)
    fake_adb.py ctl top key=json              set a top-level field
    fake_adb.py ctl bulk N                    add N extra preinstalled packages
    fake_adb.py ctl log                       print every shell command received
    fake_adb.py ctl unknown                   print the commands it did not recognise
"""
import json
import os
import shlex
import sys

STATE_PATH = os.environ.get("FAKE_ADB_STATE", "")

MUTATING = ("pm uninstall", "pm disable-user", "pm enable", "pm revoke", "pm grant",
            "cmd package install-existing", "cmd appops set", "am force-stop")


def pkg(system=True, installed=True, enabled=True, installer="null", path="", **extra):
    entry = {"system": system, "installed": installed, "enabled": enabled,
             "installer": installer, "path": path, "nodelete": False, "nodisable": False,
             "nomute": False, "notifs": 0, "ops": {}, "notif_perm": True}
    entry.update(extra)
    return entry


def default_state():
    p = {}

    def system(name, path, **extra):
        p[name] = pkg(path=path, **extra)

    def app(name, installer, **extra):
        p[name] = pkg(system=False, installer=installer,
                      path="/data/app/~~x==/%s-y==/base.apk" % name, **extra)

    # Core Android, Google and Motorola pieces that must never be touched.
    system("android", "/system/framework/framework-res.apk")
    system("com.android.systemui", "/system_ext/priv-app/SystemUI/SystemUI.apk")
    system("com.android.vending", "/product/priv-app/Phonesky/Phonesky.apk")
    system("com.google.android.gms", "/product/priv-app/GmsCore/GmsCore.apk")
    system("com.motorola.launcher3", "/system_ext/priv-app/Launcher3/Launcher3.apk")
    system("com.motorola.ccc.ota", "/system/priv-app/MotoOta/MotoOta.apk")
    system("com.motorola.vzw.phone.extensions", "/product/priv-app/VzwPhone/VzwPhone.apk",
           enabled=False)
    # Apps holding a role the phone cannot do without.
    system("com.google.android.dialer", "/product/priv-app/Dialer/Dialer.apk")
    system("com.google.android.apps.messaging", "/product/app/Messages/Messages.apk")
    system("com.google.android.inputmethod.latin", "/product/app/Gboard/Gboard.apk")
    # An ordinary Google app: not protected, not classified.
    system("com.google.android.youtube", "/product/app/YouTube/YouTube.apk")
    # Rule tier "safe".
    system("com.motorola.ccc.notification", "/product/priv-app/MotoNotif/MotoNotif.apk", notifs=2)
    system("com.motorola.help", "/product/app/MotoHelp/MotoHelp.apk")
    system("com.LogiaGroup.LogiaDeck", "/product/priv-app/Ignite/Ignite.apk")
    system("com.vzw.hss.myverizon", "/product/priv-app/MyVerizon/MyVerizon.apk")
    system("com.dti.folderlauncher", "/product/priv-app/Folders/Folders.apk",
           nodelete=True)
    system("com.facebook.appmanager", "/product/priv-app/FbAppManager/FbAppManager.apk",
           nodelete=True, nodisable=True)
    system("com.glance.lockscreen", "/product/priv-app/Glance/Glance.apk",
           nodelete=True, nodisable=True, nomute=True)
    # Carrier overlays: present on every phone, switched off by Android itself.
    system("com.motorola.android.launcher.overlay.att", "/product/overlay/LauncherAtt/LauncherAtt.apk",
           enabled=False)
    system("com.oem.euiccpartnerapp.overlay.tmo", "/product/overlay/EuiccTmo/EuiccTmo.apk",
           enabled=False)
    # Something an earlier tool removed that the rules would have kept.
    system("com.motorola.tracfone.rsu", "/product/priv-app/TFRsu/TFRsu.apk", installed=False)
    # Rule tier "caution".
    system("com.motorola.moto", "/product/priv-app/Moto/Moto.apk", notifs=1)
    system("com.motorola.gamemode", "/product/priv-app/Gametime/Gametime.apk")
    system("com.verizon.mips.services", "/product/priv-app/Mips/Mips.apk")
    # Rule tier "keep".
    system("com.vzw.apnlib", "/product/app/VzwApn/VzwApn.apk")
    system("com.verizon.remoteSimlock", "/product/priv-app/SimLock/SimLock.apk")
    # No rule: reported as not classified, with a hint from the path.
    system("com.motorola.timeweatherwidget", "/product/app/TimeWeather/TimeWeather.apk")
    system("com.motorola.mystery",
           "/data/app/~~ab==/com.motorola.mystery-cd==/base.apk")
    system("com.motorola.skin.overlay", "/product/overlay/MotoSkin/MotoSkin.apk")
    # Already off before the tool ran.
    system("com.oldjunk.disabled", "/product/app/OldJunk/OldJunk.apk", enabled=False)
    system("com.gone.byothertool", "/product/app/Gone/Gone.apk", installed=False)
    # Regular apps.
    app("com.candy.game", "com.dti.folderlauncher", notifs=3)
    app("com.block.puzzle", "com.aura.oobe.motorola")
    app("com.weird.app", "com.unknown.store")
    # A wanted app whose last update came through Facebook's preinstalled updater.
    app("com.instagram.android", "com.facebook.system")
    app("com.spotify.music", "com.android.vending")
    app("com.maxapacity.ride", "null")
    app("com.sideloaded.tool", "")

    return {
        "devices": [["FAKE123", "device"]],
        "user": 0,
        "props": {"ro.product.model": "moto g stylus - 2025",
                  "ro.product.device": "mona",
                  "ro.build.version.release": "16"},
        "roles": {"android.app.role.HOME": ["com.motorola.launcher3"],
                  "android.app.role.DIALER": ["com.google.android.dialer"],
                  "android.app.role.SMS": ["com.google.android.apps.messaging"]},
        "ime": "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME",
        "focus": "NotificationShade",
        "focused_app": "com.motorola.launcher3/com.android.launcher3.CustomizationPanelLauncher",
        "wallpapers": ["com.android.systemui/com.android.systemui.wallpapers.ImageWallpaper",
                       "com.glance.lockscreen/com.glance.lockscreen.FeedWallpaper"],
        "packages": p,
        "log": [],
        "unknown": [],
        "calls": 0,
        "list_i_calls": 0,
        "down": False,
        "odd_listing": False,
        "drop_after_cmd": "",
        "appear_after": {},
    }


def load():
    with open(STATE_PATH) as f:
        return json.load(f)


def save(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    os.replace(tmp, STATE_PATH)


def parse_value(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


def ctl(args):
    if args[0] == "init":
        save(default_state())
        return 0
    state = load()
    if args[0] == "add":
        entry = pkg(system=False, path="/data/app/~~x==/%s-y==/base.apk" % args[1])
        for kv in args[2:]:
            k, v = kv.split("=", 1)
            entry[k] = parse_value(v)
        state["packages"][args[1]] = entry
    elif args[0] == "set":
        for kv in args[2:]:
            k, v = kv.split("=", 1)
            state["packages"][args[1]][k] = parse_value(v)
    elif args[0] == "del":
        state["packages"].pop(args[1], None)
    elif args[0] == "get":
        entry = state["packages"].get(args[1])
        print("absent" if entry is None else json.dumps(entry.get(args[2])))
        return 0
    elif args[0] == "top":
        for kv in args[1:]:
            k, v = kv.split("=", 1)
            state[k] = parse_value(v)
    elif args[0] == "bulk":
        for n in range(int(args[1])):
            name = "com.bulk.pkg%04d" % n
            state["packages"][name] = pkg(path="/product/app/Bulk%04d/Bulk%04d.apk" % (n, n))
    elif args[0] == "log":
        print("\n".join(state["log"]))
        return 0
    elif args[0] == "unknown":
        print("\n".join(state["unknown"]))
        return 0
    else:
        sys.stderr.write("fake_adb ctl: unknown action %s\n" % args[0])
        return 2
    save(state)
    return 0


def take_user(tokens):
    """Drop "--user N" from a token list."""
    out = []
    i = 0
    while i < len(tokens):
        if tokens[i] == "--user" and i + 1 < len(tokens):
            i += 2
            continue
        out.append(tokens[i])
        i += 1
    return out


def list_packages(state, tokens):
    flags = set(t for t in tokens if t.startswith("-"))
    words = [t for t in tokens if not t.startswith("-")]
    needle = words[0] if words else ""
    if "-i" in flags and "-3" not in flags:
        state["list_i_calls"] += 1
        for name, spec in list(state["appear_after"].items()):
            if state["list_i_calls"] > spec["calls"]:
                existing = state["packages"].get(name)
                if existing is not None:
                    existing["installed"] = True
                    existing["enabled"] = True
                else:
                    state["packages"][name] = pkg(
                        system=False, installer=spec["installer"],
                        path="/data/app/~~x==/%s-y==/base.apk" % name)
                del state["appear_after"][name]
    lines = []
    for name in sorted(state["packages"]):
        e = state["packages"][name]
        if not e["installed"] and "-u" not in flags:
            continue
        if "-s" in flags and not e["system"]:
            continue
        if "-3" in flags and e["system"]:
            continue
        if "-d" in flags and (e["enabled"] or not e["installed"]):
            continue
        if "-e" in flags and not e["enabled"]:
            continue
        if needle and needle not in name:
            continue
        line = "package:"
        if "-f" in flags and not state["odd_listing"]:
            line += e["path"] + "="
        line += name
        if "-i" in flags:
            # "odd_listing" stands for an Android build whose output is not in
            # the form debloat.sh reads.
            line += ("  from:" if state["odd_listing"] else "  installer=") + e["installer"]
        lines.append(line)
    return "\n".join(lines), 0


def shell(state, tokens):
    """Returns (output, exit status)."""
    packages = state["packages"]
    t = take_user(tokens)
    line = " ".join(t)

    if line == "am get-current-user":
        return str(state["user"]), 0
    if t[:1] == ["getprop"] and len(t) == 2:
        return state["props"].get(t[1], ""), 0
    if t[:3] == ["pm", "list", "packages"]:
        return list_packages(state, t[3:])

    if t[:2] == ["pm", "uninstall"] and len(t) == 3:
        e = packages.get(t[2])
        if e is None or not e["installed"]:
            return "Failure [not installed for %d]" % state["user"], 1
        if e["nodelete"]:
            return "Failure [DELETE_FAILED_INTERNAL_ERROR]", 1
        if e["system"]:
            e["installed"] = False
        else:
            del packages[t[2]]
        return "Success", 0

    if t[:2] == ["pm", "disable-user"] and len(t) == 3:
        e = packages.get(t[2])
        if e is None or not e["installed"]:
            return "Error: java.lang.IllegalArgumentException: Unknown package: " + t[2], 255
        if e["nodisable"]:
            return ("Error: java.lang.SecurityException: Cannot disable a protected package: "
                    + t[2]), 255
        e["enabled"] = False
        return "Package %s new state: disabled-user" % t[2], 0

    if t[:2] == ["pm", "enable"] and len(t) == 3:
        e = packages.get(t[2])
        if e is None or not e["installed"]:
            return "Error: java.lang.IllegalArgumentException: Unknown package: " + t[2], 255
        e["enabled"] = True
        return "Package %s new state: enabled" % t[2], 0

    if t[:2] in (["pm", "revoke"], ["pm", "grant"]) and len(t) == 4:
        e = packages.get(t[2])
        if e is None:
            return "Error: java.lang.IllegalArgumentException: Unknown package: " + t[2], 255
        if e["nomute"]:
            return "Error: java.lang.SecurityException: Permission is system fixed", 255
        e["notif_perm"] = t[1] == "grant"
        return "", 0

    if t[:3] == ["cmd", "package", "install-existing"] and len(t) == 4:
        e = packages.get(t[3])
        if e is None:
            return ("android.content.pm.PackageManager$NameNotFoundException: Package "
                    + t[3] + " doesn't exist"), 1
        e["installed"] = True
        return "Package %s installed for user: %d" % (t[3], state["user"]), 0

    if t[:3] == ["cmd", "appops", "set"] and len(t) == 6:
        e = packages.get(t[3])
        if e is None or not e["installed"]:
            return "Error: No UID for " + t[3] + " in user 0", 255
        if e["nomute"]:
            return "Error: java.lang.SecurityException: uid 2000 cannot change this mode", 255
        if t[5] == "default":
            e["ops"].pop(t[4], None)
        else:
            e["ops"][t[4]] = t[5]
        return "", 0

    if t[:3] == ["cmd", "appops", "get"] and len(t) == 5:
        e = packages.get(t[3])
        if e is None or not e["installed"]:
            return "Error: No UID for " + t[3] + " in user 0", 255
        mode = e["ops"].get(t[4])
        return ("%s: %s" % (t[4], mode)) if mode else "No operations.", 0

    if t[:2] == ["am", "force-stop"] and len(t) == 3:
        return "", 0

    if t[:3] == ["cmd", "role", "get-role-holders"] and len(t) == 4:
        return ";".join(state["roles"].get(t[3], [])), 0

    if line == "settings get secure default_input_method":
        return state["ime"], 0

    if line == "dumpsys window":
        return ("WINDOW MANAGER\n  mCurrentFocus=Window{a1b2c3 u0 %s}\n"
                "  mFocusedApp=ActivityRecord{d4e5f6 u0 %s t12}\n"
                % (state["focus"], state["focused_app"])), 0

    if line == "dumpsys wallpaper":
        return "\n".join("  mWallpaperComponent=ComponentInfo{%s}" % w
                         for w in state["wallpapers"]), 0

    if line == "dumpsys notification":
        out = ["Current Notification Manager state:", "  Notification List:"]
        for name in sorted(packages):
            e = packages[name]
            if not (e["installed"] and e["enabled"] and e["notif_perm"]):
                continue
            for n in range(e["notifs"]):
                out.append("    NotificationRecord(0x0%d: pkg=%s user=UserHandle{0} id=%d "
                           "tag=null importance=3 key=0|%s|%d|null|10123: Notification(...))"
                           % (n, name, n, name, n))
        return "\n".join(out), 0

    state["unknown"].append(line)
    return "/system/bin/sh: " + (t[0] if t else "") + ": inaccessible or not found", 127


def main(argv):
    if argv[:1] == ["ctl"]:
        return ctl(argv[1:])

    state = load()
    serial = None
    if argv[:1] == ["-s"]:
        serial = argv[1]
        argv = argv[2:]

    if argv == ["devices"]:
        print("List of devices attached")
        for s, st in state["devices"]:
            print("%s\t%s" % (s, st))
        print("")
        return 0

    devices = dict((s, st) for s, st in state["devices"])
    dropped = state["down"]
    if serial is not None and serial not in devices:
        sys.stderr.write("adb: device '%s' not found\n" % serial)
        return 1
    if dropped or not devices:
        sys.stderr.write("adb: no devices/emulators found\n")
        return 1

    if argv == ["reboot"]:
        state["reboots"] = state.get("reboots", 0) + 1
        save(state)
        return 0

    if argv == ["get-state"]:
        print(devices[serial] if serial else list(devices.values())[0])
        return 0

    if argv[:1] == ["shell"]:
        # Like the real thing: the arguments are joined and re-read by a shell
        # on the phone, so anything unquoted here would be interpreted there.
        line = " ".join(argv[1:])
        state["log"].append(line)
        state["calls"] += 1
        try:
            tokens = shlex.split(line)
        except ValueError:
            tokens = line.split()
        out, status = shell(state, tokens)
        # Simulate the cable coming out right after a given command ran.
        if state["drop_after_cmd"] and state["drop_after_cmd"] in line:
            state["down"] = True
            state["drop_after_cmd"] = ""
        save(state)
        if out:
            sys.stdout.write(out + "\n")
        return status

    sys.stderr.write("fake adb: unsupported: %s\n" % " ".join(argv))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
