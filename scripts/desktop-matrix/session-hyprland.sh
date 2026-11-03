#!/bin/bash
# Private Hyprland nested in a headless Sway, with the real xdg-desktop-portal-hyprland backend.
. /scripts/common.sh
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=gles2
mkdir -p "$XDG_CONFIG_HOME/sway" "$XDG_CONFIG_HOME/hypr"
printf 'output HEADLESS-1 resolution 1920x1080\ndefault_border none\n' > "$XDG_CONFIG_HOME/sway/config"
cat > "$XDG_CONFIG_HOME/xdg-desktop-portal/portals.conf" <<CONF
[preferred]
default=gtk
org.freedesktop.impl.portal.ScreenCast=hyprland
org.freedesktop.impl.portal.Screenshot=hyprland
CONF
start_audio
sway -c "$XDG_CONFIG_HOME/sway/config" > "$OUT/parent-sway.log" 2>&1 &
for i in $(seq 50); do [ -e "$XDG_RUNTIME_DIR/wayland-1" ] && break; sleep .2; done
cat > "$XDG_CONFIG_HOME/hypr/hyprland.conf" <<CONF
monitor=,1920x1080,auto,1
misc { disable_hyprland_logo=true
 disable_splash_rendering=true
 force_default_wallpaper=0 }
ecosystem { no_update_news=true
 no_donation_nag=true }
animations { enabled=false }
CONF
cat > /tmp/picker.sh <<PICK
#!/bin/sh
echo "\$(date +%s) xdph picker asked" >> $OUT/picker.log
echo "[SELECTION]r/screen:\$(hyprctl monitors -j | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["name"])')"
PICK
chmod +x /tmp/picker.sh
cat > "$XDG_CONFIG_HOME/hypr/xdph.conf" <<CONF
screencopy {
  custom_picker_binary = /tmp/picker.sh
  allow_token_by_default = true
}
CONF
WAYLAND_DISPLAY=wayland-1 XDG_CURRENT_DESKTOP=Hyprland Hyprland -c "$XDG_CONFIG_HOME/hypr/hyprland.conf" > "$OUT/hyprland.log" 2>&1 &
for i in $(seq 100); do [ -e "$XDG_RUNTIME_DIR/wayland-2" ] && break; sleep .2; done
sleep 2
export WAYLAND_DISPLAY=wayland-2 XDG_CURRENT_DESKTOP=Hyprland
export HYPRLAND_INSTANCE_SIGNATURE=$(ls "$XDG_RUNTIME_DIR/hypr" | head -1)
hyprctl version > "$OUT/compositor-version.txt" 2>&1
hyprctl monitors > "$OUT/monitors.txt" 2>&1
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_CONFIG_HOME HYPRLAND_INSTANCE_SIGNATURE
/usr/lib/xdg-desktop-portal-hyprland > "$OUT/xdph.log" 2>&1 &
/usr/lib/xdg-desktop-portal-gtk > "$OUT/xdp-gtk.log" 2>&1 &
sleep 1
start_portal
foot -e sh -c 'while :; do date +%s.%N; sleep .05; done' > /dev/null 2>&1 &
sleep 1
cat > /tmp/type-path.sh <<'TYPE'
#!/bin/sh
wtype -M ctrl a -m ctrl; sleep .3; wtype "$1"; sleep .5; wtype -k Return
TYPE
chmod +x /tmp/type-path.sh
run_journey "${JOURNEY_NAME:-hyprland}" --type-path /tmp/type-path.sh --screenshot 'grim {}'
hyprctl clients > "$OUT/clients.txt" 2>&1
