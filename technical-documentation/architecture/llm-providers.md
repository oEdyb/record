# LLM providers (archived)

> **Status: removed on 2026-10-05.** Klippt is recording-only. The in-app LLM provider layer and
> the chat panel it served were deleted in the `cleanup/slim-repo-2026-10-05` branch. The last
> source that contains them is the git tag `archive/pre-cleanup-2026-10-05`. Read this page there
> (`git show archive/pre-cleanup-2026-10-05:technical-documentation/architecture/llm-providers.md`)
> for the full design.

## What was removed

| Area | Removed source (see the archive tag) |
|---|---|
| Provider registry | `electron/ai-edition/provider-registry.ts` |
| Credential store | `electron/ai-edition/llm-config-store.ts` |
| Model discovery | `electron/ai-edition/llm-provider-auth.ts` |
| Model transport | `electron/ai-edition/deep-agent/chat-model.ts` (LangChain chat model per provider) |
| One-shot caption translation | `electron/ai-edition/caption-translate.ts` |
| Settings UI | `src/components/ai-edition/ProviderSettings.tsx` |
| Bridge actions | `aiEdition` actions `llm.*` and `captions.translate` |

No code in `src`, `electron`, or `scripts` imports `langchain` or any `@langchain/*` package
after the removal. The packages stay in `package.json` and `package-lock.json` until the owner
re-signs the approved dependency inputs in `supply-chain/approved-dependency-inputs.json`.

## User data left in place

The removal stops reading and writing provider data. It does not delete anything a user already
has:

- `llm-config.json` in the app's user-data folder (provider and model selection).
- `llm-credentials.enc` in the same folder (API keys encrypted with Electron `safeStorage`, backed
  by the OS credential store).

Klippt no longer opens either file, so no Keychain prompt is triggered for them. A future feature
that restores provider access must decide whether to migrate or ignore these files.

## Restoring

Restore the files above from `archive/pre-cleanup-2026-10-05`, re-add the bridge actions in
`src/native/contracts.ts`, `src/native/client.ts`, `electron/ipc/nativeBridge.ts`, and
`electron/native-bridge/services/aiEditionService.ts`, and confirm the LangChain packages still
match the approved dependency inputs.
