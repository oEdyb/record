#!/bin/sh
# Compositor screenshot on GNOME; needs gnome-shell --unsafe-mode.
exec gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
  --method org.gnome.Shell.Screenshot.Screenshot false false "$1"
