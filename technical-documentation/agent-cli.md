# Agent editing CLI (archived)

> **Status: removed on 2026-10-05.** Klippt is recording-only. The `klippt agent` editing CLI, its
> editor broker, the agent editor session in the renderer, the bundled `SKILL.md`, the
> `scripts/klippt` launcher, and the `scripts/agent-eval/` harness were deleted on the
> `cleanup/slim-repo-2026-10-05` branch. The last source that contains them is the git tag
> `archive/pre-cleanup-2026-10-05`. Read the full contract there with
> `git show archive/pre-cleanup-2026-10-05:technical-documentation/agent-cli.md`, and restore the
> code from that tag before relying on any `klippt agent` command.

The non-agent CLI commands remain: `klippt record`, `export`, `sources`, `pack`, `info`, and
`captions`. See `klippt help`. The internal `export --agent-preview-*` flags were removed with
the agent CLI.

Kept because saved projects and the editor still use them:

- `electron/ai-edition/agentHistory.ts`: the durable write history behind guarded undo and redo.
- `electron/cli/agentReceiptHashes.ts`: receipt hashes written by project transactions.
- `electron/ai-edition/document-service.ts` and `projectTransactions.ts`.
