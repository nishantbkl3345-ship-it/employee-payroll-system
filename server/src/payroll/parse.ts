import { parse as parseCsv } from 'csv-parse/sync';
import type { UploadedRow } from './types.js';

export class TimesheetParseError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TimesheetParseError';
  }
}

/** Canonical column -> header spellings we have actually seen in exports. */
const COLUMN_ALIASES: Record<string, string[]> = {
  employee_id: ['employeeid', 'empid', 'employeecode', 'employeenumber'],
  employee_name: ['employeename', 'name', 'fullname'],
  department: ['department', 'dept'],
  date: ['date', 'workdate', 'shiftdate'],
  clock_in: ['clockin', 'starttime', 'timein'],
  clock_out: ['clockout', 'endtime', 'timeout'],
  hourly_rate: ['hourlyrate', 'rate', 'payrate'],
};

const BLANK_ROW = {
  employee_id: '',
  employee_name: '',
  department: '',
  date: '',
  clock_in: '',
  clock_out: '',
  hourly_rate: '',
};

export interface ParsedTimesheet {
  rows: UploadedRow[];
  format: 'csv' | 'json';
  /** Canonical columns the header row did not contain. */
  missingColumns: string[];
}

export function parseTimesheet(content: Buffer | string, filename = 'upload.csv'): ParsedTimesheet {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  if (!text.trim()) throw new TimesheetParseError('The uploaded file is empty');

  const looksLikeJson = /^\s*[[{]/.test(text) || filename.toLowerCase().endsWith('.json');
  return looksLikeJson ? parseJsonTimesheet(text) : parseCsvTimesheet(text);
}

function parseCsvTimesheet(text: string): ParsedTimesheet {
  let records: string[][];
  try {
    records = parseCsv(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }) as string[][];
  } catch (error) {
    throw new TimesheetParseError('Could not parse the file as CSV', (error as Error).message);
  }
  if (!records.length) throw new TimesheetParseError('The uploaded file has no rows');

  const columns = records[0].map((header) => canonicalColumn(header) ?? header.trim());
  const missingColumns = missing(columns);
  if (missingColumns.length === Object.keys(COLUMN_ALIASES).length) {
    throw new TimesheetParseError(
      'No recognisable timesheet columns found. Expected a header row with employee_id, ' +
        'employee_name, department, date, clock_in, clock_out, hourly_rate.',
      { headers: records[0] },
    );
  }

  const rows: UploadedRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record.every((cell) => String(cell ?? '').trim() === '')) continue;

    const row: UploadedRow = { ...BLANK_ROW, rowNumber: i + 1 };
    record.forEach((cell, index) => {
      const column = columns[index];
      if (column) row[column] = typeof cell === 'string' ? cell.trim() : cell;
    });
    rows.push(row);
  }

  return { rows, format: 'csv', missingColumns };
}

function parseJsonTimesheet(text: string): ParsedTimesheet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TimesheetParseError('Could not parse the file as JSON', (error as Error).message);
  }

  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { rows?: unknown }).rows)
      ? ((parsed as { rows: unknown[] }).rows as Record<string, unknown>[])
      : null;
  if (!records) {
    throw new TimesheetParseError('JSON uploads must be an array of rows, or { "rows": [...] }');
  }
  if (!records.length) throw new TimesheetParseError('The uploaded file has no rows');

  const rows = records.map((record, index) => {
    const row: UploadedRow = { ...BLANK_ROW, rowNumber: index + 1 };
    for (const [key, value] of Object.entries(record ?? {})) {
      row[canonicalColumn(key) ?? key] = value === null || value === undefined ? '' : String(value).trim();
    }
    return row;
  });

  const columns = [...new Set(records.flatMap((record) => Object.keys(record ?? {})))].map(
    (key) => canonicalColumn(key) ?? key,
  );
  return { rows, format: 'json', missingColumns: missing(columns) };
}

function canonicalColumn(header: string): string | null {
  const normalised = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [column, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (normalised === column.replace(/_/g, '') || aliases.includes(normalised)) return column;
  }
  return null;
}

function missing(columns: string[]): string[] {
  const present = new Set(columns);
  return Object.keys(COLUMN_ALIASES).filter((column) => !present.has(column));
}
