# Klippt UI concept brief (2026-10-04)

Goal: Olle wants the recorder UI "a lot cooler, smoother and better". Produce standalone HTML
prototypes of alternative directions so he can pick one before anything is built in the app.

## Product facts (do not change behavior, only look and motion)

Klippt is a Mac screen recorder for creators. Flow: floating HUD bar → Record → compact pill
while recording → Pause/Continue makes clips → Backspace removes newest clip → Stop → Review.

Floating HUD, idle (today ~829×84 CSS px, one dark bar at bottom of screen):
- Drag handle, tray orientation, source chip ("Built-in Display" / window name), system audio,
  microphone, camera, device settings gear, cursor toggle, Record button, Recordings (clapper),
  Notes, language "EN", minimize, close.
- A lower row: read-only clip-history strip (one rounded segment per kept clip, width ∝
  duration, min width, newest 6–8 visible, older collapse to "+N", active segment grows in
  recording red, newest completed brighter). Empty rail when idle. No "N clips" label.

Recording (compact pill ~224×50): Stop (with live timer, red), Pause/Continue, Backspace
(remove last clip), Expand. Paused: Pause becomes Continue, setup controls unlock.
Saving after Stop: keep timer and layout, disable transport, then hand off to Review.

Review window (after Stop): video playback with seek bar, Record (new recording),
Save video (primary), Original files, Recordings. No timeline, inspector or canvas handles.
Export dialog: two choices "Separate takes" (default, original files per clip) and
"One video"; success state shows Show in folder + Close, not a wall of text.

Timer = total of kept clips + active clip; drops immediately after Backspace.

## Hard constraints from the design rules
- Fonts: Geist (UI) + Geist Mono (time/values) from Google Fonts. Base 13px, nothing < 11px.
- Red only for recording/destructive. Green only for transient success / live audio level.
- No decorative middle dots/bullets in labels. Sentence case. Short labels: Record, Pause,
  Continue, Remove, Stop, Save video.
- Lucide-style line icons (inline SVG, 1.5–1.75 stroke). Use the Klippt mark from
  `klippt-mark.svg` in this folder (inline its paths; fill currentColor).
- Respect prefers-reduced-motion (state changes without movement).
- Animate transform/opacity. Motion explains state/continuity.

A direction MAY deliberately break a "soft" style rule (e.g. monochrome-only chrome) if that is
its point, but it must say so in a visible "Rules this bends" note on the page.

## Prototype requirements (each HTML file)
- One self-contained .html file, no build step. Inline CSS/JS. Only external: Google Fonts.
- Fake desktop backdrop (a blurred editor/terminal-like scene made with CSS, no images needed)
  so the floating HUD reads in context.
- A small fixed "concept control" strip at top-left (clearly outside the product UI) with
  buttons: Idle, Recording, Paused, Review, plus a "Replay intro" and a "Reduced motion" toggle.
- The prototype must also be truly interactive: clicking Record starts a live timer, Pause /
  Continue creates clips in the history, Backspace removes the newest clip (timer drops),
  Expand toggles setup, Stop → short saving state → Review. In Review, Save video opens the
  export dialog; Export → progress → success.
- Keyboard: Space = Pause/Continue while recording, Backspace = remove clip, Esc closes dialog.
- A short header card (dismissible) naming the direction, its one-line idea, the signature
  moment, and "Rules this bends".
- Must look great at 1440×900 and still work at 1280×800. Visible keyboard focus.
- Polish level: this is a pitch. Springy, interruptible motion; precise spacing; real
  hover/press states; tabular numerals for the timer.
