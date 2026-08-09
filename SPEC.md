# SPEC.md — Email Invoice Scanner & Spend Dashboard

Status: draft v1

---

## 1. What the product is

A service that connects to the client's Gmail account, automatically finds invoices in their
emails, categorizes them (AI tools, Hosting, Marketing, Ads, Infrastructure, Other), displays
them in a dashboard with a breakdown by category/month, and periodically sends a centralized
package of invoices to an email address specified by the client (e.g. accounting@gmail.com).

### 5-stage pipeline

1. **Auth & connection** — Google Sign-In (login) + separate OAuth for read-only Gmail access
2. **Fetch/email scanning** — historical scan (once, on connection) + incremental scan (recurring)
3. **Extraction & parsing** — vendor, amount, currency, date, invoice ID from PDF attachment or HTML body
4. **Categorization & deduplication** — category assignment + hash on vendor+period (not just message ID)
5. **Dashboard & export** — visualization + recurring job to forward invoices to the accountant

### Typical customer

Freelancer / small business / agency with 10-50 SaaS subscriptions who wants visibility into
recurring spend, without a sophisticated accounting department.

---

## 2. MVP Scope — what's in and what's out for v1

**In MVP (otherwise the product gives wrong results or misleads the user):**
- Distinguishing a real invoice from a newsletter/promo email
- Multi-currency at display level (we don't convert, but we never sum EUR with USD into a false total)
- Basic deduplication (hash on vendor + period)
- Single user per account, Gmail connected via OAuth
- Scanning the last X months, PDF attachments only (no HTML body parsing in v1)
- Simple categorization (deterministic matching on known vendors + AI fallback)
- Basic dashboard — list + sum per category

**Deliberately excluded from v1 (explicit decision, not an oversight):**
- Gmail only — no Outlook/IMAP (reason: most of the target audience is on Gmail)
- No refund/credit note handling — standard invoices only
- No multi-user/team per account
- No automatic forwarding to accountant in the first iteration (comes after the rest works)

**Open questions (flagged, not yet resolved):**
- What happens when a vendor sends the invoice only as a link to a portal (no attachment, not in body)?
- How much do we rely on AI classification vs. deterministic matching for lesser-known vendors?
- How do we detect that an OAuth token has been revoked, without the user finding out only when
  everything breaks?

---

## 3. Architecture

### 3.1 Auth
**Choice:** Supabase Auth (Google Sign-In for login)
**Why:** Same ecosystem as the database and storage → Row Level Security (RLS) enforced directly
in Postgres, instead of authorization logic written manually in the backend on every endpoint.
**Important:** Login auth (Google Sign-In) is SEPARATE from the Gmail access OAuth
(`gmail.readonly`) — two different consents; the second one requires Google verification
(2-4 weeks in production).
**Migration threshold:** if the Supabase Cloud bill exceeds ~$150-200/month OR a client requires
strict data sovereignty → migrate to self-hosted Supabase (same stack, self-hosted).
**Alternatives evaluated:** Clerk (good DX, but no bundled DB), Auth0/WorkOS (enterprise-SSO
oriented, not our case), Firebase Auth (NoSQL), Better Auth (open-source, self-managed).

### 3.2 Database
**Choice:** Postgres, consumed through Supabase (not self-hosted, not separate from auth)
**Why:** The data is relational by nature (users → email_connections → invoices → categories,
with a need for SUM/GROUP BY aggregations for the dashboard) → relational Postgres, not
document-based (Mongo). Consumed through Supabase for RLS + bundling with auth/storage.
**Migration:** same decision as Auth — if we migrate, it moves together (self-hosted Supabase),
since the stack is tied together via Docker Compose, a single package.
**Alternatives evaluated:** Neon (pure Postgres, copy-on-write branching, but no auth/storage —
would require separate bundling), PlanetScale, RDS.

### 3.3 Storage
**Choice:** Supabase Storage, for PDFs and larger files
**Why:** We don't put PDFs directly in the database (it would bloat it, making queries/backups
slower and more expensive) — the file is uploaded to storage, and the DB only holds a
link/pointer to its location. Direct integration with RLS (same permission rules as the DB).
**Migration threshold (INDEPENDENT of auth/DB):** if egress (frequent downloads) becomes
expensive → migrate ONLY storage to Cloudflare R2 (zero egress), without touching auth/DB —
easy since Supabase Storage is already S3-compatible.
**GDPR:** a PDF is just as much "personal data" as a database row — deleting a user must be a
single flow that removes data from both the database AND storage at once.

### 3.4 Backend / API
**Choice:** Node.js + Express, backend separate from the frontend, communicating via REST API
**Why:** We need recurring jobs (scan, forward to accountant) that don't fit well with the
serverless model of Next.js API routes (respond-to-request-then-stop). A separate backend can
stay running continuously and run these scheduled tasks itself. Consistent with the stack
already used on ClientIQ.
**Why not Fastify/NestJS:** at the MVP stage, development speed matters more than raw
throughput — the real bottleneck will be the Gmail API/Claude API, not the framework.

### 3.5 Scheduler / Worker (recurring jobs)
**Choice for MVP:** simple cron (node-cron, or pg_cron if staying on Supabase)
**Why:** low job volume, predictably scheduled (daily scan, monthly forward) — doesn't justify
a dedicated queue yet.
**Migration threshold to BullMQ + Redis:** when concrete symptoms appear — (a) jobs start
overlapping at high user volume, (b) need for automatic retry instead of waiting for the next
scheduled run, (c) jobs triggered dynamically (not just at fixed times), (d) need for
monitoring/visibility into job status. Not a fixed user-count threshold — a real symptom signal.
**Cost:** BullMQ is open-source/free; Redis can be self-hosted for free on the same VPS
(operational cost only, not financial) or paid if using a hosted option.
**Decision:** we do not build a custom queue system — persistence, locking, and idempotency
problems are already solved and battle-tested in BullMQ; reinventing them risks subtle bugs and
spends time that doesn't go into the product itself.

### 3.6 Extraction & Categorization (AI)
**Choice:** Claude API (Haiku 4.5) with structured outputs, direct call — no agent framework
**Why Haiku:** the task is simple, repetitive extraction (not complex multi-step reasoning) —
doesn't justify a more expensive model. Batch API for overnight scans → -50% additional cost
(no need for real-time responses).
**Why structured outputs:** guarantees (not just "usually") that the response matches our
schema — eliminates fragile free-text parsing and retry logic for malformed responses.
**Why not an agent framework (LangChain/CrewAI):** a single repetitive operation, not complex
multi-step decision-making.
**GDPR:** Anthropic provides a standard DPA — using the API is documented as a sub-processor,
not a compliance problem in itself.
**Migration threshold toward a local model (Ollama):** NOT about GDPR in general (both options
are compliant), but about a specific case — a client contractually requires that data never
leave their own infrastructure (no-cloud-data policy). Until then, the schema guarantee and
simplicity of the Claude API outweigh the cost savings.

### 3.7 Frontend
**Choice:** Astro / React
**Caution:** avoid the generic "AI slop" look — design with no visual identity, components that
look like any other AI-templated site. Define a proper visual language before implementation
(see frontend-design as a reference).

### 3.8 Gmail integration
**Choice for MVP:** Gmail API direct (own OAuth, no intermediary)
**Why:** only Gmail is supported in v1, no enterprise compliance requirements (SOC2 etc.), and
at current volume (under 10 test accounts) a unified service would be disproportionately costly.
**Filtering:** we don't scan the whole inbox — we use the Gmail Search API with queries
(`has:attachment invoice OR receipt`, or known senders) to reduce the volume processed.
**Important:** the OAuth verification process for sensitive scopes (`gmail.readonly`) in
production takes 2-4 weeks — worth starting early, regardless of implementation progress.
**Migration threshold (multi-provider version, e.g. Outlook):**
- Nylas/Unipile — cost per connected account, favorable under ~20 accounts, no infra maintenance
- EmailEngine — fixed annual cost (~€1200), self-hosted, favorable above ~20 accounts, but
  requires self-hosting and maintenance
- Final decision depends on the actual number of users at migration time

### 3.9 General hosting
**Status:** TBD — depends on the VPS to be provisioned. No need for a custom domain if an
existing subdomain is available. To be completed once final infrastructure is set up.

---

## 4. Database schema (logical level)

```
users
  └─ id, email, created_at

email_connections
  └─ id, user_id (FK), oauth_token (encrypted), scope, connected_at, last_scan_at

invoices
  └─ id, user_id (FK), vendor, amount, currency, invoice_date, category,
     status (confirmed | needs_review), source (attachment | body),
     storage_path (link to PDF in Supabase Storage), dedup_hash (vendor+period)

forward_jobs
  └─ id, user_id (FK), scheduled_at, recipient_email, invoice_ids[], status
```

Fields deliberately designed around known edge cases (without implementing the full logic yet):
- `currency` kept separate (never sum different currencies as if they were the same)
- `status: needs_review` (a slot for human-in-the-loop, even if unused in v1)
- `dedup_hash` (not just message_id — vendor+period prevents duplicates on incremental scans)

---

## 5. Compliance & GDPR

- **Role:** processor for the client's financial data (the client is the controller), but also
  controller for the user's own account data
- **Legal basis:** contract (the user explicitly requests the service) + OAuth consent (required
  by Google anyway when connecting Gmail)
- **Required DPAs:** Supabase, Anthropic (both offer standard DPAs to accept/sign)
- **Right to erasure:** a single flow that deletes from both the database AND storage
  simultaneously — not two separate processes that could fall out of sync
- **Retention policy:** to be explicitly defined (e.g. keep data for as long as the account is
  active + X months after deletion) — not implicitly "forever"
- **Sensitive data:** financial email content is more sensitive than an ordinary form — handled
  carefully from the start (RLS everywhere, encrypted OAuth tokens)

---

## 6. "Done" criterion for MVP (end-to-end test)

The user connects Gmail (OAuth), the system scans the last X months, finds at least one real
invoice with a PDF attachment, categorizes it correctly (deterministic matching or AI fallback),
the invoice appears in the dashboard with the correct vendor/amount/currency/date, and the PDF
is downloadable from storage.

---

## 7. Process notes (implementation workflow)

- Git init + empty initial commit from the very start, before any implementation
- Vertical slices per work session: (a) auth + Google Sign-In, (b) fetch + filter emails,
  (c) extraction/categorization, (d) dashboard, (e) automatic forwarding
- `/clear` between unrelated tasks, to avoid mixing context across different modules
- A test set of emails (anonymized real invoices, different formats) as a "test suite" for the
  parser, run after every change
- CLAUDE.md generated from the actual project structure, not written theoretically in advance
