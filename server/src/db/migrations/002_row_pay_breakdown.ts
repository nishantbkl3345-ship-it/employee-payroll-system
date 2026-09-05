export const id = '002_row_pay_breakdown';

/**
 * Store regular and overtime pay per row instead of only the combined gross.
 *
 * Aggregation used to re-derive overtime pay by multiplying hours by the rate
 * again, which duplicated the pay rule in SQL and let a payslip's regular +
 * overtime disagree with its gross by a cent (sum-of-rounded vs rounded-sum).
 * The calculator now prices each row and aggregation only sums.
 *
 * Also drops the per-row timing column: the org-wide metrics query averaged it
 * across every row ever ingested, and jobs.avg_row_ms already carries it.
 */
export const sql = `
ALTER TABLE timesheet_rows ADD COLUMN IF NOT EXISTS regular_pay  NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE timesheet_rows ADD COLUMN IF NOT EXISTS overtime_pay NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE timesheet_rows DROP COLUMN IF EXISTS processing_ms;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retried_rows INTEGER NOT NULL DEFAULT 0;
`;
