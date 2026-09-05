const escape = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Minimal RFC4180 writer. The BOM keeps Excel from mangling UTF-8. */
function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = headers.length ? [headers.map(escape).join(',')] : [];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const day = (value: unknown): string => (value ? String(value).slice(0, 10) : '');

const parseErrors = (value: unknown): Array<{ code: string; message: string }> =>
  Array.isArray(value) ? value : JSON.parse((value as string) ?? '[]');

/** The uploaded file with each row's verdict — the error report HR works from. */
export function annotatedTimesheetCsv(rows: Record<string, any>[]): string {
  return toCsv(
    [
      'row_number',
      'employee_id',
      'employee_name',
      'department',
      'date',
      'clock_in',
      'clock_out',
      'hourly_rate',
      'status',
      'error_codes',
      'error_messages',
      'hours_worked',
      'regular_hours',
      'overtime_hours',
      'regular_pay',
      'overtime_pay',
      'gross_pay',
    ],
    rows.map((row) => {
      const errors = parseErrors(row.errors);
      return [
        row.row_number,
        row.employee_code,
        row.employee_name,
        row.department,
        day(row.work_date),
        row.clock_in,
        row.clock_out,
        row.hourly_rate,
        row.status,
        errors.map((error) => error.code).join('|'),
        errors.map((error) => error.message).join(' | '),
        row.hours_worked,
        row.regular_hours,
        row.overtime_hours,
        row.regular_pay,
        row.overtime_pay,
        row.gross_pay,
      ];
    }),
  );
}

export function payrollSummaryCsv(lines: Record<string, any>[]): string {
  return toCsv(
    [
      'employee_id',
      'employee_name',
      'department',
      'days_worked',
      'regular_hours',
      'overtime_hours',
      'total_hours',
      'hourly_rate',
      'regular_pay',
      'overtime_pay',
      'gross_pay',
    ],
    lines.map((line) => [
      line.employee_code,
      line.employee_name,
      line.department,
      line.days_worked,
      line.regular_hours,
      line.overtime_hours,
      line.total_hours,
      line.hourly_rate,
      line.regular_pay,
      line.overtime_pay,
      line.gross_pay,
    ]),
  );
}

export function payslipCsv(input: {
  organizationName: string;
  job: { filename: string; period_start: unknown; period_end: unknown };
  line: Record<string, any>;
  days: Record<string, any>[];
}): string {
  const { organizationName, job, line, days } = input;

  return toCsv(
    [],
    [
      ['Payslip', organizationName],
      ['Employee', `${line.employee_name} (${line.employee_code})`],
      ['Department', line.department],
      ['Pay period', `${day(job.period_start)} to ${day(job.period_end)}`],
      ['Source file', job.filename],
      [],
      ['Earnings', 'Hours', 'Amount'],
      ['Regular', line.regular_hours, line.regular_pay],
      ['Overtime', line.overtime_hours, line.overtime_pay],
      ['Gross pay', line.total_hours, line.gross_pay],
      [],
      ['Date', 'Clock in', 'Clock out', 'Hours', 'Regular', 'Overtime', 'Rate', 'Pay'],
      ...days.map((shift) => [
        day(shift.work_date),
        shift.clock_in,
        shift.clock_out,
        shift.hours_worked,
        shift.regular_hours,
        shift.overtime_hours,
        shift.hourly_rate,
        shift.gross_pay,
      ]),
    ],
  );
}
