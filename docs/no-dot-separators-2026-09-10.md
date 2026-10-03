# Plain labels and metadata spacing

Olle asked to remove decorative dot separators across Klippt. Review effects now has a plain heading, without a redundant count. Export metadata uses separate wrapping fields with CSS spacing. Other labels use ordinary punctuation; translations retain their language and interpolation values. Password masks and functional icons are unchanged.

The durable rule is in `technical-documentation/product-behavior.md`, Visual direction.

Reference checked before implementation: [MDN CSS gap](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/gap), for wrapping flex metadata fields. Existing React 18 and CSS modules are sufficient; no dependency changes.

Verification: app and test TypeScript checks pass, i18n validation passes across all namespaces/locales, lint passes with the existing oversized license-evidence warning. Full unit suite ran: 284 files passed, and one camera-menu test expected the old label. After updating that expectation and the matching recorder-tooltip fixture, all 47 tests in the remaining file pass. Together, 2,950 tests pass and one is skipped. Production Vite build passes. Evidence is under `artifacts/no-dot-separators-2026-09-10/`.

Installed in `/Applications/Klippt.app` after Developer ID packaging and deep strict signature checks. Both designated requirements match the prior app and cursor helper. Prior build retained under `~/Library/Application Support/Klippt/Archived Apps.noindex/installed-before-no-dots-20260910.bundle-backup`. Real Mac UI confirms the plain Review effects heading, updated timeline tooltips, and spaced MP4/GIF metadata. Export screenshot inspected; no clipping. Restored MP4 selection, closed the dialog, and left the saved project open on Automatic. No recording or media behavior changed.
