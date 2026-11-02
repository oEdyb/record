import sys, dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib
log = open(sys.argv[1], "a", buffering=1)
class SS(dbus.service.Object):
    n = 0
    @dbus.service.method("org.freedesktop.ScreenSaver", in_signature="ss", out_signature="u")
    def Inhibit(self, app, reason):
        SS.n += 1
        log.write(f"Inhibit app={app!r} reason={reason!r} -> cookie {SS.n}\n"); return SS.n
    @dbus.service.method("org.freedesktop.ScreenSaver", in_signature="u")
    def UnInhibit(self, cookie):
        log.write(f"UnInhibit cookie={int(cookie)}\n")
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName("org.freedesktop.ScreenSaver", bus)
SS(bus, "/org/freedesktop/ScreenSaver"); SS(bus, "/ScreenSaver")
log.write("ready\n")
GLib.MainLoop().run()
