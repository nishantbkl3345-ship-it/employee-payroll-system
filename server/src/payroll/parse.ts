import { parse as parseCsv } from 'csv-parse/sync';
import type { RawRow } from './types.js';

export class UploadParseError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'UploadParseError';
  }
}

/** Canonical field -> accepted header spellings (normalised: lowercase, alnum only). */
const ALIASES: Record<string, string[]> = {
  employee_id: ['employeeid', 'empid', 'id', 'employeecode', 'employeenumber'],
  employee_name: ['employeename', 'name', 'fullname', 'employee'],
  department: ['department', 'dept', 'team'],
  date: ['date', 'workdate', 'shiftdate', 'day'],
  clock_in: ['clockin', 'in', 'starttime', 'start', 'timein'],
  clock_out: ['clockout', 'out', 'endtime', 'end', 'timeout'],
  hourly_rate: ['hourlyrate', 'rate', 'payrate', 'wage', 'hourlywage'],
};

const normalise = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

function buildHeaderMap(headers: string[]): Record<number, string> {
  const map: Record<number, string> = {};
  headers.forEach((header, i) => {
    const n = normalise(header);
    for (const [canonical, aliases] of Object.entries(ALIASES)) {
      if (n === normalise(canonical) || aliases.includes(n)) {
        map[i] = canonical;
        return;
      }
    }
    map[i] = header.trim(); // preserve unknown columns in `raw`
  });
  return map;
}

// Note: no `Omit<RawRow, 'rowNumber'>` annotation — RawRow has an index
// signature, and Omit collapses that to the index signature alone.
const EMPTY = {
  employee_id: '',
  employee_name: '',
  department: '',
  date: '',
  clock_in: '',
  clock_out: '',
  hourly_rate: '',
};

export interface ParsedUpload {
  rows: RawRow[];
  format: 'csv' | 'json';
  headers: string[];
  /** Canonical fields that were not found in the header row at all. */
  missingColumns: string[];
}

export function parseUpload(content: Buffer | string, filename = 'upload.csv'): ParsedUpload {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  const trimmed = text.trim();
  if (!trimmed) throw new UploadParseError('The uploaded file is empty');

  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  return looksJson || filename.toLowerCase().endsWith('.json')
    ? parseJsonUpload(trimmed)
    : parseCsvUpload(text);
}

function parseCsvUpload(text: string): ParsedUpload {
  let records: string[][];
  try {
    records = parseCsv(text, {
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }) as string[][];
  } catch (e) {
    throw new UploadParseError('Could not parse the file as CSV', (e as Error).message);
  }
  if (!records.length) throw new UploadParseError('The uploaded file has no rows');

  const headers = records[0].map((h) => h.trim());
  const headerMap = buildHeaderMap(headers);
  const found = new Set(Object.values(headerMap));
  const missingColumns = Object.keys(ALIASES).filter((c) => !found.has(c));
  if (missingColumns.length === Object.keys(ALIASES).length) {
    throw new UploadParseError(
      'No recognisable timesheet columns found. Expected a header row with employee_id, employee_name, department, date, clock_in, clock_out, hourly_rate.',
      { headers },
    );
  }

  const rows: RawRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record.every((c) => String(c ?? '').trim() === '')) continue;
    const row: RawRow = { ...EMPTY, rowNumber: i + 1 };
    record.forEach((cell, col) => {
      const field = headerMap[col];
      if (field) row[field] = typeof cell === 'string' ? cell.trim() : cell;
    });
    rows.push(row);
  }
  return { rows, format: 'csv', headers, missingColumns };
}

function parseJsonUpload(text: string): ParsedUpload {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UploadParseError('Could not parse the file as JSON', (e as Error).message);
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.rows)
      ? (data as any).rows
      : null;
  if (!list) throw new UploadParseError('JSON uploads must be an array of row objects, or { "rows": [...] }');
  if (!list.length) throw new UploadParseError('The uploaded file has no rows');

  const headers = Object.keys(list[0] ?? {});
  const keyMap = new Map<string, string>();
  for (const key of new Set(list.flatMap((r: any) => Object.keys(r ?? {})))) {
    const n = normalise(String(key));
    const canonical = Object.entries(ALIASES).find(
      ([c, aliases]) => n === normalise(c) || aliases.includes(n),
    )?.[0];
    keyMap.set(String(key), canonical ?? String(key));
  }

  const rows: RawRow[] = list.map((item: any, i: number) => {
    const row: RawRow = { ...EMPTY, rowNumber: i + 1 };
    for (const [key, value] of Object.entries(item ?? {})) {
      const field = keyMap.get(key) ?? key;
      row[field] = value === null || value === undefined ? '' : String(value).trim();
    }
    return row;
  });

  const found = new Set(keyMap.values());
  return {
    rows,
    format: 'json',
    headers,
    missingColumns: Object.keys(ALIASES).filter((c) => !found.has(c)),
  };
}
