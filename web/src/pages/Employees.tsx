import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading } from '../components/PageHeading';
import { Card, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { day, money, num } from '../lib/format';

const PERIOD_OPTIONS = [1, 3, 6, 12];

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
      .then(([directory, departmentList]) => {
        setEmployees(directory.employees);
        setDepartments(departmentList.departments);
      })
      .catch((caught) => setError(caught.message));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ periods: String(periods) });
    if (department !== 'all') params.set('department', department);
    api
      .get<{ rows: any[] }>(`/api/reports/department-history?${params}`)
      .then((result) => setHistory(result.rows))
      .catch(() => setHistory([]));
  }, [department, periods]);

  const filtered = useMemo(() => {
    if (!employees) return [];
    const search = query.trim().toLowerCase();
    return employees.filter(
      (employee) =>
        (department === 'all' || employee.department === department) &&
        (!search ||
          employee.name.toLowerCase().includes(search) ||
          employee.employee_code.toLowerCase().includes(search)),
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
              {departments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              className="input w-auto py-1.5 text-sm"
              value={periods}
              onChange={(e) => setPeriods(Number(e.target.value))}
              aria-label="Number of pay periods"
            >
              {PERIOD_OPTIONS.map((count) => (
                <option key={count} value={count}>
                  Last {count} period{count === 1 ? '' : 's'}
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
                {history.map((period) => (
                  <tr
                    key={`${period.job_id}-${period.department}`}
                    className="hover:bg-surface-sunken/60"
                  >
                    <td className="td text-ink-soft">
                      {period.period_start
                        ? `${day(period.period_start)} → ${day(period.period_end)}`
                        : period.filename}
                    </td>
                    <td className="td font-medium">{period.department}</td>
                    <td className="td tnum text-right">{num(period.employees)}</td>
                    <td className="td tnum text-right">{num(period.regular_hours)}h</td>
                    <td className="td tnum text-right text-accent">{num(period.overtime_hours)}h</td>
                    <td className="td tnum text-right">{money(period.overtime_pay)}</td>
                    <td className="td tnum text-right font-semibold">{money(period.gross_pay)}</td>
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
            {filtered.map((employee) => (
              <li key={employee.employee_code} className="bg-white">
                <Link
                  to={`/employees/${encodeURIComponent(employee.employee_code)}`}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-sunken"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                    {employee.name
                      .split(' ')
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{employee.name}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {employee.employee_code} · {employee.department}
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
