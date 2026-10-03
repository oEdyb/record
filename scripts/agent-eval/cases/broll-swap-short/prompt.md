# Task

You have the Klippt agent CLI (`klippt agent …`). A cloned project is open:
project id `{project_id}`, file `{project_path}`.

One of the existing video B-roll overlays should show gameplay instead of its
current card media. List the project's overlays, pick one, and swap its media
to a short gameplay clip (7–12 s) from
`/Users/olle/dev/kimi-swarm-arena/_staging/play-2026-09-11/clips/`.

Rules:

- Keep the overlay's placement, motion, and opacity; only the media changes.
- If the new clip is shorter than the slot, shorten the slot to the available
  media — never leave black frames.
- Use the guarded CLI flow; do not edit the project file by hand.
- Save at least two frames across the swapped span into `{frames_dir}`,
  including one after the new media ends, so the swap can be reviewed.
