/**
 * Deterministic sample-data generator.
 *
 *   npm run -w server generate            -> samples/timesheet_two_weeks.csv (~600 rows)
 *   npm run -w server generate -- 10000   -> samples/timesheet_10k.csv (load test)
 *
 * The data deliberately contains the same classes of defect as the brief:
 * duplicates, reversed clock times, negative rates, future dates, overlapping
 * shifts and missing fields — roughly 4% of rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

/** Mulberry32 — small, fast, seeded PRNG so output is reproducible. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Sara', 'Karan', 'Neha', 'Vikram', 'Priya', 'Arjun', 'Ananya', 'Rohit', 'Meera', 'Dev', 'Isha', 'Kabir', 'Tara', 'Nikhil', 'Aditi', 'Farah', 'Omar', 'Leah', 'Ravi', 'Zoya'];
const LAST = ['Iyer', 'Bhatt', 'Joshi', 'Das', 'Nair', 'Rao', 'Sharma', 'Menon', 'Kapoor', 'Reddy', 'Khan', 'Bose', 'Gupta', 'Sethi', 'Patel'];
const DEPARTMENTS = [
  { name: 'Engineering', rate: [32, 46], otBias: 0.35 },
  { name: 'Support', rate: [17, 24], otBias: 0.55 },
  { name: 'Sales', rate: [20, 30], otBias: 0.25 },
  { name: 'Operations', rate: [19, 27], otBias: 0.4 },
  { name: 'Finance', rate: [28, 38], otBias: 0.12 },
];

const pad = (n: number) => String(n).padStart(2, '0');
/** Rounds to whole minutes first, so 8.999h never renders as "08:60". */
const hhmm = (hours: number) => {
  const total = Math.round(hours * 60);
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
};

function workdays(startISO: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startISO}T00:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function generate(targetRows: number, seed = 20250113): string {
  const rand = rng(seed);
  const days = workdays('2025-01-06', 10); // two full ISO weeks
  const headcount = Math.max(5, Math.ceil(targetRows / days.length));

  const employees = Array.from({ length: headcount }, (_, i) => {
    const dept = DEPARTMENTS[i % DEPARTMENTS.length];
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    return {
      code: `EMP-${String(101 + i).padStart(4, '0')}`,
      name: `${first} ${last}`,
      department: dept.name,
      rate: (dept.rate[0] + rand() * (dept.rate[1] - dept.rate[0])).toFixed(2),
      otBias: dept.otBias,
    };
  });

  const lines: string[][] = [];
  for (const day of days) {
    for (const emp of employees) {
      if (lines.length >= targetRows) break;
      if (rand() < 0.06) continue; // day off

      const start = 8 + Math.floor(rand() * 3) * 0.5; // 08:00 - 09:00
      const base = 7.5 + rand() * 1.5;
      const overtime = rand() < emp.otBias ? 1 + rand() * 4 : 0;
      const length = Math.min(14, base + overtime);

      lines.push([
        emp.code,
        emp.name,
        emp.department,
        day,
        hhmm(start),
        hhmm(start + length),
        emp.rate,
      ]);
    }
  }

  // --- inject defects (~4% of rows), deterministically placed ---
  const defects = Math.max(6, Math.round(lines.length * 0.04));
  for (let i = 0; i < defects; i++) {
    const idx = Math.floor(rand() * lines.length);
    const row = lines[idx];
    switch (i % 6) {
      case 0: // exact duplicate
        lines.splice(Math.min(idx + 1, lines.length), 0, [...row]);
        break;
      case 1: // clock_out before clock_in
        lines[idx] = [...row.slice(0, 4), '10:00', '09:30', row[6]];
        break;
      case 2: // negative rate
        lines[idx] = [...row.slice(0, 6), `-${row[6]}`];
        break;
      case 3: // future date
        lines[idx] = [...row.slice(0, 3), '2099-01-01', ...row.slice(4)];
        break;
      case 4: // missing department
        lines[idx] = [row[0], row[1], '', ...row.slice(3)];
        break;
      case 5: {
        // overlapping second shift on the same day
        const overlap = [...row];
        const startHour = Number(row[4].slice(0, 2));
        overlap[4] = hhmm(startHour + 1);
        overlap[5] = hhmm(startHour + 6);
        lines.splice(Math.min(idx + 1, lines.length), 0, overlap);
        break;
      }
    }
  }

  const header = 'employee_id,employee_name,department,date,clock_in,clock_out,hourly_rate';
  return [header, ...lines.map((l) => l.join(','))].join('\n') + '\n';
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const rows = Number(process.argv[2] ?? 600);
  const csv = generate(rows);
  const name = rows > 2000 ? `timesheet_${Math.round(rows / 1000)}k.csv` : 'timesheet_two_weeks.csv';
  const dir = path.join(ROOT, 'samples');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, csv, 'utf8');
  console.log(`wrote ${file} (${csv.split('\n').length - 2} data rows)`);
}
