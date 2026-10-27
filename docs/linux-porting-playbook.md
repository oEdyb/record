# Linux porting playbook

The reusable playbook is maintained with Olle's shared development skill:

[Desktop Linux porting: Klippt case and reusable playbook](/home/olle/dev/skills/skills/development/references/linux-porting.md)

Portable location after cloning `oEdyb/skills`:
`skills/development/references/linux-porting.md`. The development skill routes desktop
porting requests there. Its dated source entry is `klippt-linux-20261027`, case D26.
The October 27 addition is local in the skills repository; it has not been published.

It records the complete implementation sequence, why the existing UI was retained,
shared lifecycle/native helper boundaries, clip/audio/camera recovery contracts,
DMA-BUF/EGL and FFmpeg decisions, isolated desktop testing, package verification,
reproduced failure cases and the limits exposed by first-user feedback.

Project evidence stays here rather than being copied into the skill:

| Record | Purpose |
| --- | --- |
| [Handoff](../HANDOFF.md) | Current artifact and next work |
| [Acceptance](linux-port-acceptance-2026-10-26.md) | Finite critical journeys and open gates |
| [Implementation history](linux-port-2026-10-26.md) | Chronological measurements and corrections |
| [HUD corrections](../artifacts/linux-port-2026-10-27/hud-fixes/README.md) | Dragging, source access and Niri decoration |
| [Toast correction](../artifacts/linux-port-2026-10-27/toasts/README.md) | Real missing-camera overlap and corrected package |
| [Product behavior](../technical-documentation/product-behavior.md) | Intended shared UX |

Do not turn a window-only capture pass into a monitor-exclusion claim. The first
user reported the pill in monitor footage; auto-hide with a reliable control-access
path remains open. Editable cursor telemetry on that user's take also requires
end-to-end verification. Those gaps belong in the acceptance record, not behind a
claim of complete Mac/Linux parity.
