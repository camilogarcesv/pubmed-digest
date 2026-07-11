# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                                        # install deps
pnpm typecheck                                       # tsc --noEmit
pnpm test                                             # vitest run (offline, no network)
pnpm exec vitest run tests/pubmed.test.ts             # run a single test file
pnpm exec vitest run -t "reconciles"                  # run tests matching a name pattern
pnpm build                                            # tsc emit to dist/

pnpm dev:digest -- --dry-run --limit 5                # run digest, print only, no delivery/state write
pnpm dev:search "glioma MRI" -- --dry-run --limit 5   # run ad-hoc search, print only
```

Note the `--` before CLI flags in `dev:digest`/`dev:search` — required so pnpm forwards them to
the script rather than consuming them itself. `--dry-run` still hits the real PubMed and Anthropic
APIs (only delivery and `state.json` writes are skipped), so `ANTHROPIC_API_KEY` (and ideally
`EUTILS_EMAIL`) must be set in `.env` even for dry runs. Copy `.env.example` → `.env` first.

There is no lint script configured.

## Architecture

Single-package TypeScript CLI (`node:util` `parseArgs`, no CLI framework) with two commands,
`digest` and `search`, both implemented in `src/index.ts`. The pipeline is the same shape for
both: **esearch (PubMed) → efetch (PubMed) → score (Anthropic) → render → deliver/print**, with
`digest` adding a dedupe/state step and a threshold filter that `search` does not have.

- **`src/pubmed.ts`** — E-utilities client (`PubMedClient`). Uses `datetype=edat` +
  `reldate=lookbackDays` (not `pdat`/mindate/maxdate) so "new" means "newly indexed by PubMed,"
  matching PubMed's own alert semantics. Has a request throttle (min interval between calls,
  tighter with an NCBI API key) and retry/backoff on 429/5xx. XML parsing (fast-xml-parser) is
  configured with `parseTagValue: false` to preserve leading zeros in dates/PMIDs, plus a manual
  entity decoder (`decodeEntities`) for numeric character references (`&#xed;`) that the parser's
  `htmlEntities` option doesn't cover — PubMed XML is full of these in author names and abstracts.
  `journalTerm`/`topicTerm` are pure query-string builders, unit-tested separately from the client.

- **`src/scoring.ts`** — wraps `@anthropic-ai/sdk` with a **forced tool call**
  (`tool_choice: { type: "tool", name: "submit_scores" }`) so the model must return structured
  scores; the tool's `input_schema` intentionally omits `strict: true` because strict mode
  rejects `minimum`/`maximum`, so range validation (0–10) is done by the zod schema instead.
  `AnthropicScorer.score()` batches papers (`config.batchSize`) and **reconciles** each batch's
  output against the PMIDs actually sent: PMIDs the model invents are dropped, PMIDs it omits are
  re-scored once, and anything still unscored after that gets a neutral fallback score rather than
  being silently lost. `search` and `digest` share this scorer but pass a different `ScoreContext`
  (`search` sets `topic`, which the system prompt in `buildSystemPrompt` makes the primary ranking
  criterion instead of the profile).

- **`src/profile.ts`** + **`profile.yaml`** — the interest profile is data, not code. It's loaded
  and zod-validated at startup and fed into the scoring system prompt. This is the file a non-dev
  user is expected to edit to change what counts as relevant; `src/config.ts` is for the operator
  (journals, thresholds, model, batch sizes) and is expected to be edited directly since there's
  no separate schema/UI for it.

- **`src/state.ts`** / **`src/deliver.ts`** — both define a narrow interface
  (`SeenStore`, `Deliverer`) with the real implementation used at runtime
  (`JsonFileStore`/`TelegramDeliverer`) and a throwaway one used for `--dry-run` or tests
  (`MemoryStore`/`ConsoleDeliverer`). Swap the concrete class in `index.ts` if a different backend
  is ever needed — nothing else in the pipeline should need to change.

- **`src/index.ts`** orchestrates: `digest` de-dupes PMIDs across all configured journals/topics
  *and* against `state.json` before scoring anything (so a paper matching two sources, or already
  seen, is never billed twice); `search` does neither. `config.markSeenMode` controls whether
  state records only delivered papers or every paper considered — "considered" is the default so
  below-threshold papers aren't re-fetched and re-scored (and re-billed) on the next run.

### Testing

Tests are fully offline. PubMed XML fixtures live in `tests/fixtures/`; Anthropic calls are
mocked at the `CreateMessage` function level (see `AnthropicScorer`'s constructor, which takes an
injected message-creation function rather than instantiating the SDK client itself) — this is the
seam that makes `scoring.test.ts` able to script multi-call sequences (e.g. asserting the
reconcile-on-missing-PMID retry actually fires) without any network access.

### CI

`.github/workflows/digest.yml` runs `digest` on a weekly cron and commits the updated
`state.json` back to the repo (state.json is gitignored for local dev but force-added in CI —
see the workflow's commit step). Secrets (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `NCBI_API_KEY`, `EUTILS_EMAIL`) are GitHub Actions repo secrets.
