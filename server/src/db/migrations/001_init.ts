export const id = '001_init';
export const sql = `
CREATE TABLE IF NOT EXISTS organizations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL,
  slug                      TEXT NOT NULL UNIQUE,
  ot_daily_threshold        NUMERIC(6,2) NOT NULL DEFAULT 8,
  ot_weekly_threshold       NUMERIC(6,2) NOT NULL DEFAULT 40,
  ot_multiplier             NUMERIC(5,2) NOT NULL DEFAULT 1.5,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_code  TEXT NOT NULL,
  name           TEXT NOT NULL,
  department     TEXT NOT NULL DEFAULT 'Unassigned',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, employee_code)
);
CREATE INDEX IF NOT EXISTS employees_org_dept_idx ON employees (org_id, department);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','hr','employee')),
  employee_code  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  correlation_id   TEXT NOT NULL,
  filename         TEXT NOT NULL,
  source_format    TEXT NOT NULL DEFAULT 'csv',
  byte_size        INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','queued','processing','completed','failed')),
  stage            TEXT NOT NULL DEFAULT 'uploaded',
  total_rows       INTEGER NOT NULL DEFAULT 0,
  processed_rows   INTEGER NOT NULL DEFAULT 0,
  valid_rows       INTEGER NOT NULL DEFAULT 0,
  invalid_rows     INTEGER NOT NULL DEFAULT 0,
  duplicate_rows   INTEGER NOT NULL DEFAULT 0,
  period_start     DATE,
  period_end       DATE,
  rules            JSONB NOT NULL DEFAULT '{}'::jsonb,
  error            TEXT,
  queued_at        TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  duration_ms      INTEGER,
  avg_row_ms       NUMERIC(10,3),
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_org_created_idx ON jobs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_org_period_idx  ON jobs (org_id, period_end DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx      ON jobs (status);

-- Uploaded file contents live in the database so the API and the worker
-- processes stay stateless (no shared volume required).
CREATE TABLE IF NOT EXISTS job_files (
  job_id     UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  checksum   TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw ingested rows, annotated with validation status and derived payroll values.
CREATE TABLE IF NOT EXISTS timesheet_rows (
  id              BIGSERIAL PRIMARY KEY,
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  row_number      INTEGER NOT NULL,
  employee_code   TEXT,
  employee_name   TEXT,
  department      TEXT,
  work_date       DATE,
  clock_in        TEXT,
  clock_out       TEXT,
  hourly_rate     NUMERIC(12,2),
  status          TEXT NOT NULL CHECK (status IN ('valid','invalid','duplicate')),
  errors          JSONB NOT NULL DEFAULT '[]'::jsonb,
  hours_worked    NUMERIC(10,2) NOT NULL DEFAULT 0,
  regular_hours   NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_hours  NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross_pay       NUMERIC(14,2) NOT NULL DEFAULT 0,
  iso_week        TEXT,
  week_start      DATE,
  attempts        INTEGER NOT NULL DEFAULT 1,
  processing_ms   NUMERIC(10,3) NOT NULL DEFAULT 0,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ts_rows_job_idx        ON timesheet_rows (job_id, row_number);
CREATE INDEX IF NOT EXISTS ts_rows_job_status_idx ON timesheet_rows (job_id, status);
CREATE INDEX IF NOT EXISTS ts_rows_org_date_idx   ON timesheet_rows (org_id, work_date);
CREATE INDEX IF NOT EXISTS ts_rows_emp_idx        ON timesheet_rows (org_id, employee_code, work_date);
CREATE INDEX IF NOT EXISTS ts_rows_dept_idx       ON timesheet_rows (org_id, department, work_date);
CREATE INDEX IF NOT EXISTS ts_rows_week_idx       ON timesheet_rows (job_id, employee_code, iso_week);

-- One payroll line per employee per job (the payslip grain).
CREATE TABLE IF NOT EXISTS payroll_lines (
  id               BIGSERIAL PRIMARY KEY,
  job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_code    TEXT NOT NULL,
  employee_name    TEXT NOT NULL,
  department       TEXT NOT NULL,
  days_worked      INTEGER NOT NULL DEFAULT 0,
  regular_hours    NUMERIC(12,2) NOT NULL DEFAULT 0,
  overtime_hours   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_hours      NUMERIC(12,2) NOT NULL DEFAULT 0,
  avg_daily_hours  NUMERIC(10,2) NOT NULL DEFAULT 0,
  hourly_rate      NUMERIC(12,2) NOT NULL DEFAULT 0,
  regular_pay      NUMERIC(14,2) NOT NULL DEFAULT 0,
  overtime_pay     NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_pay        NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (job_id, employee_code)
);
CREATE INDEX IF NOT EXISTS payroll_lines_org_dept_idx ON payroll_lines (org_id, department);
CREATE INDEX IF NOT EXISTS payroll_lines_org_emp_idx  ON payroll_lines (org_id, employee_code);
CREATE INDEX IF NOT EXISTS payroll_lines_ot_idx       ON payroll_lines (job_id, overtime_hours DESC);

-- Weekly rollup: powers the week-over-week trend without scanning raw rows.
CREATE TABLE IF NOT EXISTS payroll_weekly (
  id              BIGSERIAL PRIMARY KEY,
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  iso_week        TEXT NOT NULL,
  week_start      DATE NOT NULL,
  department      TEXT NOT NULL DEFAULT '*',
  regular_hours   NUMERIC(12,2) NOT NULL DEFAULT 0,
  overtime_hours  NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_pay       NUMERIC(14,2) NOT NULL DEFAULT 0,
  overtime_pay    NUMERIC(14,2) NOT NULL DEFAULT 0,
  employee_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (job_id, iso_week, department)
);
CREATE INDEX IF NOT EXISTS payroll_weekly_org_idx ON payroll_weekly (org_id, week_start);

-- Computed aggregate report per job (materialised metrics for the dashboard).
CREATE TABLE IF NOT EXISTS payroll_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start  DATE,
  period_end    DATE,
  metrics       JSONB NOT NULL,
  computed_ms   NUMERIC(10,3) NOT NULL DEFAULT 0,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_reports_org_idx ON payroll_reports (org_id, period_end DESC);

-- Application/system event log (mirrors the structured stdout logs so the UI
-- can show a per-job trace without shipping logs anywhere).
CREATE TABLE IF NOT EXISTS event_log (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID,
  job_id          UUID,
  correlation_id  TEXT,
  level           TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  event           TEXT NOT NULL,
  message         TEXT NOT NULL DEFAULT '',
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_log_job_idx ON event_log (job_id, id);
CREATE INDEX IF NOT EXISTS event_log_org_idx ON event_log (org_id, created_at DESC);
`;
