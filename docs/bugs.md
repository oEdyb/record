# Open bugs — Linux port

Reported by Olle on his Niri desktop. Newest first. Move an entry to its commit
message (and delete it here) once it is fixed and verified on his machine.

## Linux Parakeet helper invents words over trailing silence (2026-10-29)

Take 28 of `recording-1793279632751` ends in ~18 s of silence (about -60 dB).
`klippt-parakeet-stt` returns a short invented phrase squeezed into its last
0.6 s, with words of zero duration, and the phrase changes between runs ("we're
not going to be able to do that", "you can see that we have to do it"). Clean cut
then cuts it as a false start; that is harmless only because it is silence.
Guard in the helper: drop runs of zero-duration words, or words whose audio is
below about -50 dB.

## Recordings opens the latest recording instead of a list (2026-10-29)

The pill's Settings > Recordings button calls `switchToEditor()`
(`LaunchWindow.tsx` `openStudio`), which reopens the most recent recording.
Olle expects it to show his recordings so he can pick one.

## Recording pill jumps when a popup opens (2026-10-29)

Opening Settings, or pressing Undo (its notice), moves the whole recording pill.
Olle says the Settings case was reported before and still happens. Controls must
stay under the pointer: a popup may grow away from the pill, never shift it.
Suspect: the HUD window resizes to fit the popup and Niri re-places the floating
window. Check how Linux resizes the HUD window versus macOS before changing layout.

## Review window shows a wallpaper before the recording (2026-10-28)

After Stop: spinner, then a bare wallpaper background, then the recording.
`RecordingReviewShell` lifts the spinner when the hidden `<video>` decodes its
first frame (`useVideoFirstFrame`), but the visible pixels come from the native
compositor canvas, and `.previewFrame` paints the wallpaper as a CSS background.
Unverified which arrives first: an empty canvas over the CSS wallpaper, or a
native frame composited before the screen texture exists. Reveal should wait for
the first native frame that contains the screen. Cosmetic: recordings unaffected.

## Webcam file ends ~0.6 s before the screen at 4K/30 (2026-10-29)

`recording-1793279395572`: screen 18.07 s, webcam 17.46 s, start aligned
(`webcamOffsetMs` 1). 1080p/60 recordings matched to within 15 ms. Likely the
4K encoder flush at Stop drops the tail. Workaround: wait a second before Stop.

## Mic error does not name the cause (2026-10-29)

"PipeWire linked a different audio source than the selected input" appeared
because EasyEffects (Process all inputs, its default) re-targeted Klippt's
stream, node `openscreen-pipewire-helper`, to `easyeffects_source`. Fixed on
Olle's machine by adding that node name to EasyEffects' input blocklist. Other
users with EasyEffects hit the same wall: say that another audio app redirected
the microphone and how to exclude Klippt. The stream's node name comes from the
helper binary, not the `openscreen-audio` stream label.

## Clicks are not recorded on Linux (feature, 2026-10-28)

Wayland gives unprivileged apps no button events, so the cursor sidecar only has
`move` samples: no click animation, and auto zoom loses its strongest signal.
Possible: read pointer devices from `/dev/input` (devices with BTN_LEFT and no
letter keys, never keyboards), timestamp presses, merge with the portal cursor
track. Needs input-group or a mice-only udev ACL; off when access is missing.
