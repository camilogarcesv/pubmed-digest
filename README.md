# pubmed-digest

Pulls newly-published PubMed papers for a set of followed journals (and optional standing
topics), scores each one against a personal **interest profile** with the Anthropic API, keeps
only the top matches, and delivers a short digest — one line per paper, with a Spanish reason —
to Telegram. It also does ad-hoc topic searches ranked the same way.

Small, typed proof of concept. State is a local JSON file; delivery and storage sit behind thin
interfaces so they can be swapped later.

---

## How it works

- **`digest`** — for every configured journal/topic, fetch records **newly added to PubMed** in
  the last N days (`datetype=edat`), de-duplicate PMIDs across sources, skip anything already in
  `state.json`, score the rest against `profile.yaml`, keep papers scoring `>= threshold`, render
  a ranked digest, deliver via Telegram, and record what was handled.
- **`search "<topic>"`** — fetch recent records for an ad-hoc query and score them with the
  **topic as the primary criterion** (the profile is only a tiebreaker), then show the top-N
  ranked results. No dedupe, no state.
- Both support **`--dry-run`** (fetch + score + print, no delivery, no state write) and
  **`--limit N`** (cap papers scored — cheap testing).

Scoring uses a **forced tool call** (`submit_scores`) on `claude-haiku-4-5`. The tool output is
validated with zod and reconciled against the batch that was sent (omitted PMIDs are re-scored;
hallucinated PMIDs are dropped), so a paper is never silently lost.

---

## Setup

Requires Node.js LTS >= 22.13 (required by pnpm 11) and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env      # then fill in the values (see Tokens below)
```

Edit `profile.yaml` (the main tuning knob) and, if you like, `src/config.ts` (journals, topics,
threshold, lookback, caps).

**Always run a dry run first** — it hits PubMed and Anthropic for real but delivers nothing:

```bash
pnpm dev:digest -- --dry-run --limit 5
pnpm dev:search "glioma MRI" -- --dry-run --limit 5
```

When the ranking looks right, drop `--dry-run` to deliver to Telegram (and, for `digest`, seed
the state ledger).

```bash
pnpm typecheck   # tsc --noEmit
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
| `NCBI_API_KEY` | optional | [NCBI account](https://www.ncbi.nlm.nih.gov/account/) → Settings → API Key Management. Raises the rate limit from 3 to 10 requests/second. |

---

## Editing the interest profile

`profile.yaml` **is** the definition of relevance. Fields:

- `description` — free text describing the reader's focus.
- `topics`, `must_have`, `nice_to_have`, `exclude` — lists that shape scoring.
- `exemplar_papers` — a few titles/PMIDs the reader loved (used as style references).

It's seeded with a neuroradiology-leaning example. Rewrite it for the actual reader — that's where
the quality comes from. It's validated at startup, so a malformed file fails fast with a clear error.

---

## The GitHub Action

`.github/workflows/digest.yml` runs `digest` on a weekly cron (Mondays 12:00 UTC;
`workflow_dispatch` lets you trigger it manually). Add the same variables above as **repository
secrets** (Settings → Secrets and variables → Actions).

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

## State & dedupe

`state.json` is the set of PMIDs the digest has already handled. Locally it's a gitignored file at
the repo root; in CI it is restored from and persisted to the orphan `state` branch (see above).
By default (`config.markSeenMode: "considered"`) it records **every paper evaluated in a run**, not
only the delivered ones — so papers that scored below threshold aren't re-fetched and **re-billed**
every week. Set it to `"delivered"` for strict "only what was sent" semantics. `search` never
touches state.

---

## Cost note

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
  config.ts    profile.ts   env.ts     types.ts   logger.ts   util.ts
  pubmed.ts    scoring.ts    state.ts   deliver.ts digest.ts   index.ts
tests/         fixtures + unit tests (offline)
profile.yaml   interest profile (edit me)
```
