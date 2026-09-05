# TimeForge — Employee Timesheet & Payroll Calculator

Bulk timesheet ingestion, concurrent validation, payroll calculation, and a dashboard
HR can actually work from.

Upload a CSV or JSON of clock-in/clock-out records; TimeForge validates every row,
splits regular and overtime hours, prices the result, and stores rollups that answer
questions like *"what did Support cost over the last three pay periods?"* without
touching raw rows.

Runs with **no infrastructure setup** (Node 20+ and nothing else), and scales to
Postgres + Redis + a dedicated worker when configured.

---

## 1. Features

**Payroll processing**
- CSV and JSON upload with column-name tolerance (`employee_id`, `empid`, `employeeCode`, …)
- Per-row validation: required fields, real calendar dates, no future dates, clock-out
  after clock-in, positive hourly rate
- Cross-row validation: duplicate rows and overlapping shifts for the same employee
- Configurable daily and weekly overtime thresholds and multiplier — per organisation,
  overridable per upload
- Bad rows are flagged and reported, never dropped, and never fail the run

**Reporting**
- Total payroll cost, cost by department, regular vs overtime hours
- Average hours per employee, top 5 by overtime, week-over-week trend with % change
- Overtime as a share of payroll and of hours
- Standard deviation of shift length, surfaced as an "irregular scheduling" list
- Annotated CSV (every row + its verdict), payroll CSV, per-employee payslip CSV

**Product**
- Email/password auth with three roles: admin, HR, employee
- Organisation isolation and employee-level scoping enforced in every query
- Live processing progress over WebSocket, with REST polling fallback
- Sortable, searchable, paginated payroll table; per-employee day-by-day drill-down
- Inline rate correction that re-prices and rebuilds aggregates
- Structured logs with a correlation ID per job, plus an in-app activity log

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| API | Node 22, TypeScript, Fastify 5 |
| Database | Postgres — a server via `DATABASE_URL`, or embedded [PGlite](https://pglite.dev) with no setup |
| Queue | In-process by default; BullMQ + Redis via `REDIS_URL` |
| Frontend | React 18, Vite, Tailwind, Recharts, React Router |
| Auth | bcrypt password hashing, JWT bearer tokens |
| Logging | pino (JSON in production) |
| Tests | Vitest, running against an in-memory Postgres |

---

## 3. Architecture

```
┌─────────────┐   upload    ┌──────────────┐  enqueue   ┌───────────────┐
│  React SPA  │ ──────────► │  Fastify API │ ─────────► │  Payroll queue│
│   (Vite)    │ ◄────────── │  JWT + RBAC  │            │ memory/BullMQ │
└─────────────┘  WebSocket  └──────────────┘            └───────┬───────┘
       ▲          progress          │                           │
       │                            ▼                           ▼
       │                     ┌─────────────┐          ┌──────────────────┐
       └─────────────────────│  Postgres   │◄─────────│  Job processor   │
             REST reads      │  + rollups  │  writes  │  + worker pool   │
                             └─────────────┘          └──────────────────┘
```

```
server/src
  app.ts              Fastify wiring: CORS, multipart, rate limiting, errors, SPA hosting
  index.ts            API entrypoint and graceful shutdown
  worker.ts           Standalone queue worker (Redis deployments)
  config.ts           Environment config + production safety checks
  auth/               Password hashing, JWT, role guards, tenant scoping
  db/                 Driver (pg | PGlite) and SQL migrations
  payroll/            The domain: parse -> validate -> calculate -> aggregate, plus CSV export
  jobs/               Pipeline (processor), queue, worker pool, progress, events, row storage
  routes/             auth, jobs, exports, employees, reports
  ws/                 WebSocket fan-out for live progress
web/src
  pages/              Login, Signup, Dashboard, Upload, Jobs, JobDetail (+ job/ tabs),
                      Employees, EmployeeDetail, MyPayslip, Settings
  components/         Layout, UI primitives, charts
  lib/                API client, auth context, formatters, shared job stream
```

The payroll domain (`server/src/payroll/`) is pure — no database, no HTTP — so the
business rules can be read and tested on their own. The `jobs/` modules orchestrate it.

---

## 4. Database design

```
organizations ──┬── users             (role: admin | hr | employee, optional employee_code)
                ├── employees         (unique per organisation)
                └── jobs ──┬── job_files       (uploaded content; keeps workers stateless)
                           ├── timesheet_rows  (raw values + verdict + derived pay)
                           ├── payroll_lines   (one row per employee — the payslip grain)
                           ├── payroll_weekly  (weekly rollup, company-wide and per department)
                           └── payroll_reports (materialised metrics document)
event_log                                       (structured events, correlated per job)
```

Money is `NUMERIC`, never floating point; hours are `NUMERIC(10,2)`.

Every table carries `org_id`, and every query filters on it — isolation is enforced at
the query, not by a middleware someone can forget to apply.

Indexes follow the real access patterns:

| Index | Serves |
|---|---|
| `payroll_lines (org_id, department)` | department payroll across pay periods |
| `jobs (org_id, period_end DESC)` | "last N pay periods" |
| `payroll_lines (job_id, overtime_hours DESC)` | top-overtime list |
| `timesheet_rows (job_id, status)` | the rows/errors table |
| `timesheet_rows (org_id, employee_code, work_date)` | employee drill-down |

Migrations are ordered TypeScript modules in `server/src/db/migrations/`, applied at
startup and tracked in `_migrations`.

---

## 5. Processing flow

`server/src/jobs/processor.ts` runs six stages and reports one 0–100 progress number.

| Stage | Unit of work | Concurrent |
|---|---|---|
| `parsing` | the file | — |
| `validating` | **one row** | ✅ worker pool |
| `resolving` | one `(employee, date)` — duplicates, overlaps, daily split | ✅ worker pool |
| `overtime` | one `(employee, ISO week)` — weekly threshold, then pricing | ✅ worker pool |
| `persisting` | batches of 250 rows | — |
| `aggregating` | SQL rollups + metrics document | — |

Failure handling at each boundary:

- A row that throws is retried (`ROW_MAX_ATTEMPTS`) then recorded as `PROCESSING_ERROR`
  — surfaced in the report, never silently dropped
- A job that throws is marked `failed`, with the message stored on the job row and
  logged against its correlation ID
- An unreadable file is rejected at upload with a 400, before a job row is created
- `SIGTERM` drains in-flight jobs before closing the database (15s, then aborts)

---

## 6. Concurrency design

Validation is genuinely per-row, so it fans out across a worker pool. Duplicate
detection, overlap detection and the overtime split are **set-based** — they depend on
the employee's other rows.

Rather than share mutable state between workers (which makes results depend on whichever
worker finished first), rows are grouped and each **group** becomes one task. Groups are
independent, so they run in parallel; within a group rows are always ordered by row
number. Re-running the same file produces identical output.

`runWorkerPool` uses a fixed number of workers pulling from a shared cursor, so a slow
task never blocks the ones behind it — unlike chunked `Promise.all`, where each batch
runs at the speed of its slowest member. Failures are collected, not thrown.

Measured on 9,538 rows with the default 4ms simulated per-row cost:

| `WORKER_CONCURRENCY` | Validation stage | Throughput |
|---|---|---|
| 1 (sequential) | 43.1s | 221 rows/s |
| 4 | 10.7s | 888 rows/s |
| **8 (default)** | **5.5s** | **1,749 rows/s** |
| 16 | 2.7s | 3,580 rows/s |
| 32 | 1.4s | 6,911 rows/s |

End to end through HTTP — upload, validate, resolve, price, persist, aggregate —
9,538 rows complete in **~6s**, with progress updating throughout.

---

## 7. Payroll calculation rules

```
hours worked = clock_out − clock_in                        (2 decimal places)

regular / overtime hours
  1. daily rule   hours past dailyThreshold in one day are overtime, filled
                  across that day's shifts in clock-in order
  2. weekly rule  if the week's regular hours exceed weeklyThreshold, the excess
                  moves to overtime starting from the most recent shift

regular pay  = round(regular_hours  × rate)                (in whole cents)
overtime pay = round(overtime_hours × rate × multiplier)   (in whole cents)
gross pay    = regular pay + overtime pay
```

Pay is computed in integer cents and divided once. Rounding each earning line and
summing integers is what keeps a payslip's regular + overtime equal to its gross;
summing rounded floating-point values does not. Aggregation only ever *sums* these
columns, so the overtime multiplier appears in exactly one place —
`server/src/payroll/calculate.ts`.

Setting the daily threshold to 24 gives a weekly-only policy; a high weekly threshold
gives a daily-only policy.

### Validation rules

| Code | Meaning |
|---|---|
| `MISSING_FIELD` | one of the seven required fields is blank |
| `INVALID_DATE` | not a real calendar date; only `YYYY-MM-DD` is accepted |
| `FUTURE_DATE` | dated after today |
| `INVALID_TIME` | unparseable `clock_in` / `clock_out` |
| `CLOCK_OUT_NOT_AFTER_CLOCK_IN` | reversed or zero-length shift |
| `INVALID_RATE` / `NON_POSITIVE_RATE` | not a number, or ≤ 0 |
| `DUPLICATE_ROW` | same employee + date + clock_in as an earlier row |
| `OVERLAPPING_SHIFT` | overlaps a shift already accepted that day |
| `PROCESSING_ERROR` | the row failed every retry |

A row ends up `valid`, `invalid`, or `duplicate`. Only `valid` rows are paid.

The sample file from the brief (`samples/timesheet_sample.csv`) produces:

| Row | Employee | Verdict | Hours | Regular | Overtime | Gross |
|---|---|---|---|---|---|---|
| 2 | EMP-101 Sara | valid | 9 | 8 | 1 | 237.50 |
| 3 | EMP-102 Karan | valid | 8 | 8 | 0 | 160.00 |
| 4 | EMP-103 Neha | invalid — `CLOCK_OUT_NOT_AFTER_CLOCK_IN` | — | — | — | 0 |
| 5 | EMP-104 Vikram | valid | 12 | 8 | 4 | 252.00 |
| 6 | EMP-101 Sara | duplicate | — | — | — | 0 |
| 7 | EMP-105 Priya | invalid — `NON_POSITIVE_RATE` | — | — | — | 0 |
| 8 | EMP-106 Arjun | invalid — `FUTURE_DATE` | — | — | — | 0 |

Total **$649.50**, 3 valid / 3 invalid / 1 duplicate — asserted in the test suite.

---

## 8. API overview

All `/api` routes except signup and login require `Authorization: Bearer <token>`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/signup` · `/api/auth/login` · `GET /api/auth/me` | |
| `GET/POST` | `/api/auth/users` | list team / create account (admin) |
| `PUT` | `/api/organization/rules` | overtime policy (admin) |
| `POST` | `/api/jobs/upload` | multipart CSV/JSON, rate limited per token |
| `POST` | `/api/jobs/:id/process` · `/api/jobs/:id/reaggregate` | trigger / re-run |
| `PATCH` | `/api/jobs/:id/employees/:code/rate` | correct a rate, rebuild payroll |
| `GET` | `/api/jobs` · `/:id` · `/:id/rows` · `/:id/payroll` · `/:id/metrics` · `/:id/logs` | paged, sortable, searchable |
| `GET` | `/api/jobs/:id/export/annotated.csv` · `/export/payroll.csv` | downloads |
| `GET` | `/api/employees` · `/api/departments` · `/api/employees/:code/timesheet` · `/:code/payslip.csv` | |
| `GET` | `/api/reports/overview` · `/api/reports/department-history` | dashboard, multi-period |
| `GET` | `/api/metrics/ops` · `/api/logs` (admin/HR) · `/healthz` | observability |
| `WS` | `/ws?token=…` | live progress, scoped to the caller's organisation |

Errors return `{ error, message, requestId }`. 5xx responses carry a generic message;
the detail and stack stay in the logs, keyed by `requestId`.

---

## 9. Local setup

Requires **Node.js 20+**.

```bash
npm install
cp .env.example .env      # optional — every value has a working default
npm run seed              # optional — demo organisation, users, two processed pay runs
npm run dev               # API on :4000, UI on :5173
```

Open <http://localhost:5173>.

Seeded accounts (organisation *Northwind Labs*):

| Role | Email | Password | Sees |
|---|---|---|---|
| Admin | `admin@demo.io` | `password123` | everything; can upload and change rules |
| HR | `hr@demo.io` | `password123` | everything; can upload |
| Employee | `employee@demo.io` | `password123` | their own payslip only |

Or click **Create an organisation** and become its admin.

Sample files in [`samples/`](samples/):

- `timesheet_sample.csv` — the seven rows from the brief, one of each defect
- `timesheet_sample.json` — the same data as JSON
- `timesheet_two_weeks.csv` — ~570 rows over two ISO weeks with ~4% defects

```bash
npm run -w server generate -- 10000   # writes samples/timesheet_10k.csv for load testing
```

---

## 10. Environment variables

[`.env.example`](.env.example) documents every variable. The two that change the
topology:

| Variable | Unset (default) | Set |
|---|---|---|
| `DATABASE_URL` | embedded Postgres in `.data/pg` | connects to a Postgres server |
| `REDIS_URL` | in-process queue | BullMQ + Redis, worker can run separately |

Commonly tuned: `WORKER_CONCURRENCY` (8), `MAX_PARALLEL_JOBS` (2),
`ROW_PROCESSING_DELAY_MS` (4), `ROW_MAX_ATTEMPTS` (3), `MAX_UPLOAD_MB` (25),
`UPLOAD_RATE_LIMIT_PER_MIN` (10), and the default overtime rules
`OT_DAILY_THRESHOLD` / `OT_WEEKLY_THRESHOLD` / `OT_MULTIPLIER`.

**In production** the process refuses to start unless `JWT_SECRET` is changed from the
default and at least 32 characters, and `CORS_ORIGINS` lists the allowed origins.

---

## 11. Running tests

```bash
npm test          # 70 tests
npm run lint      # ESLint across both workspaces
npm run typecheck # tsc --noEmit, server + web
```

| Suite | Covers |
|---|---|
| `validate.test.ts` | every field rule, and the brief's sample file row by row |
| `calculate.test.ts` | daily/weekly overtime, overlaps, duplicates, configurable rules, week boundaries, pay precision to the cent |
| `aggregate.test.ts` | department totals, weekly trend and % change, top overtime, standard deviation, overtime %, data-quality counts, idempotent re-runs |
| `workerPool.test.ts` | real concurrency, the concurrency limit, retries, isolated permanent failures |
| `api.test.ts` | auth, cross-organisation isolation, employee-role restrictions, upload → process → metrics → export, and a 2,000-row run against hand-computed totals |

Tests run against an in-memory Postgres, so CI needs no services.

---

## 12. Docker

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
# → http://localhost:4000
```

Brings up Postgres, Redis, the API (which also serves the built UI) and a dedicated
worker consuming from the BullMQ queue. The API container enqueues only
(`INLINE_WORKER=false`), so payroll runs never compete with request handling.

> The Docker build is written but was not executed here — no Docker daemon was
> available in this environment. Everything else in this README was run.

---

## 13. Design decisions and tradeoffs

**Embedded Postgres by default, a real server when configured.** One driver interface
(`server/src/db/index.ts`) covers both: unset `DATABASE_URL` boots PGlite (Postgres
compiled to WebAssembly — same SQL, same `STDDEV_SAMP`, same `jsonb`), set points at a
server. One schema, one set of migrations, no dialect branching. PGlite is
single-connection and file-backed, so it is a development and test convenience;
`docker compose` runs the real thing.

**Pay computed in integer cents.** Rounding each earning line and summing integers is
what makes a payslip foot. Aggregation only sums the stored `regular_pay` and
`overtime_pay` columns, so the overtime multiplier exists in exactly one place — before
this, aggregation re-derived overtime pay in SQL and a payslip's parts could disagree
with its total by a cent.

**An async worker pool, not `worker_threads`.** The per-row cost being simulated is a
wait, and the real per-row work is microseconds of parsing and arithmetic. N async
workers give real parallelism for that shape without the structured-clone cost of moving
10,000 rows across thread boundaries. The pool is one module; if row processing became
CPU-bound, only its internals change.

**Aggregation in SQL.** For a 10k+ row file the database is faster and bounded in
memory, and the rollup tables it writes then serve cross-job queries directly. The
tradeoff is that metric definitions live in SQL rather than in the unit-tested pure
functions — covered by asserting aggregate output end to end in `aggregate.test.ts`.

**Two queue drivers behind one interface.** In-process by default (zero setup, fine for
one node); BullMQ + Redis when configured, with Redis pub/sub carrying progress back to
whichever API process holds the WebSocket. The in-process queue loses *queued* jobs on
restart — acceptable because the uploaded file is stored in the database and any job can
be re-triggered. In-flight jobs are drained on `SIGTERM`.

**Uploaded files in the database.** `job_files` holds the raw content so the API and
worker containers stay stateless with no shared volume. Wrong past ~100MB, where object
storage and a streaming parser are correct; `MAX_UPLOAD_MB` keeps us inside the sensible
range.

**Rate correction re-prices rather than re-parses.** Hours do not depend on the rate, so
`PATCH …/rate` updates the rate, recomputes pay in SQL and rebuilds aggregates. Anything
that could change hours goes through **Reprocess file**, which re-runs the pipeline from
the stored original.

**Tenant isolation in the query.** Every statement filters on `org_id`, and
employee-role users are additionally scoped to their own `employee_code` by
`restrictToOwnEmployeeCode`, which callers put in the `WHERE` clause. More repetition
than a global filter, but there is no path where forgetting a decorator leaks another
organisation's payroll.

**Bearer tokens in the header only.** The WebSocket handshake reads `?token=` because
browsers cannot set headers there; HTTP routes do not, so tokens stay out of access
logs, proxy logs and browser history.

**A simulated per-row delay ships in the code.** `ROW_PROCESSING_DELAY_MS` stands in for
the rule lookups a real payroll engine performs, and exists so the concurrency is
measurable rather than theoretical. Set it to `0` for a real deployment.

### Known limitations

- Shifts that cross midnight are rejected rather than split across two days
- The parser holds all rows in memory; past ~100MB it should stream
- Persisting uses batched `INSERT`; on a real Postgres, `COPY` would be faster
- Pay periods are derived from each job's date range rather than being first-class
- The payslip screen is print-optimised (Save as PDF) plus CSV; there is no PDF renderer

---

## 14. AI usage disclosure

AI tooling (Claude) was used throughout this project, and the result was reviewed,
tested and corrected by hand rather than accepted as written.

Where it was used:

- **Architecture discussion** — talking through where concurrency is real versus
  cosmetic, and which validation rules are per-row versus set-based. That is what
  produced the grouped-phase design instead of a shared mutable map, which would have
  made duplicate flagging depend on worker scheduling.
- **Scaffolding** — migrations, route handlers, React pages and formatters: the bulk of
  the line count and the least interesting part of the problem.
- **Test suggestions** — expected verdicts and payroll figures for the sample file were
  written as assertions before the calculator existed, so the implementation had a fixed
  target. Totals in the larger tests are hand-derivable rather than snapshots of
  whatever the code happened to produce.
- **Code review** — a structured pass over the finished implementation, which surfaced
  several of the defects fixed below.
- **Documentation** — drafting this README.

What was decided and verified by hand: the schema and index choices, keeping aggregation
in SQL, the queue and database abstraction boundaries, the money representation, and the
security model.

Defects found during review and fixed — several of them in AI-generated code:

- a payslip whose regular + overtime did not always equal its gross
- the overtime multiplier duplicated in four SQL statements and the calculator
- an N+1 insert in the employee directory sync (one round trip per employee)
- bearer tokens accepted from the query string on every HTTP route
- an ops metrics query that scanned every row ever ingested by the organisation
- a shutdown path that closed the database under a running job
- three WebSocket connections open per page instead of one

Every claim in this README was executed against the running application; the single
exception is called out in the Docker section.
