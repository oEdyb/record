#!/bin/bash
# Private headless Sway with the real xdg-desktop-portal-wlr backend.
. /scripts/common.sh
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=${WLR_RENDERER:-gles2} XDG_CURRENT_DESKTOP=sway
cat > "$XDG_CONFIG_HOME/xdg-desktop-portal/portals.conf" <<CONF
[preferred]
default=gtk
org.freedesktop.impl.portal.ScreenCast=wlr
org.freedesktop.impl.portal.Screenshot=wlr
CONF
mkdir -p "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr" "$XDG_CONFIG_HOME/sway"
cat > /tmp/chooser.sh <<CHOOSER
#!/bin/sh
echo "\$(date +%s) xdpw chooser asked" >> $OUT/picker.log
echo HEADLESS-1
CHOOSER
chmod +x /tmp/chooser.sh
cat > "$XDG_CONFIG_HOME/xdg-desktop-portal-wlr/config" <<CONF
[screencast]
chooser_type=simple
chooser_cmd=/tmp/chooser.sh
CONF
cat > "$XDG_CONFIG_HOME/sway/config" <<CONF
output HEADLESS-1 resolution 1920x1080 bg #204060 solid_color
default_border none
CONF
start_audio
sway -c "$XDG_CONFIG_HOME/sway/config" > "$OUT/sway.log" 2>&1 &
for i in $(seq 50); do [ -e "$XDG_RUNTIME_DIR/wayland-1" ] && break; sleep .2; done
export WAYLAND_DISPLAY=wayland-1 SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.* | head -1)
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_CONFIG_HOME SWAYSOCK XDG_DATA_HOME
swaymsg -t get_version > "$OUT/compositor-version.txt"
/usr/lib/xdg-desktop-portal-wlr -l DEBUG > "$OUT/xdpw.log" 2>&1 || /usr/libexec/xdg-desktop-portal-wlr -l DEBUG > "$OUT/xdpw.log" 2>&1 &
/usr/lib/xdg-desktop-portal-gtk > "$OUT/xdp-gtk.log" 2>&1 || /usr/libexec/xdg-desktop-portal-gtk > "$OUT/xdp-gtk.log" 2>&1 &
sleep 1
start_portal
foot -e sh -c 'while :; do date +%s.%N; sleep .05; done' > /dev/null 2>&1 &
sleep 1
cat > /tmp/type-path.sh <<'TYPE'
#!/bin/sh
wtype -M ctrl a -m ctrl; sleep .3; wtype "$1"; sleep .5; wtype -k Return
TYPE
chmod +x /tmp/type-path.sh
run_journey "${JOURNEY_NAME:-sway}" --type-path /tmp/type-path.sh --screenshot 'grim {}'
swaymsg -t get_tree > "$OUT/tree.json" 2>/dev/null
