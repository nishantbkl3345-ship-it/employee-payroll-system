export type ErrorCode =
  | 'MISSING_FIELD'
  | 'INVALID_DATE'
  | 'FUTURE_DATE'
  | 'INVALID_TIME'
  | 'CLOCK_OUT_NOT_AFTER_CLOCK_IN'
  | 'INVALID_RATE'
  | 'NON_POSITIVE_RATE'
  | 'DUPLICATE_ROW'
  | 'OVERLAPPING_SHIFT'
  | 'IMPLAUSIBLE_SHIFT_LENGTH'
  | 'PROCESSING_ERROR';

export type RowError = { code: ErrorCode; field?: string; message: string };

export type RowStatus = 'valid' | 'invalid' | 'duplicate';

/** A row exactly as it appeared in the uploaded file. */
export interface RawRow {
  rowNumber: number;
  employee_id: string;
  employee_name: string;
  department: string;
  date: string;
  clock_in: string;
  clock_out: string;
  hourly_rate: string;
  [k: string]: string | number;
}

/** A row after field-level parsing, validation and daily payroll math. */
export interface ProcessedRow {
  rowNumber: number;
  employeeCode: string;
  employeeName: string;
  department: string;
  workDate: string | null; // YYYY-MM-DD
  clockIn: string | null; // HH:MM
  clockOut: string | null; // HH:MM
  minutesIn: number | null;
  minutesOut: number | null;
  hourlyRate: number | null;
  status: RowStatus;
  errors: RowError[];
  hoursWorked: number;
  regularHours: number;
  overtimeHours: number;
  grossPay: number;
  isoWeek: string | null;
  weekStart: string | null;
  attempts: number;
  processingMs: number;
  raw: Record<string, unknown>;
}

export interface OvertimeRules {
  dailyThreshold: number;
  weeklyThreshold: number;
  multiplier: number;
}
