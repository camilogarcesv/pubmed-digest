# PubMed Digest

PubMed Digest finds recent biomedical articles, ranks them against an interest profile, and sends a concise Telegram digest in Spanish. Each delivered article can receive 👍 or 👎 feedback.

## Local use

Requirements: Node.js 22.13+ and pnpm 11.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev:digest -- --dry-run --limit 5
```

Use `--dry-run` while configuring the profile: it fetches and ranks articles but does not send messages or update local state. Run `pnpm test` and `pnpm typecheck` before contributing changes.

## Configuration

Edit `profile.yaml` to define the topics and sources to follow. Keep credentials in `.env` locally and in the deployment environment for scheduled runs; never commit them.

## Multi-user backend

`pnpm dev:digest -- --backend d1 --dry-run --user <slug>` previews one user's digest from the Worker's internal API: profile, history and votes come from D1 instead of `profile.yaml` and the local ledger. It needs `DIGEST_SERVICE_SECRET`. Without `--dry-run`, the D1 path creates runs and delivers through the Worker, which accepts writes only when D1 is the operating mode. `pnpm eval -- --user <slug>` evaluates that user's votes from D1. The default remains the file-based digest.

## Feedback

Votes are optional. They help evaluate and improve ranking over time. The evaluation remains inconclusive until it has at least 15 scored votes from both positive and negative feedback.

## Contributing

Keep changes small, validate external inputs, and add focused tests for behavior changes. The repository contains the code and public usage guidance; operational notes, environment details, delivery history, and future implementation work belong in local, ignored files.
