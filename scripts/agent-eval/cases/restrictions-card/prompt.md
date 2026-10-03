# Task

You have the Klippt agent CLI (`klippt agent …`). A cloned project is open:
project id `{project_id}`, file `{project_path}`. It is Olle's Kimi swarm
experiment video.

Olle's request: "Show the round-one restrictions while I explain them."

Find the passage in the narration where he explains the restrictions of round
one of the experiment. Pick the card video that matches that passage from
`/Users/olle/dev/kimi-swarm-arena/_staging/edit-2026-09-17/broll/` and place it
as a B-roll overlay covering exactly that passage — start on the first word of
the explanation, end when he moves on.

Rules:

- Do not touch the narration, the audio, or any existing cut. Placement only.
- Use the guarded CLI flow; do not edit the project file by hand.
- Save frames from the start and the middle of the placed card into
  `{frames_dir}` so the placement can be reviewed.
- If the check gate reports new errors caused by your placement, fix or revert
  before finishing.
