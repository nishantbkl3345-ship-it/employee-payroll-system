export type ValidationCode =
  | 'MISSING_FIELD'
  | 'INVALID_DATE'
  | 'FUTURE_DATE'
  | 'INVALID_TIME'
  | 'CLOCK_OUT_NOT_AFTER_CLOCK_IN'
  | 'INVALID_RATE'
  | 'NON_POSITIVE_RATE'
  | 'DUPLICATE_ROW'
  | 'OVERLAPPING_SHIFT'
  | 'PROCESSING_ERROR';

export interface ValidationError {
  code: ValidationCode;
  field?: string;
  message: string;
}

export type RowStatus = 'valid' | 'invalid' | 'duplicate';

/** One record exactly as it appeared in the uploaded file. */
export interface UploadedRow {
  rowNumber: number;
  employee_id: string;
  employee_name: string;
  department: string;
  date: string;
  clock_in: string;
  clock_out: string;
  hourly_rate: string;
  [column: string]: string | number;
}

/** A timesheet row after validation and payroll calculation. */
export interface TimesheetRow {
  rowNumber: number;
  employeeCode: string;
  employeeName: string;
  department: string;
  workDate: string | null;
  clockIn: string | null;
  clockOut: string | null;
  clockInMinutes: number | null;
  clockOutMinutes: number | null;
  hourlyRate: number | null;

  status: RowStatus;
  errors: ValidationError[];

  hoursWorked: number;
  regularHours: number;
  overtimeHours: number;
  regularPay: number;
  overtimePay: number;
  grossPay: number;

  isoWeek: string | null;
  weekStart: string | null;
  attempts: number;
  raw: Record<string, unknown>;
}

export interface OvertimeRules {
  /** Hours past this in a single day are paid as overtime. */
  dailyThreshold: number;
  /** Regular hours past this in an ISO week are reclassified as overtime. */
  weeklyThreshold: number;
  /** Overtime is paid at hourlyRate × this. */
  multiplier: number;
}
