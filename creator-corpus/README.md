# Klippt creator corpus

This directory stores the versioned contract for Klippt quality fixtures. It does not store private
recordings. Raw media and normal result files stay outside Git.

## Rules

- `manifest.json` describes stable assets, fixture coverage, consent, source roles, and expected
  invariants. Each media asset has an exact SHA-256 and byte count.
- `split-lock.json` is the only split assignment. The CLI can add a fixture to Development, Tuning,
  or Holdout. It refuses to move an existing fixture. A fixture metadata change also breaks the lock
  until a person reviews the changed fingerprint.
- `schemas/` contains strict JSON Schema 2020-12 contracts. Result files contain measurements and
  hashes only. They cannot contain paths, transcripts, cursor events, media, project names, or
  free-form observed text. The validator recalculates invariant outcomes and requires the exact
  fixture source hashes, tool hash, policy hash, and applicable model hash.
- External assets use paths relative to an explicit `--media-root`. Absolute paths, parent traversal,
  and symlink escapes fail. A committed fixture must be under `creator-corpus/fixtures/` and have
  explicit redistribution consent.
- `media/`, `results/`, and `staging/` are ignored as a second line of defense. Do not put private
  material in the repository and rely only on the ignore rule.

## Commands

```bash
npm run corpus:validate
node scripts/creator-corpus.mjs verify-media --media-root /path/to/private/corpus
node scripts/creator-corpus.mjs validate-results --input /path/to/result-or-directory
node scripts/creator-corpus.mjs assign --fixture <id> --split development
node scripts/creator-corpus.mjs extract --asset <derived-asset-id> \
  --media-root /path/to/private/corpus --ffmpeg /path/to/pinned/ffmpeg
```

`assign` only adds a missing assignment. It never changes an existing split. `extract` reads a fixed
packet-copy recipe from the reviewed manifest, verifies the source and FFmpeg hashes, writes beside
the destination through a temporary file, verifies the exact output, and publishes without
overwriting an existing file.

## Design references

- [MLCommons Croissant 1.1](https://docs.mlcommons.org/croissant/docs/croissant-spec-1.1.html)
  defines versioned datasets, checksummed files, stable record IDs, and explicit splits. Klippt uses
  those principles without adopting JSON-LD because the corpus also stores media-system result
  contracts that Croissant does not define.
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) supplies the strict, inspectable data
  contracts.
- [scikit-learn data-leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage)
  requires the test set to stay outside tuning decisions. Klippt calls that set Holdout and locks its
  assignment separately.
- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html) defines explicit stream mapping and
  `-bitexact`; the codec documentation states that bit-exact mode exists for regression tests.
- [Git ignore documentation](https://git-scm.com/docs/gitignore) recommends a tracked `.gitignore`
  for shared project exclusions.
