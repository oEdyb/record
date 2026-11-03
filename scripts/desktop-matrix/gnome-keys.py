#!/usr/bin/env python3
"""Send keys to a headless GNOME through Mutter's RemoteDesktop D-Bus API (private session only)."""
import subprocess
import sys
import time

from gi.repository import Gio, GLib

KEYS = {"Tab": 0xFF09, "Return": 0xFF0D, "Space": 0x20, "Down": 0xFF54, "Up": 0xFF52, "Right": 0xFF53,
        "Left": 0xFF51, "Escape": 0xFF1B, "Shift": 0xFFE1, "Control": 0xFFE3, "Home": 0xFF50, "End": 0xFF57}
bus = Gio.bus_get_sync(Gio.BusType.SESSION)


def call(path, iface, method, args=None, reply=None):
    return bus.call_sync("org.gnome.Mutter.RemoteDesktop", path, iface, method, args,
                         GLib.VariantType(reply) if reply else None, Gio.DBusCallFlags.NONE, 5000, None)


session = call("/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop", "CreateSession", None, "(o)").unpack()[0]
iface = "org.gnome.Mutter.RemoteDesktop.Session"
call(session, iface, "Start")


def key(sym, down):
    call(session, iface, "NotifyKeyboardKeysym", GLib.Variant("(ub)", (sym, down)))
    time.sleep(0.04)


def tap(name):
    parts = name.split("+")
    for part in parts[:-1]:
        key(KEYS[part], True)
    last = parts[-1]
    sym = KEYS.get(last, ord(last) if len(last) == 1 else None)
    key(sym, True)
    key(sym, False)
    for part in reversed(parts[:-1]):
        key(KEYS[part], False)


for arg in sys.argv[1:]:
    if arg.startswith("text:"):
        for char in arg[5:]:
            key(ord(char), True)
            key(ord(char), False)
    elif arg.startswith("sleep:"):
        time.sleep(float(arg[6:]))
    else:
        tap(arg)
    time.sleep(0.15)
call(session, iface, "Stop")
