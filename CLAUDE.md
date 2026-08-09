# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Early-stage skeleton, not the finished product. `backend/index.js` is a bare Express app
(health-check route only, no DB/auth/Gmail wiring yet). `frontend/` is the untouched Astro
minimal starter template. Almost none of the product described below is implemented — treat
`SPEC.md` as the target architecture, not current behavior.

`SPEC.md` at the repo root is the full product spec: scope decisions, stack choices with
rationale and alternatives considered, DB schema, compliance notes, and workflow conventions.
Read it before making any architecture-level decision — it exists specifically so choices don't
get re-litigated or re-derived from scratch each session.

## What this product does

Connects to a client's Gmail, finds invoices in email (PDF attachments in v1), extracts
vendor/amount/currency/date, categorizes them, dedupes, and shows a spend dashboard grouped by
category/month. Five-stage pipeline: auth & connection → fetch/scan → extraction & parsing →
categorization & dedup → dashboard & export. Target customer: freelancer/small
business/agency with 10-50 SaaS subscriptions and no dedicated accounting department.

## Commands

### Backend (`backend/`)
- Install: `npm install`
- Run: `node index.js` (no dev/watch script defined yet; listens on `PORT` env var, default 3001)
- Requires `backend/.env` (gitignored, loaded via `dotenv`)
- No test suite yet — `npm test` is a placeholder stub that exits 1

### Frontend (`frontend/`)
- Install: `npm install`
- Dev server: `npm run dev` (localhost:4321). Per `frontend/CLAUDE.md` (symlinked from
  `AGENTS.md`), prefer `astro dev --background` in this harness, managed with
  `astro dev stop` / `astro dev status` / `astro dev logs`
- Build: `npm run build`; preview a build: `npm run preview`
- Astro CLI passthrough: `npm run astro -- <args>` (e.g. `astro check`)

## Architecture (target, per SPEC.md §3)

Two independent apps talking over REST — no monorepo tooling, no shared package. The backend is
a long-running Node/Express process by design, not serverless: recurring jobs (email scanning,
forwarding invoices to the accountant) need a process that stays alive, which ruled out
Next.js-style API routes.

Stack choices (see SPEC.md for full alternatives-considered writeups):
- **Auth:** Supabase Auth (Google Sign-In). Login OAuth is a *separate* consent from the
  Gmail-read OAuth (`gmail.readonly`) — the latter needs Google's sensitive-scope verification
  (2-4 weeks in production), so start that early regardless of implementation progress.
- **DB:** Postgres via Supabase — relational by nature (users → email_connections → invoices,
  with SUM/GROUP BY for the dashboard), with RLS enforced in Postgres instead of hand-rolled
  per-endpoint authorization.
- **Storage:** Supabase Storage for PDFs; the DB only ever holds a `storage_path` pointer, never
  the file itself.
- **Scheduler:** plain cron (node-cron / pg_cron) for MVP. Don't reach for BullMQ+Redis until a
  concrete symptom shows up (overlapping jobs, need for retry, dynamic triggering, job
  monitoring) — it's not a fixed user-count threshold.
- **AI extraction/categorization:** Claude API, Haiku 4.5, structured outputs, called directly
  (no agent framework — this is single-step repetitive extraction, not multi-step reasoning).
  Batch API for overnight scans.
- **Gmail integration:** direct Gmail API with our own OAuth, not an aggregator
  (Nylas/Unipile/EmailEngine) — those become worth it past ~20 connected accounts or if
  multi-provider (Outlook) support is needed. Uses Gmail Search API queries
  (`has:attachment invoice OR receipt`, known senders) rather than scanning the whole inbox.
- **Frontend:** Astro/React. Explicit design goal: avoid generic "AI slop" visual identity.

### Data model (logical, see SPEC.md §4 for full schema)
```
users → email_connections → invoices
                           → forward_jobs
```
Fields chosen deliberately around known edge cases:
- `invoices.currency` stays separate per row — never sum different currencies into one total
- `invoices.status`: `confirmed | needs_review` — human-in-the-loop slot, unused in v1 but reserved
- `invoices.dedup_hash`: hash of vendor+period (not `message_id`), so incremental scans don't
  create duplicate invoices when the same email gets reprocessed

## MVP scope (SPEC.md §2)

In v1: Gmail only, PDF attachments only (no HTML body parsing), single user per account,
deterministic vendor matching with AI fallback for categorization, dedup on vendor+period,
multi-currency at display level only (no conversion — never mix currencies in a sum).

Deliberately deferred, not oversights — don't build toward these unless asked: Outlook/IMAP,
refund/credit note handling, multi-user/team accounts, automatic forwarding to the accountant.

Open questions still unresolved (flag rather than silently assume an answer): handling invoices
that are only a portal link (no attachment/body content), how much to lean on AI vs.
deterministic matching for unfamiliar vendors, detecting a revoked OAuth token proactively.

## Compliance

Financial email content is more sensitive than typical form data — handle accordingly from the
start: RLS on all tables, encrypted OAuth tokens at rest, and account deletion must be a single
flow that removes data from both the DB and Storage together (not two flows that can drift out
of sync). Full detail in SPEC.md §5.

## Working conventions (SPEC.md §7)

- Work in vertical slices per session — auth, fetch/filter, extraction/categorization,
  dashboard, forwarding are separate slices. Use `/clear` between unrelated slices rather than
  mixing context across modules.
- Validate the parser against a fixed test set of anonymized real invoices (different formats)
  after every change to extraction logic. This test set doesn't exist in the repo yet —
  establish it under `backend/` when extraction work begins.
