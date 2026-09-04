# pubmed-digest

Pulls newly-published PubMed papers for a set of followed journals (and optional standing
topics), scores each one against a personal **interest profile** with the Anthropic API, keeps
only the top matches, and delivers a short digest — one line per paper, with a Spanish reason —
to Telegram. It also does ad-hoc topic searches ranked the same way.

Small, typed proof of concept. State is a local JSON file; delivery and storage sit behind thin
interfaces so they can be swapped later.

---

## How it works

- **`digest`** — for every journal and standing query in `profile.yaml`, fetch records **newly
  added to PubMed** in the last N days (`datetype=edat`), de-duplicate PMIDs across sources, skip
  anything already in `state.json`, drop editorial noise and duplicate DOIs, score the rest
  against the profile, re-rank the finalists, select what to send, deliver via Telegram, and
  record what was handled.
- **`search "<topic>"`** — fetch recent records for an ad-hoc query and score them with the
  **topic as the primary criterion** (the profile is only a tiebreaker), then show the top-N
  ranked results. No dedupe, no state.
- Both support **`--dry-run`** (fetch + score + print, no delivery, no state write) and
  **`--limit N`** (cap papers scored — cheap testing).

Scoring uses a **forced tool call** (`submit_scores`) on `claude-haiku-4-5`. The tool output is
validated with zod and reconciled against the batch that was sent (omitted PMIDs are re-scored;
hallucinated PMIDs are dropped). A valid score of `0` is preserved, but an API failure, malformed
response or PMID still missing after reconciliation aborts the run before delivery or state write.

**Two passes, not one.** After the batch scoring, the best `rerankTopK` papers are re-scored
together in a single call. An absolute 0–10 score drifts between batches; comparing the finalists
against each other fixes the ordering for the price of one extra call.

**No week is empty or overwhelming.** Selection applies the threshold with a cap (`maxDelivered`)
and a floor (`minDelivered`): on a quiet week the digest tops up with near misses, clearly labeled
as below the bar.

**Every message carries its own receipt** — a footer with how many papers were new, scored and
delivered, and what the run cost. Silence on a Monday therefore means something is broken, never
"nothing was relevant".

**The digest learns from 👍/👎.** Each paper arrives as its own Telegram message with a vote
keyboard. A Cloudflare Worker records the presses; the next digest feeds the recent likes and
dislikes back into the scoring prompt, and `pnpm eval` measures whether the ranking actually
agrees with the reader. See [Vote feedback](#vote-feedback-and-pnpm-eval).

---

## Setup

Requires Node.js LTS >= 22.13 (required by pnpm 11) and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env      # then fill in the values (see Tokens below)
```

Edit `profile.yaml` — it holds both **what counts as relevant** and **what gets searched**
(followed journals + standing queries). `src/config.ts` keeps only operator knobs (model, batch
sizes, caps, excluded publication types, pricing).

**Always run a dry run first** — it hits PubMed and Anthropic for real but delivers nothing:

```bash
pnpm dev:digest -- --dry-run --limit 5
pnpm dev:search "glioma MRI" -- --dry-run --limit 5
```

When the ranking looks right, drop `--dry-run` to deliver to Telegram (and, for `digest`, seed
the state ledger).

```bash
pnpm typecheck   # tsc --noEmit
pnpm typecheck:worker
pnpm check:worker-types
pnpm test        # vitest (offline; no live network)
```

---

## Cheap test iteration (cache & recipients)

Scoring costs money, so when you're only tweaking delivery or rendering, **cache one run and
replay it for free**:

```bash
# Build the cache once (pays Anthropic once): real fetch + score, no delivery, no state
pnpm dev:digest -- --limit 5 --dry-run --save-cache

# Replay it as many times as you want — no PubMed, no Anthropic, no state:
pnpm dev:digest -- --from-cache --to me          # deliver only to you
pnpm dev:digest -- --from-cache --to me,amigo     # deliver to you + a friend
pnpm dev:digest -- --from-cache --dry-run         # print only (nobody)

# Tuning profile.yaml later? Re-score the SAME papers (skips PubMed, pays Anthropic):
pnpm dev:digest -- --rescore --dry-run --save-cache
```

**Recipients.** `TELEGRAM_CHAT_ID` is always recipient `me`. Add more in `TELEGRAM_RECIPIENTS`
(`me:111,amigo:222`) and pick them with `--to`. Without `--to`, **only `me` receives** — a friend
is messaged only when you name them (`--to me,amigo` or `--to all`). `--dry-run` delivers to nobody.
If one recipient's chat id is wrong, the rest still receive the digest and the failure is reported.

The cache lives in `.cache/` (gitignored). `search` takes the same flags (`.cache/search.json`).

---

## Tokens

All secrets come from the environment (`.env` locally; repository secrets in CI). Never commit `.env`.

| Variable | Required | How to get it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes (also for `--dry-run`, since scoring always runs) | [Anthropic Console](https://console.anthropic.com/) → API Keys. |
| `TELEGRAM_BOT_TOKEN` | for real delivery only | In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts; it returns a token. |
| `TELEGRAM_CHAT_ID` | for real delivery only | Send your bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[].message.chat.id`. (Or message [@userinfobot](https://t.me/userinfobot) for your own id.) Becomes recipient `me`. |
| `TELEGRAM_RECIPIENTS` | optional | Extra named recipients for `--to`, e.g. `me:111,amigo:222`. Adds to / overrides `TELEGRAM_CHAT_ID`. |
| `EUTILS_EMAIL` | recommended | Your email. NCBI etiquette: every request should identify itself. |
| `VOTES_URL` | optional | Your Cloudflare Worker's `/votes` endpoint. Enables dynamic exemplars and `pnpm eval` without `--votes`. |
| `VOTES_READ_SECRET` | optional | Bearer token guarding that endpoint; must match the Worker's secret. |
| `NCBI_API_KEY` | optional | [NCBI account](https://www.ncbi.nlm.nih.gov/account/) → Settings → API Key Management. Raises the rate limit from 3 to 10 requests/second. |

---

## Editing the interest profile

`profile.yaml` **is** the definition of relevance, and it also defines coverage. Fields:

- `description` — free text describing the reader's focus.
- `topics`, `must_have`, `nice_to_have`, `exclude` — lists that shape scoring.
- `exemplar_papers` — a few titles/PMIDs the reader loved (used as style references).
- `sources.journals` — journals followed, by PubMed ISO abbreviation (`AJNR Am J Neuroradiol`).
- `sources.queries` — standing PubMed queries run every week. **These are what catch the excellent
  paper published outside the followed journals** (Lancet Neurology, NEJM, JAMA…). A plain phrase
  becomes `("word"[tiab] AND …)`; anything containing a field tag or AND/OR/NOT passes through.
- `threshold` — optional per-profile override of `config.threshold`.

It's seeded with a neuroradiology-leaning example. Rewrite it for the actual reader — that's where
the quality comes from. It's validated at startup, so a malformed file fails fast with a clear error.

> Widening `sources` widens cost roughly proportionally: each source adds papers to score.
> `maxAbstractsPerRun` is the hard ceiling, and the run footer tells you what each week actually
> cost, so you can tune with real numbers instead of guessing.

---

## The GitHub Action

`.github/workflows/digest.yml` runs `digest` on a weekly cron (Mondays 12:00 UTC;
`workflow_dispatch` lets you trigger it manually). Add the same variables above as **repository
secrets** (Settings → Secrets and variables → Actions).

**Two guardrails, learned the hard way.** A failure alert now includes the tail of the run log,
not just the run URL — a bare URL is not enough to know what broke. And
`.github/workflows/canary.yml` runs the same code path every **Saturday** with
`--dry-run --limit 3`: real APIs and real secrets, no delivery, no state written. CI is fully
offline, so it cannot catch a break that only appears with live credentials; the canary can, two
days before the digest that would otherwise be lost. Each run also writes a metrics table to the
Actions **job summary**.

**State persistence: an orphan `state` branch.** After each run the workflow commits the updated
`state.json` to a dedicated single-file `state` branch (à la `gh-pages`) using git plumbing —
never to `main`.

> **Trade-off.** A git branch is durable and auditable — the dedupe ledger can't be silently
> evicted (the Actions-cache alternative can be, after ~7 days without use, which would risk
> re-sending old papers). The ledger can't live on `main`: branch protection rejects the bot's
> direct pushes there, and keeping it off `main` also keeps code history clean and doesn't
> invalidate open PRs' "up to date" status every week. Bonus: the weekly commit keeps the repo
> active, so GitHub won't disable the scheduled workflow after ~60 days of inactivity (commits to
> any branch count). If the run fails, a Telegram notification is sent with the run URL.

Because the Action uses `pnpm install --frozen-lockfile`, **commit `pnpm-lock.yaml`** (generated by
`pnpm install`).

---

## Vote feedback and `pnpm eval`

Each paper is delivered as its own Telegram message with a 👍/👎 keyboard. Telegram discards
unread button presses after ~24h, so a small **Cloudflare Worker** (`worker/`) sits on a webhook,
acknowledges the press instantly and stores the vote in Workers KV. Everything below is optional:
without `VOTES_URL` the digest behaves exactly as it did before.

The votes do two things:

- **They tune the next digest automatically.** The most recent likes and dislikes are injected
  into the scoring prompt as few-shot exemplars — what the reader *actually* voted for beats what
  the profile *says* they want. Titles come from the ledger, so this costs no extra requests.
- **They make tuning measurable.** `pnpm eval` always reports descriptive averages and
  **disagreements**. It reports `precision@k` only after at least 15 unique joined votes include
  examples of both 👍 and 👎; before that its status is explicitly `insufficient_data`.

```bash
pnpm eval                          # votes from the Worker, scores from the ledger + cache
pnpm eval -- --votes dump.json     # offline, from a saved {"votes":[...]} dump
pnpm eval -- --rescore             # re-score the voted papers with the CURRENT profile and
                                   # compare metrics before/after — the tuning loop
```

### Deploying the Worker (one time, free tier)

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create VOTES     # paste the printed id into wrangler.jsonc
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any long random string
npx wrangler secret put VOTES_READ_SECRET         # another long random string
npx wrangler deploy                        # prints your Worker URL
```

From the repository root, regenerate bindings with `pnpm types:worker` whenever
`worker/wrangler.jsonc` changes. CI runs `pnpm check:worker-types`, the Worker typecheck and its
offline request tests. Workers Logs are enabled with structured events and full log sampling;
query strings are redacted. Traces remain disabled because Telegram's Bot API includes the bot
token in the request path.

The URL is `https://<worker-name>.<your-account-subdomain>.workers.dev` — **both** labels, which
is easy to mistype from memory. Copy the one `deploy` prints. The account subdomain is set once
per account and can only be changed from the Cloudflare dashboard (Workers & Pages → *Change*
next to *Your subdomain*); `wrangler` has no command for it.

Then point Telegram at it (the `secret_token` must equal `TELEGRAM_WEBHOOK_SECRET` — it is how
the Worker knows a request really came from Telegram):

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Finally add `VOTES_URL` (`https://<your-worker>.workers.dev/votes`) and `VOTES_READ_SECRET` to
your `.env` and to the repository secrets.

> **Why a Worker and not a poller?** A scheduled job reading `getUpdates` would leave the button
> spinning until the next poll and would silently lose any vote older than 24h. The Worker also
> becomes the first piece of the multi-user backend rather than throwaway scaffolding.

---

## State & dedupe

`state.json` is the ledger of papers the digest has already handled. Locally it's a gitignored file
at the repo root; in CI it is restored from and persisted to the orphan `state` branch (see above).
Each entry keeps the title, the score and whether it was delivered — votes only carry a PMID, so
the ledger is what lets `pnpm eval` and the dynamic exemplars resolve one to a paper without
re-fetching PubMed. Entries older than `config.statePruneDays` (180) are dropped on save; the
`edat` window is 8 days, so nothing that old can reappear. A v1 ledger (a bare PMID list) is
migrated automatically on first load.

By default (`config.markSeenMode: "considered"`) it records **every paper evaluated in a run**, not
only the delivered ones — so papers that scored below threshold aren't re-fetched and **re-billed**
every week. Set it to `"delivered"` for strict "only what was sent" semantics. `search` never
touches state.

### Repairing contaminated zero scores

The repair command is read-only by default. Its initial default window is the UTC day
`2026-08-31` (`--from` inclusive, `--to` exclusive), and it selects only entries with an explicit
`relevance: 0` and `delivered: false`:

```bash
pnpm state:repair -- --input state.json
pnpm state:repair -- --input state.json --from 2026-08-31 --to 2026-09-01
```

Review the sorted PMID report first. Applying is a separate explicit action:

```bash
pnpm state:repair -- --input state.json --from 2026-08-31 --to 2026-09-01 --apply
```

Before replacing the local file atomically, apply mode writes an exact `.bak` and a JSON report to
`.cache/state-repair/`. The tool never checks out, commits or pushes the `state` branch. Updating
that branch remains a separate operator action after verifying the backup and report.

---

## Cost note

Create a dedicated [Anthropic Workspace](https://platform.claude.com/docs/en/manage-claude/workspaces)
for this pilot, set its monthly spend limit to **USD 5** in the Anthropic Console, and use an API
key created inside that workspace. The default workspace does not provide the same isolation. The
application intentionally keeps `maxAbstractsPerRun` and its
per-run token/cost report instead of adding a second monthly accounting system. When Anthropic
reports that the workspace spend limit was reached, scoring raises `budget_exceeded` immediately
and does not retry.

`claude-haiku-4-5` is **$1.00 / $5.00 per 1M input/output tokens**. A scoring call of ~18 abstracts
is on the order of a couple of cents; a weekly digest across the configured journals is typically a
few cents per run. `maxAbstractsPerRun` and `--limit` are hard guardrails on how much any run can
spend. The Batch API (−50%) is a future option if volume grows; prompt caching is **not** —
`claude-haiku-4-5` requires a ≥ 4096-token cacheable prefix and the scoring prompt is far below
that, so a `cache_control` marker would silently no-op.

---

## Project layout

```
src/
  index.ts     CLI wiring only (flags -> dependencies -> pipeline)
  pipeline.ts  orchestration: search -> fetch -> prefilter -> score -> re-rank -> deliver
  pubmed.ts    E-utilities client + XML parsing      scoring.ts  Anthropic forced tool call
  filter.ts    pre-scoring filters (type, DOI)       digest.ts   selection + HTML rendering
  metrics.ts   run counters, tokens, cost            deliver.ts  Telegram / console / fan-out
  state.ts     seen-PMIDs ledger                     recipients.ts  --to name resolution
  cache.ts     run snapshots for cheap replay        profile.ts  + config.ts, env.ts, types.ts,
  feedback.ts  vote callback format + keyboards      logger.ts, util.ts
  votes.ts     read votes, exemplars, eval metrics   eval.ts     the `pnpm eval` report
worker/        Cloudflare Worker: vote webhook + KV + /votes endpoint
tests/         fixtures + unit tests (offline)
profile.yaml   interest profile AND coverage (edit me)
```
