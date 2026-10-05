# AI agent (archived)

> **Status: removed on 2026-10-05.** Klippt is recording-only. The in-app LLM chat was removed
> first; the `klippt agent` editing CLI, the agent editor session, the validated tool executor
> (`agent-tools.ts`), and the agent planning, import, verification, and settings modules followed
> on the same day. The last source that contains them is the git tag
> `archive/pre-cleanup-2026-10-05`. Read the earlier version of this page there
> (`git show archive/pre-cleanup-2026-10-05:technical-documentation/architecture/ai-agent.md`)
> for the tool schema, tool loop, checkpoints, and context management. The CLI contract is
> archived in [agent-cli.md](../agent-cli.md).

No code in the app talks to a language model, and no external process can edit an open project.

## What was removed

| Area | Removed source (see the archive tag) |
|---|---|
| Tool executor | `electron/ai-edition/agent-tools.ts` |
| Agent planning and checks | `electron/ai-edition/agent*.ts` except `agentHistory.ts` |
| Agent CLI | `electron/cli/agent*.ts` except `agentReceiptHashes.ts`, `editorAgentBroker.ts`, `electron/cli/skill/` |
| Editor session | `src/lib/ai-edition/agent/`, the `klippt:agent-session-*` IPC channels, preload `onAgentSessionRequest` / `replyAgentSession` |
| Edit checks | `src/lib/ai-edition/checks/` (except the `fixtures.ts` test helper) and `analyzeProjectChecks.ts` |
| Still-frame preview | `src/cli/agentPreviewFrame.ts` and `export --agent-preview-*` |
| Tooling | `scripts/klippt`, `scripts/agent-eval/`, `scripts/create-agent-proof-*` |

## What remains

- `electron/ai-edition/document-service.ts` and `projectTransactions.ts` own saved snapshots and
  transactions for every writer.
- `electron/ai-edition/agentHistory.ts` keeps the durable write history used by guarded undo and
  redo. Its name is historical; the editor still writes through it.
- `electron/cli/agentReceiptHashes.ts` computes the receipt hashes that project transactions
  record.
- The document schema keeps every field the agent wrote, so projects edited by the archived CLI
  still open, play, and export.
