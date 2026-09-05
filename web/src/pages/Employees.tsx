import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading } from '../components/PageHeading';
import { Card, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { day, money, num } from '../lib/format';

interface Employee {
  employee_code: string;
  name: string;
  department: string;
}

export default function Employees() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [department, setDepartment] = useState('all');
  const [periods, setPeriods] = useState(3);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ employees: Employee[] }>('/api/employees'),
      api.get<{ departments: string[] }>('/api/departments'),
    ])
      .then(([e, d]) => {
        setEmployees(e.employees);
        setDepartments(d.departments);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ periods: String(periods) });
    if (department !== 'all') params.set('department', department);
    api
      .get<{ rows: any[] }>(`/api/reports/department-history?${params}`)
      .then((d) => setHistory(d.rows))
      .catch(() => setHistory([]));
  }, [department, periods]);

  const filtered = useMemo(() => {
    if (!employees) return [];
    const q = query.trim().toLowerCase();
    return employees.filter(
      (e) =>
        (department === 'all' || e.department === department) &&
        (!q || e.name.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q)),
    );
  }, [employees, query, department]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!employees)
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );

  return (
    <div className="space-y-6">
      <PageHeading title="Employees" subtitle="Everyone who has appeared in a processed timesheet." />

      <Card
        title="Department payroll history"
        subtitle="Payroll totals per department across the most recent pay periods"
        action={
          <div className="flex gap-2">
            <select
              className="input w-auto py-1.5 text-sm"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              aria-label="Department"
            >
              <option value="all">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              className="input w-auto py-1.5 text-sm"
              value={periods}
              onChange={(e) => setPeriods(Number(e.target.value))}
              aria-label="Number of pay periods"
            >
              {[1, 3, 6, 12].map((n) => (
                <option key={n} value={n}>
                  Last {n} period{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </div>
        }
        bodyClass="p-0"
      >
        {history.length === 0 ? (
          <EmptyState title="No completed pay runs" description="Process a timesheet to build the history." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-surface-line bg-surface-sunken">
                <tr>
                  <th className="th">Pay period</th>
                  <th className="th">Department</th>
                  <th className="th text-right">Employees</th>
                  <th className="th text-right">Regular</th>
                  <th className="th text-right">Overtime</th>
                  <th className="th text-right">Overtime pay</th>
                  <th className="th text-right">Gross pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-line">
                {history.map((r, i) => (
                  <tr key={`${r.job_id}-${r.department}-${i}`} className="hover:bg-surface-sunken/60">
                    <td className="td text-ink-soft">
                      {r.period_start ? `${day(r.period_start)} → ${day(r.period_end)}` : r.filename}
                    </td>
                    <td className="td font-medium">{r.department}</td>
                    <td className="td tnum text-right">{num(r.employees)}</td>
                    <td className="td tnum text-right">{num(r.regular_hours)}h</td>
                    <td className="td tnum text-right text-accent">{num(r.overtime_hours)}h</td>
                    <td className="td tnum text-right">{money(r.overtime_pay)}</td>
                    <td className="td tnum text-right font-semibold">{money(r.gross_pay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Directory"
        subtitle={`${num(filtered.length)} of ${num(employees.length)} employees`}
        action={
          <input
            className="input max-w-xs py-1.5 text-sm"
            placeholder="Search name or ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search employees"
          />
        }
        bodyClass="p-0"
      >
        {filtered.length === 0 ? (
          <EmptyState title="No employees found" description="Try a different search or department." />
        ) : (
          <ul className="grid gap-px bg-surface-line sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((e) => (
              <li key={e.employee_code} className="bg-white">
                <Link
                  to={`/employees/${encodeURIComponent(e.employee_code)}`}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                    {e.name
                      .split(' ')
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{e.name}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {e.employee_code} · {e.department}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
