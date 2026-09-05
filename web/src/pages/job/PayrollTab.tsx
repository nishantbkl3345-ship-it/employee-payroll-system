import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, Pager, SortHeader, TableSkeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { hours, money, num } from '../../lib/format';

const PAGE_SIZE = 25;

interface PayrollLine {
  employee_code: string;
  employee_name: string;
  department: string;
  days_worked: number;
  regular_hours: number;
  overtime_hours: number;
  hourly_rate: number;
  gross_pay: number;
}

export default function PayrollTab({
  jobId,
  departments,
  canManage,
  onPayrollChanged,
}: {
  jobId: string;
  departments: string[];
  canManage: boolean;
  onPayrollChanged: () => void;
}) {
  const [lines, setLines] = useState<PayrollLine[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('all');
  const [sort, setSort] = useState('gross');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      sort,
      dir,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (search) params.set('q', search);
    if (department !== 'all') params.set('department', department);

    // Debounced so typing in the search box does not fire a request per keystroke.
    const timer = setTimeout(() => {
      api
        .get<{ rows: PayrollLine[]; total: number }>(`/api/jobs/${jobId}/payroll?${params}`)
        .then((result) => {
          setLines(result.rows);
          setTotal(result.total);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [jobId, sort, dir, page, search, department, reloadCount]);

  const sortBy = (field: string) => {
    if (field === sort) {
      setDir(dir === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(field);
      setDir('desc');
    }
    setPage(0);
  };

  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-surface-line p-4">
        <input
          className="input max-w-xs"
          placeholder="Search employee or ID…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          aria-label="Search payroll"
        />
        <select
          className="input max-w-[200px]"
          value={department}
          onChange={(event) => {
            setDepartment(event.target.value);
            setPage(0);
          }}
          aria-label="Filter by department"
        >
          <option value="all">All departments</option>
          {departments.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-ink-soft">
          {loading ? 'Loading…' : `${num(total)} employee${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {loading && !lines.length ? (
        <TableSkeleton rows={6} columns={7} />
      ) : !lines.length ? (
        <EmptyState
          title="No payroll lines"
          description="Nothing matched this filter, or the pay run has no valid rows."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <caption className="sr-only">Payroll by employee</caption>
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <SortHeader label="Employee" field="employee" sort={sort} dir={dir} onSort={sortBy} />
                <SortHeader label="Department" field="department" sort={sort} dir={dir} onSort={sortBy} />
                <SortHeader label="Days" field="days" sort={sort} dir={dir} onSort={sortBy} align="right" />
                <SortHeader label="Regular" field="regular" sort={sort} dir={dir} onSort={sortBy} align="right" />
                <SortHeader label="Overtime" field="overtime" sort={sort} dir={dir} onSort={sortBy} align="right" />
                <SortHeader label="Rate" field="rate" sort={sort} dir={dir} onSort={sortBy} align="right" />
                <SortHeader label="Gross pay" field="gross" sort={sort} dir={dir} onSort={sortBy} align="right" />
                {canManage && <th className="th" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {lines.map((line) => (
                <PayrollRow
                  key={line.employee_code}
                  jobId={jobId}
                  line={line}
                  canManage={canManage}
                  onSaved={() => {
                    setReloadCount((count) => count + 1);
                    onPayrollChanged();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </Card>
  );
}

function PayrollRow({
  jobId,
  line,
  canManage,
  onSaved,
}: {
  jobId: string;
  line: PayrollLine;
  canManage: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(String(line.hourly_rate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const hourlyRate = Number(rate);
    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      setError('Enter a rate above zero');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/jobs/${jobId}/employees/${encodeURIComponent(line.employee_code)}/rate`, {
        hourlyRate,
      });
      setEditing(false);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the rate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="hover:bg-surface-sunken/60">
      <td className="td">
        <Link
          to={`/employees/${encodeURIComponent(line.employee_code)}?jobId=${jobId}`}
          className="font-medium text-brand-600 hover:text-brand-700"
        >
          {line.employee_name}
        </Link>
        <span className="ml-2 text-xs text-ink-muted">{line.employee_code}</span>
      </td>
      <td className="td text-ink-soft">{line.department}</td>
      <td className="td tnum text-right">{num(line.days_worked)}</td>
      <td className="td tnum text-right">{hours(line.regular_hours)}</td>
      <td className="td tnum text-right">
        {line.overtime_hours > 0 ? (
          <span className="font-medium text-accent">{hours(line.overtime_hours)}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </td>
      <td className="td tnum text-right">
        {editing ? (
          <input
            className="input w-24 py-1 text-right"
            type="number"
            min={0.01}
            step={0.5}
            autoFocus
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') setEditing(false);
            }}
            aria-label={`Hourly rate for ${line.employee_name}`}
          />
        ) : (
          money(line.hourly_rate)
        )}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </td>
      <td className="td tnum text-right font-semibold">{money(line.gross_pay)}</td>
      {canManage && (
        <td className="td text-right">
          {editing ? (
            <span className="flex justify-end gap-1">
              <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={saving} onClick={save}>
                Save
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                setRate(String(line.hourly_rate));
                setEditing(true);
              }}
              title="Correct this rate and re-run payroll"
            >
              Fix rate
            </button>
          )}
        </td>
      )}
    </tr>
  );
}
