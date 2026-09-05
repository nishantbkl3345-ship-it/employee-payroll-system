# Employee Timesheet & Payroll Calculator

A full-stack system that ingests bulk timesheet files, validates and prices every row
concurrently, computes payroll aggregates, and presents the result as a usable product
screen rather than a pile of JSON.

No external APIs. Deterministic output. Runs with **zero infrastructure setup**, and
scales up to Postgres + Redis + a dedicated worker when you want it to.

```
┌─────────────┐   upload    ┌──────────────┐   enqueue   ┌───────────────┐
│  React SPA  │ ──────────► │  Fastify API │ ──────────► │  Job queue    │
│  (Vite)     │ ◄────────── │  JWT + RBAC  │             │ memory/BullMQ │
└─────────────┘  WebSocket  └──────────────┘             └───────┬───────┘
        ▲          progress          │                           │
        │                            ▼                           ▼
        │                     ┌─────────────┐          ┌──────────────────┐
        └─────────────────────│  Postgres   │◄─────────│  Worker pool     │
              REST reads      │  (rollups)  │  writes  │  N-way concurrent│
                              └─────────────┘          └──────────────────┘
```

---

## 1. Setup

Requires **Node.js 20+**. Nothing else.

```bash
npm install
cp .env.example .env      # optional — every value has a sane default
npm run seed              # optional — demo org, users and two processed pay runs
npm run dev               # API on :4000, UI on :5173
```

Open <http://localhost:5173>.

The seed creates three accounts in the **Northwind Labs** organisation:

| Role | Email | Password | Sees |
|---|---|---|---|
| Admin | `admin@demo.io` | `password123` | everything, can upload and change rules |
| HR | `hr@demo.io` | `password123` | everything, can upload |
| Employee | `employee@demo.io` | `password123` | their own payslip only |

Or skip the seed and click **Create an organisation** — you become its admin.

Sample files live in [`samples/`](samples/):

- `timesheet_sample.csv` — the seven rows from the brief, including every defect class
- `timesheet_sample.json` — the same shape as JSON (both formats are accepted)
- `timesheet_two_weeks.csv` — ~600 rows over two ISO weeks, generated with ~4% defects

Generate a bigger one for load testing:

```bash
npm run -w server generate -- 10000    # writes samples/timesheet_10k.csv
```

### Other ways to run it

```bash
npm test                  # unit + integration tests (embedded Postgres, no services)
npm run build && npm start   # production build; the API also serves the built UI
docker compose up --build    # Postgres + Redis + API + dedicated worker → :4000
```

### Configuration

Everything is environment-driven ([`.env.example`](.env.example) documents each key). The
two that change the topology:

| Variable | Unset (default) | Set |
|---|---|---|
| `DATABASE_URL` | embedded Postgres (PGlite) in `.data/pg` | connects to a real Postgres server |
| `REDIS_URL` | in-process job queue | BullMQ queue + Redis pub/sub, worker can run separately |

Tuning knobs: `WORKER_CONCURRENCY` (default 8), `ROW_PROCESSING_DELAY_MS` (simulated
per-row cost, default 4), `ROW_MAX_ATTEMPTS`, `UPLOAD_RATE_LIMIT_PER_MIN`, `MAX_UPLOAD_MB`,
and the default overtime rules `OT_DAILY_THRESHOLD` / `OT_WEEKLY_THRESHOLD` / `OT_MULTIPLIER`.

---

## 2. Architecture

### Repository layout

```
server/src
  app.ts               Fastify app: CORS, multipart, rate limiting, error handling, SPA hosting
  index.ts / worker.ts API entrypoint / standalone queue worker
  auth/                bcrypt hashing, JWT issuing/verifying, role guards, tenant scoping
  db/                  driver abstraction (pg | PGlite) + SQL migrations
  jobs/                processor.ts (the pipeline) and queue.ts (memory | BullMQ)
  payroll/             parse → validate → compute → aggregate (pure, testable)
  lib/                 worker pool, event bus, event log, CSV writer, ids
  routes/              auth, jobs, employees, reports
  ws/                  WebSocket fan-out for live job progress
web/src
  pages/               Login, Signup, Dashboard, Upload, Jobs, JobDetail, Employees,
                       EmployeeDetail, MyPayslip, Settings
  components/          layout, UI primitives, charts
  lib/                 API client, auth context, formatters, live job stream
```

### The processing pipeline

`server/src/jobs/processor.ts` runs six stages and reports a single 0–100 progress number
that the UI renders as a bar plus a stage checklist.

| Stage | Unit of work | Concurrent? |
|---|---|---|
| `parsing` | whole file | — |
| `validating` | **one row** | ✅ worker pool |
| `resolving` | one `(employee, date)` group — duplicates, overlaps, daily split | ✅ worker pool |
| `overtime` | one `(employee, ISO week)` group — weekly threshold, gross pay | ✅ worker pool |
| `persisting` | batches of 250 rows | — |
| `aggregating` | SQL rollups + metrics document | — |

Measured on the 9,538-row sample with the default 4ms simulated per-row cost
(`npm run -w server generate -- 10000`, then upload):

| `WORKER_CONCURRENCY` | Validation phase | Throughput |
|---|---|---|
| 1 (sequential) | 47.1s | 202 rows/s |
| 4 | 11.6s | 821 rows/s |
| **8 (default)** | **5.8s** | **1,655 rows/s** |
| 16 | 2.8s | 3,371 rows/s |
| 32 | 1.4s | 6,925 rows/s |

End to end — upload, validate, resolve, price, persist and aggregate 9,538 rows
through the HTTP API — takes **6.3s**, with the progress bar updating throughout.

Splitting the work this way is what makes the concurrency both real and **deterministic**.
Field-level validation is genuinely per-row, so it fans out. But duplicate detection,
overlap detection and the overtime split are *set-based* — they depend on the other rows
for the same employee. Rather than sharing mutable state between workers (which makes the
result depend on completion order), rows are grouped first and each **group** becomes one
task. Groups are independent, so they run in parallel, and within a group rows are always
processed in `row_number` order. Re-running the same file always produces byte-identical
output.

### Validation rules

| Code | Meaning |
|---|---|
| `MISSING_FIELD` | one of the seven required fields is blank |
| `INVALID_DATE` | not a real calendar date (`2025-02-30` is rejected) |
| `FUTURE_DATE` | dated after today |
| `INVALID_TIME` | unparseable `clock_in` / `clock_out` |
| `CLOCK_OUT_NOT_AFTER_CLOCK_IN` | zero-length or reversed shift |
| `INVALID_RATE` / `NON_POSITIVE_RATE` | not a number, or ≤ 0 |
| `DUPLICATE_ROW` | same `employee + date + clock_in` as an earlier row |
| `OVERLAPPING_SHIFT` | overlaps an already-accepted shift that day |
| `IMPLAUSIBLE_SHIFT_LENGTH` | optional guard, off unless `maxShiftHours` is supplied |
| `PROCESSING_ERROR` | the row failed every retry — surfaced, never silently dropped |

A row is `duplicate`, `invalid`, or `valid`. Only `valid` rows contribute to payroll;
everything else is kept, annotated and downloadable. **A bad row never fails the job.**

### Payroll math

```
hours_worked   = clock_out − clock_in                       (hours, 2dp)
regular/overtime:
  1. daily rule  — hours past dailyThreshold in one day are overtime,
                   filled across the day's shifts in clock-in order
  2. weekly rule — if weekly regular hours exceed weeklyThreshold, the excess is
                   reclassified as overtime starting from the most recent shift
gross_pay      = regular_hours × rate + overtime_hours × rate × multiplier
```

Both thresholds and the multiplier are configurable per organisation *and* overridable
per upload. Setting the daily threshold to 24 gives a weekly-only policy; setting the
weekly threshold high gives a daily-only policy.

The brief's sample file produces exactly:

| Row | Employee | Verdict | Hours | Regular | Overtime | Gross |
|---|---|---|---|---|---|---|
| 2 | EMP-101 Sara | valid | 9 | 8 | 1 | 237.50 |
| 3 | EMP-102 Karan | valid | 8 | 8 | 0 | 160.00 |
| 4 | EMP-103 Neha | invalid — `CLOCK_OUT_NOT_AFTER_CLOCK_IN` | — | — | — | 0 |
| 5 | EMP-104 Vikram | valid | 12 | 8 | 4 | 252.00 |
| 6 | EMP-101 Sara | duplicate | — | — | — | 0 |
| 7 | EMP-105 Priya | invalid — `NON_POSITIVE_RATE` | — | — | — | 0 |
| 8 | EMP-106 Arjun | invalid — `FUTURE_DATE` | — | — | — | 0 |

Total payroll **$649.50**, 3 valid / 3 invalid / 1 duplicate. This is asserted in
`server/tests/validate.test.ts` and `server/tests/api.test.ts`.

### Aggregate metrics

Computed in SQL from the rollup tables and stored as one JSONB document per job:

total payroll cost · cost by department · regular vs overtime hours (company-wide and per
department) · average hours per employee · top 5 by overtime · week-over-week payroll trend
with % change · overtime cost as a % of payroll · standard deviation of shift length and of
per-employee hours (surfaced in the UI as an "irregular scheduling" table).

### Database design

```
organizations ──┬── users            (role: admin | hr | employee, optional employee_code)
                ├── employees        (unique per org)
                └── jobs ──┬── job_files       (uploaded content; keeps workers stateless)
                           ├── timesheet_rows  (raw + verdict + derived values)
                           ├── payroll_lines   (one row per employee per job — the payslip grain)
                           ├── payroll_weekly  (weekly rollup, company + per department)
                           └── payroll_reports (materialised metrics document)
event_log                                       (structured events, correlated by job)
```

Every table carries `org_id` and every query filters on it — tenant isolation is enforced
at the data layer, not just the route layer. Indexes target the actual access patterns:
`(org_id, department)` and `(org_id, period_end DESC)` make *"this department's payroll for
the last 3 pay periods"* a rollup-only query that never touches raw rows;
`(job_id, status)`, `(org_id, employee_code, work_date)` and `(job_id, overtime_hours DESC)`
back the payroll table, the employee drill-down and the top-overtime list.

### API surface

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/signup` · `/api/auth/login` · `GET /api/auth/me` | JWT, bcrypt |
| `GET/POST` | `/api/auth/users` | list team / create account (admin) |
| `PUT` | `/api/organization/rules` | configurable overtime policy |
| `POST` | `/api/jobs/upload` | multipart CSV/JSON, rate-limited per user |
| `POST` | `/api/jobs/:id/process` · `/api/jobs/:id/reaggregate` | manual trigger / re-run |
| `PATCH` | `/api/jobs/:id/employees/:code/rate` | correct a rate, then rebuild payroll |
| `GET` | `/api/jobs` · `/api/jobs/:id` · `/:id/rows` · `/:id/payroll` · `/:id/metrics` · `/:id/logs` | paged, sortable, searchable |
| `GET` | `/api/jobs/:id/export/annotated.csv` · `/export/payroll.csv` | downloads |
| `GET` | `/api/employees` · `/api/employees/:code/timesheet` · `/:code/payslip.csv` | day-by-day + payslip |
| `GET` | `/api/reports/overview` · `/api/reports/department-history` | dashboard, multi-period |
| `GET` | `/api/metrics/ops` · `/api/logs` · `/healthz` | observability |
| `WS` | `/ws?token=…&jobId=…` | live progress, org-scoped |

### Observability

Structured JSON logs (pino) with levels, redacted secrets, and a **correlation ID per job**
(`job_a1b2c3d4e5`) that ties the upload request, every worker phase and the aggregation
together. The same events are persisted to `event_log` so the UI can show a per-job trace
without a log stack. `/api/metrics/ops` reports job failure rate, average and max job
duration, average wall-clock and CPU time per row, and row retry counts — all rendered on
the Settings screen.

---

## 3. Design decisions and tradeoffs

**Embedded Postgres by default, real Postgres when configured.** The brief asks for
Postgres; a reviewer needs the thing to start. Both are served by one driver interface
(`server/src/db/index.ts`): `DATABASE_URL` unset boots [PGlite](https://pglite.dev)
(actual Postgres compiled to WASM, same SQL, same `stddev_samp`, same `jsonb`), set points
at a server. One schema, one set of migrations, no dialect branching. *Tradeoff:* PGlite is
single-connection and file-backed, so it is a development and test convenience, not a
production database — which is exactly why `docker compose` wires up the real one.

**An async worker pool, not `worker_threads`.** The per-row cost the brief asks us to
simulate is a *wait*, and the real per-row work (parsing, comparisons, arithmetic) is
microseconds. A pool of N async workers pulling from a shared cursor gives real
parallelism for that shape of work with none of the structured-clone cost of moving
100k rows across thread boundaries. The pool is a swappable module
(`server/src/lib/pool.ts`) — if row processing ever became CPU-bound, only its internals
change. It also beats chunked `Promise.all` batching, where every batch runs at the speed
of its slowest member.

**Grouped phases for deterministic set-based rules.** See "the processing pipeline" above.
The alternative — a shared `Map` of seen keys mutated by concurrent workers — is faster to
write and produces results that depend on scheduling. Payroll cannot be non-deterministic.

**Aggregation in SQL, not JavaScript.** For a 10k+ row file the database is both faster and
bounded in memory, and the rollup tables it writes then serve cross-job queries directly.
*Tradeoff:* the metric definitions live in SQL rather than in the unit-tested pure
functions — mitigated by asserting the aggregate output end-to-end in `api.test.ts`.

**Two queue drivers behind one interface.** In-process by default (zero setup, fine for a
single node); BullMQ + Redis when `REDIS_URL` is set, with a separate `worker` container
and Redis pub/sub carrying progress events back to whichever API process holds the
WebSocket. *Tradeoff:* the in-process queue loses queued jobs on restart — acceptable,
because the uploaded file is stored in the database and any job can be re-triggered.

**Uploaded files in the database, not on disk.** `job_files` holds the raw content, so the
API and worker containers stay stateless with no shared volume. *Tradeoff:* not the right
call past ~100MB, where object storage plus a streaming parser is correct. The
`MAX_UPLOAD_MB` cap keeps us well inside the sensible range.

**Rate correction re-prices rather than re-parses.** Hours don't depend on the rate, so
`PATCH …/rate` updates the rate, recomputes `gross_pay` in SQL and rebuilds the aggregates
— fast and safe. Anything that could change hours goes through **Reprocess file**, which
re-runs the whole pipeline from the stored original.

**WebSockets with a polling fallback.** Live progress is a WebSocket; if the socket can't
be established (a proxy that drops upgrades), the same hook transparently polls the REST
endpoint and the header shows "Polling" instead of "Live". The UI never depends on the
socket being available.

**Tenant isolation in the query, not a middleware.** Every statement filters on `org_id`,
and employee-role users are additionally scoped to their own `employee_code`. It's more
repetition than a global filter, but there is no code path where forgetting a decorator
leaks another organisation's payroll. Asserted directly in `api.test.ts`.

**Charts follow one colour system.** Regular hours/pay are always the same blue and
overtime always the same orange — the colour follows the measure, never its position in a
filtered list. The categorical pair was checked for colour-vision separation rather than
picked by eye, every multi-series chart carries a legend, and there is no dual-axis chart
anywhere.

### What I would do next

- Stream the parse for files past ~100MB instead of holding rows in memory
- Pay-period entities as first-class rows (currently derived from each job's date range)
- `COPY`-based bulk insert on real Postgres — the batched `INSERT` is the persist-stage bottleneck
- Per-row optimistic retry against a dead-letter table rather than an in-memory retry
- A real PDF payslip renderer; today the payslip screen is print-optimised (Save as PDF) plus a CSV export

---

## 4. Testing

```bash
npm test
```

- `validate.test.ts` — every rule, and the brief's sample file asserted row by row
- `compute.test.ts` — daily and weekly overtime, overlaps, duplicates, configurable rules, week boundaries
- `pool.test.ts` — proves the pool is actually concurrent, respects its limit, retries, and isolates permanent failures
- `api.test.ts` — signup/login, tenant isolation, employee-role restrictions, upload → process → metrics → export end to end, and a 2,000-row run asserted against hand-computed totals

The integration tests run against an in-memory Postgres, so CI needs no services.

---

## 5. How AI tools were used

This project was built with **Claude Code** (Claude Opus) driving the implementation, used
deliberately rather than as an autocomplete:

- **Design first, in prose.** Before any code, the pipeline was specified — where
  concurrency is real versus theatre, and which rules are per-row versus set-based. That
  conversation is what produced the three-phase grouped design instead of the obvious
  shared-mutable-`Map` approach, which would have made duplicate flagging depend on worker
  scheduling.
- **Generating the wide, boring surface fast.** Migrations, route handlers, formatters and
  the React pages are the bulk of the line count and the least interesting part of the
  problem. Delegating them freed the time actually spent on the pipeline, the indexes and
  the failure modes.
- **Tests as the specification.** The expected verdicts and payroll figures for the brief's
  seven sample rows were written as assertions *before* the compute engine, so the
  implementation had a fixed target. The 2,000-row test totals are hand-derivable
  (`500 employees × 4 days × (8×20 + 1×20×1.5)`) rather than snapshots of whatever the code
  happened to produce.
- **Reviewing its own output.** Several defects were caught by re-reading generated code
  critically: the payroll table not refetching after a rate correction, overtime leaking
  across ISO week boundaries, and an empty-batch `INSERT` that would have produced invalid
  SQL for a zero-row file.
- **Not delegated:** the schema and index choices, the decision to keep aggregation in SQL,
  the queue/database abstraction boundaries, and the chart colour system — these are the
  judgement calls the rest of the code hangs off.

The honest summary: AI made the breadth of this build feasible in the time available. The
parts worth reviewing — determinism under concurrency, tenant isolation, index design, and
what happens when a row fails — were decided by hand and then verified with tests.
