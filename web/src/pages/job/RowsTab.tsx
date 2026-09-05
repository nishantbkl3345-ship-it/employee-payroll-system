import { useEffect, useState } from 'react';
import { Badge, Card, EmptyState, Pager, TableSkeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { day, hours, money, num } from '../../lib/format';

const PAGE_SIZE = 25;
const STATUS_FILTERS = ['all', 'valid', 'invalid', 'duplicate'] as const;

interface TimesheetRow {
  row_number: number;
  employee_code: string | null;
  employee_name: string | null;
  department: string | null;
  work_date: string | null;
  clock_in: string | null;
  clock_out: string | null;
  status: 'valid' | 'invalid' | 'duplicate';
  errors: Array<{ code: string; message: string }> | string;
  hours_worked: number;
  regular_hours: number;
  overtime_hours: number;
  gross_pay: number;
}

const errorsOf = (row: TimesheetRow) =>
  Array.isArray(row.errors) ? row.errors : JSON.parse(row.errors || '[]');

export default function RowsTab({ jobId }: { jobId: string }) {
  const [rows, setRows] = useState<TimesheetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (status !== 'all') params.set('status', status);
    if (search) params.set('q', search);

    const timer = setTimeout(() => {
      api
        .get<{ rows: TimesheetRow[]; total: number }>(`/api/jobs/${jobId}/rows?${params}`)
        .then((result) => {
          setRows(result.rows);
          setTotal(result.total);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [jobId, status, search, page]);

  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-line p-4">
        {STATUS_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setStatus(option);
              setPage(0);
            }}
            aria-pressed={status === option}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              status === option ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-surface-sunken'
            }`}
          >
            {option}
          </button>
        ))}
        <input
          className="input ml-auto max-w-xs"
          placeholder="Search employee, ID or department…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          aria-label="Search rows"
        />
      </div>

      {loading && !rows.length ? (
        <TableSkeleton rows={6} columns={6} />
      ) : !rows.length ? (
        <EmptyState title="No rows" description="Nothing matched this filter." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <caption className="sr-only">Uploaded rows and their validation verdict</caption>
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">#</th>
                <th className="th">Employee</th>
                <th className="th">Date</th>
                <th className="th">Shift</th>
                <th className="th text-right">Hours</th>
                <th className="th text-right">Reg / OT</th>
                <th className="th text-right">Gross</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {rows.map((row) => {
                const errors = errorsOf(row);
                return (
                  <tr key={row.row_number} className="align-top hover:bg-surface-sunken/60">
                    <td className="td tnum text-ink-muted">{row.row_number}</td>
                    <td className="td">
                      <span className="font-medium">{row.employee_name || '—'}</span>
                      <span className="ml-2 text-xs text-ink-muted">{row.employee_code}</span>
                      <p className="text-xs text-ink-muted">{row.department}</p>
                    </td>
                    <td className="td text-ink-soft">{day(row.work_date)}</td>
                    <td className="td tnum text-ink-soft">
                      {row.clock_in ?? '—'} → {row.clock_out ?? '—'}
                    </td>
                    <td className="td tnum text-right">
                      {row.status === 'valid' ? hours(row.hours_worked) : '—'}
                    </td>
                    <td className="td tnum text-right text-ink-soft">
                      {row.status === 'valid'
                        ? `${num(row.regular_hours)} / ${num(row.overtime_hours)}`
                        : '—'}
                    </td>
                    <td className="td tnum text-right">
                      {row.status === 'valid' ? money(row.gross_pay) : '—'}
                    </td>
                    <td className="td">
                      <Badge tone={row.status}>{row.status}</Badge>
                      {errors.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {errors.map((error: { code: string; message: string }) => (
                            <li key={error.code} className="max-w-xs whitespace-normal text-xs text-ink-soft">
                              <span className="font-mono text-[11px] font-medium text-[#a92f2e]">
                                {error.code}
                              </span>{' '}
                              {error.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </Card>
  );
}
