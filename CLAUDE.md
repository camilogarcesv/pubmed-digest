# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                                        # install deps
pnpm typecheck                                       # tsc --noEmit (src + tests)
pnpm typecheck:worker                                 # tsc for worker/ (Workers runtime types)
pnpm test                                             # vitest run (offline, no network)
pnpm eval -- --votes dump.json                        # measure the ranking against 👍/👎 votes
pnpm exec vitest run tests/pubmed.test.ts             # run a single test file
pnpm exec vitest run -t "reconciles"                  # run tests matching a name pattern
pnpm build                                            # tsc emit to dist/

pnpm dev:digest -- --dry-run --limit 5                # run digest, print only, no delivery/state write
pnpm dev:search "glioma MRI" -- --dry-run --limit 5   # run ad-hoc search, print only

# Cheap test iteration (avoid paying for scoring on every test):
pnpm dev:digest -- --limit 5 --dry-run --save-cache   # build .cache/digest.json once (fetch+score)
pnpm dev:digest -- --from-cache --to me,amigo         # replay from cache (no network), pick recipients
pnpm dev:digest -- --rescore --dry-run --save-cache   # re-score cached papers (skips PubMed)
```

`--from-cache` and `--rescore` never write `state.json`, and they are mutually exclusive. `--to`
picks recipients (default: only `me`); `--dry-run` delivers to nobody. `--cache <path>` overrides
the default cache path. `LOG_LEVEL=debug` raises log verbosity (logs go to stderr; default `info`).

Note the `--` before CLI flags in `dev:digest`/`dev:search` — required so pnpm forwards them to
the script rather than consuming them itself. (`stripArgSeparator` in `src/util.ts` then removes
the forwarded `--` before `parseArgs` sees it, since `parseArgs` would otherwise treat it as an
option terminator and silently demote every flag to a positional.) `--dry-run` still hits the real
PubMed and Anthropic APIs (only delivery and `state.json` writes are skipped), so
`ANTHROPIC_API_KEY` (and ideally `EUTILS_EMAIL`) must be set in `.env` even for dry runs. Copy
`.env.example` → `.env` first.

Requires Node >= 22.13 (`engines`) and pnpm 11 (pinned via `packageManager`). There is no lint
script configured.

## Architecture

Single-package TypeScript CLI (`node:util` `parseArgs`, no CLI framework) with two commands,
`digest` and `search`. **`src/index.ts` is CLI wiring only** — it parses flags, builds the real
dependencies and hands them to **`src/pipeline.ts`**, where the orchestration lives. That split
exists so the pipeline can be tested with fakes (`tests/pipeline.test.ts`) instead of HTTP.

The pipeline: **esearch → efetch → prefilter → score → re-rank → select → deliver**, with
`digest` adding a dedupe/state step and threshold selection that `search` does not have.

| Module | Role |
| --- | --- |
| `src/index.ts` | CLI parsing and dependency construction — the only file that wires concretes together |
| `src/pipeline.ts` | Orchestration for both commands, over injected dependencies |
| `src/config.ts` | Operator config (model, caps, batch sizes, excluded publication types, pricing) |
| `src/env.ts` | Secrets, from the environment only, zod-validated |
| `src/profile.ts` + `profile.yaml` | The interest profile *and* the coverage — what "relevant" means and what gets searched |
| `src/pubmed.ts` | E-utilities client, query builders, XML parsing |
| `src/scoring.ts` | Anthropic forced-tool scorer, batch reconciliation, top-K re-rank |
| `src/filter.ts` | Pre-scoring filters: publication type, duplicate DOI |
| `src/digest.ts` | Selection (threshold + cap + floor) and Telegram-HTML rendering (pure) |
| `src/deliver.ts` | `Deliverer` interface: Telegram, console, multi-recipient fan-out |
| `src/state.ts` | `SeenStore` interface: JSON-file and in-memory stores |
| `src/metrics.ts` | Run counters, token usage, estimated cost, job summary |
| `src/cache.ts` | Run snapshots for `--save-cache` / `--from-cache` / `--rescore` |
| `src/recipients.ts` | Named-recipient registry and `--to` selection |
| `src/feedback.ts` | Vote callback format and keyboards — shared by the digest AND the Worker |
| `src/votes.ts` | Reading votes, dynamic exemplars, eval metrics |
| `src/eval.ts` | The `pnpm eval` report |
| `src/types.ts` | `Paper` / `ScoredPaper` / `Author` — the shared data shapes |
| `src/logger.ts` | Tiny JSON logger, stderr only |
| `src/util.ts` | `chunk`, `sleep`, `stripArgSeparator` |
| `worker/worker.ts` | Cloudflare Worker: Telegram webhook + KV storage + `/votes` endpoint |

- **`src/pubmed.ts`** — E-utilities client (`PubMedClient`). Uses `datetype=edat` +
  `reldate=lookbackDays` (not `pdat`/mindate/maxdate) so "new" means "newly indexed by PubMed,"
  matching PubMed's own alert semantics. Has a request throttle (min interval between calls,
  tighter with an NCBI API key) and retry/backoff on network errors, 429 and 5xx (honouring
  `retry-after` when present). XML parsing (fast-xml-parser) is configured with
  `parseTagValue: false` to preserve leading zeros in dates/PMIDs, plus a manual entity decoder
  (`decodeEntities`) for numeric character references (`&#xed;`) that the parser's `htmlEntities`
  option doesn't cover — PubMed XML is full of these in author names and abstracts. `isArray`
  (`ARRAY_TAGS`) forces the repeatable elements to always be arrays so no call site branches on
  single-vs-array. Beyond the basics it extracts DOI, publication types, MeSH terms, keywords and
  publication status — all of which already came in the same response. `journalTerm`/`topicTerm`/
  `parseArticles` are pure and unit-tested separately from the HTTP client.

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
  user edits to change what counts as relevant. It also owns **`sources`** (followed journals and
  standing queries) and an optional `threshold` override: coverage is the reader's decision, and
  when several profiles exist each one has to carry its own. `src/config.ts` keeps only operator
  knobs (model, batch sizes, caps, excluded publication types, pricing).

- **`src/filter.ts`** — pre-scoring filters, so what they remove is both digest noise and money
  not spent: `excludeByPublicationType` (errata, comments, retractions, editorials) and
  `dedupeByDoi`, which collapses the ahead-of-print and final versions of the same paper. The
  seen-ledger cannot catch that pair because each version has its own PMID.

- **`src/metrics.ts`** — `RunMetrics` counts what a run did (sources ok/failed/truncated, found,
  deduped, dropped, scored, delivered) and accumulates the token `usage` the Anthropic responses
  return, turning it into an estimated cost. It is emitted three ways: the structured log, the
  GitHub Actions job summary, and a one-line footer on the digest itself.

- **`src/env.ts`** — the only source of secrets, zod-validated at startup. `.env` is loaded with
  Node's native `process.loadEnvFile`, not dotenv, whose v17 banner writes to stdout and would
  corrupt the digest printed there. Only `ANTHROPIC_API_KEY` is required — scoring runs even under
  `--dry-run`; Telegram credentials are checked lazily in `makeDeliverer`, so a dry run works with
  nothing else set. Optional secrets go through `optionalNonEmpty()`, which maps `""` to `undefined`
  **before** validation: GitHub Actions expands an unconfigured `${{ secrets.X }}` to an empty
  string rather than omitting the variable, and a bare `.optional()` rejects that as invalid
  instead of treating it as absent. That was a real production break — see `tests/env.test.ts`.

- **The feedback loop** — `src/feedback.ts` owns the `v:<pmid>:<0|1>` callback format and the
  keyboards. It is imported by *both* `src/digest.ts` (which builds the buttons) and
  `worker/worker.ts` (which parses the presses), which is the only thing stopping the two sides
  from drifting apart; it therefore must stay free of Workers-runtime types so it compiles under
  both tsconfigs. The Worker stores one KV entry per `(chat, paper)` so a re-vote overwrites, and
  exposes them at `GET /votes` behind a bearer token. `src/votes.ts` reads that endpoint, joins
  votes to the ledger (votes carry only a PMID — the title and score come from `state.json`), and
  produces both the **dynamic exemplars** fed to `buildSystemPrompt` and the **eval metrics**.
  Votes are always enrichment, never a dependency: if the Worker is down the digest still runs.

- **`src/state.ts`** / **`src/deliver.ts`** — both define a narrow interface
  (`SeenStore`, `Deliverer`) with the real implementation used at runtime
  (`JsonFileStore`/`TelegramDeliverer`) and a throwaway one used for `--dry-run` or tests
  (`MemoryStore`/`ConsoleDeliverer`). Swap the concrete class in `index.ts` if a different backend
  is ever needed — nothing else in the pipeline should need to change.

  A digest is a **sequence** of messages (`Deliverer.send(OutMessage[])`), not one blob: Telegram
  anchors an inline keyboard to a single message, so per-paper voting requires per-paper messages.
  `TelegramDeliverer` paces them (~1 msg/s per chat is Telegram's sustained limit), puts a
  message's keyboard on its last chunk, and splits at Telegram's 4096-char limit on newline
  boundaries, which also guarantees no chunk ends inside an HTML tag.

  The ledger is **v2**: `{pmid: {firstSeen, title, relevance?, delivered}}`. The bare-PMID v1
  format is migrated on load (inheriting the file's `updatedAt` so pruning sees the true age).
  The extra metadata is not decoration — a vote carries only a PMID, so without the stored title
  neither eval nor the dynamic exemplars could name the paper.

- **`src/pipeline.ts`** orchestrates: `digest` de-dupes PMIDs across all sources *and* against
  `state.json` before scoring anything (so a paper matching two sources, or already seen, is never
  billed twice); `search` does neither. `config.markSeenMode` controls whether state records only
  delivered papers or every paper considered — "considered" is the default so below-threshold
  papers aren't re-fetched and re-scored (and re-billed) on the next run.

  Two behaviours here are load-bearing and have tests that name them: **if every source fails the
  run throws** (it used to log and exit 0, which is indistinguishable from a quiet week), and
  **the digest is always delivered, even when empty**, so silence on a Monday can only mean
  something is broken.

- **Ranking** happens in two passes. `scorer.score()` grades papers in batches, then
  `scorer.rerank()` re-scores the top `config.rerankTopK` together in a single call: an absolute
  0-10 score drifts between batches, and comparing the finalists head-to-head fixes the ordering
  for the price of one extra call. `selectForDigest` then applies the threshold with a cap
  (`maxDelivered`) and a floor (`minDelivered`, topping up with near misses from at most 2 points
  below the threshold) so no week is either a wall of text or empty.

- **`src/cache.ts`** + **`src/recipients.ts`** support cheap test iteration. `index.ts` has three
  paths: normal (fetch+score), `--from-cache` (replay stored scores; no network), and `--rescore`
  (reuse stored papers, re-score). The two replay paths never write `state.json`. `MultiDeliverer`
  (in `deliver.ts`) fans delivery out to the recipients `--to` selects, attempting all and
  aggregating failures so one bad chat id doesn't block the others.

### Conventions

- **ESM + NodeNext.** Every relative import carries the `.js` extension (`./util.js`) even though
  the sources are `.ts`. New imports must follow this or the build breaks.
- **stdout is the digest; stderr is the logs.** `logger` writes JSON lines to stderr *only*, so
  `--dry-run` output stays pipeable. Never `console.log` from library code.
- **Validate at every external boundary with zod** (v4): env, `profile.yaml`, cache files,
  `state.json`, the esearch JSON and the model's tool output all get parsed, never trusted.
  Malformed *user* input (profile, env, cache) throws with a formatted issue list; malformed
  *state* degrades to empty with a warning rather than killing the run.
- **User-facing strings are Spanish** (digest text, score reasons, CLI help, the scoring prompt);
  code, identifiers and comments are English.
- **Dependencies are pinned exactly** (no `^`) in `package.json`; Dependabot proposes the bumps.
  `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`. pnpm settings, including
  the `overrides` that keep dev-only advisories at zero, live in `pnpm-workspace.yaml` — pnpm 10+
  no longer reads them from the `pnpm` key in `package.json`.
- **Cost is a design constraint.** De-duplicate and prefilter before scoring, cap with
  `maxAbstractsPerRun`/`--limit`, and prefer `--from-cache` when iterating on rendering or
  delivery. Every run reports what it spent, so tuning uses real numbers. Prompt caching is not
  viable here (`claude-haiku-4-5` needs a ≥4096-token cacheable prefix and the system prompt is far
  below it), so a `cache_control` marker would silently no-op — see the note in `buildSystemPrompt`.
- **Failures must be loud.** Anything that can make the digest silently produce nothing is a bug,
  not a quiet week. If you add an early return to the pipeline, make sure something still gets
  delivered or the run fails.

### Testing

Tests are fully offline and must stay that way — no live network in any test. PubMed XML fixtures
live in `tests/fixtures/`; Anthropic calls are mocked at the `CreateMessage` function level (see
`AnthropicScorer`'s constructor, which takes an injected message-creation function rather than
instantiating the SDK client itself) — this is the seam that makes `scoring.test.ts` able to script
multi-call sequences (e.g. asserting the reconcile-on-missing-PMID retry actually fires) without
any network access.

Every other seam follows the same pattern: `PubMedClient` and `TelegramDeliverer` take a
`fetchImpl` (and the client also takes `backoffMsImpl`, so the retry tests don't wait real
seconds), `runDigestPipeline` takes its whole dependency set, and file-backed stores take their
path so `state.test.ts`/`cache.test.ts` work in a `mkdtemp` directory. `tests/helpers.ts` builds
`Paper`/`ScoredPaper`/`Profile` fixtures, so adding a field to those shapes doesn't mean editing
every test. `vitest.config.ts` only picks up `tests/**/*.test.ts`; `tsconfig.json` type-checks
`src` and `tests` together.

### CI

`.github/workflows/digest.yml` runs `digest` on a weekly cron. The seen-PMIDs ledger is restored
from and persisted to an orphan single-file `state` branch via git plumbing (`hash-object` /
`mktree` / `commit-tree`) — it can never live on `main`, whose branch protection rejects the bot's
direct pushes. Secrets (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`NCBI_API_KEY`, `EUTILS_EMAIL`) are GitHub Actions repo secrets.

On failure the Telegram alert carries **the tail of the run log**, not just the run URL — a bare
URL once cost days of guessing at a broken digest. The run's stdout/stderr is teed to
`/tmp/digest.log` and the last 600 bytes are sent; `src/logger.ts` never prints secrets.

`.github/workflows/canary.yml` runs the same code path on Saturdays with `--dry-run --limit 3`:
real APIs and real secrets, no delivery and no state write. A break introduced during the week
surfaces two days before the digest that would otherwise have been lost.

`ci.yml` runs typecheck + tests on every PR and push to main. Note it is fully offline, so it
cannot catch a runtime failure that only appears with real credentials — that's the canary's job.
