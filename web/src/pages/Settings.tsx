import { useEffect, useState } from 'react';
import { Card, ErrorNote, Spinner, StatTile } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, duration, num, pct } from '../lib/format';
import { PageHeading } from './Dashboard';

export default function Settings() {
  const { organization, user, refresh } = useAuth();
  const [rules, setRules] = useState({ dailyThreshold: '8', weeklyThreshold: '40', multiplier: '1.5' });
  const [users, setUsers] = useState<any[]>([]);
  const [ops, setOps] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [invite, setInvite] = useState({
    name: '',
    email: '',
    password: '',
    role: 'employee',
    employeeCode: '',
  });

  useEffect(() => {
    if (organization) {
      setRules({
        dailyThreshold: String(organization.ot_daily_threshold),
        weeklyThreshold: String(organization.ot_weekly_threshold),
        multiplier: String(organization.ot_multiplier),
      });
    }
  }, [organization]);

  const loadUsers = () =>
    api
      .get<{ users: any[] }>('/api/auth/users')
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));

  useEffect(() => {
    void loadUsers();
    api.get<any>('/api/metrics/ops').then(setOps).catch(() => setOps(null));
    api
      .get<{ logs: any[] }>('/api/logs?limit=40')
      .then((d) => setLogs(d.logs))
      .catch(() => setLogs([]));
  }, []);

  const saveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.put('/api/organization/rules', {
        dailyThreshold: Number(rules.dailyThreshold),
        weeklyThreshold: Number(rules.weeklyThreshold),
        multiplier: Number(rules.multiplier),
      });
      await refresh();
      setMessage('Overtime rules saved. They apply to the next upload.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save rules');
    } finally {
      setBusy(false);
    }
  };

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.post('/api/auth/users', {
        ...invite,
        employeeCode: invite.employeeCode || null,
      });
      setInvite({ name: '', email: '', password: '', role: 'employee', employeeCode: '' });
      await loadUsers();
      setMessage('Account created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account');
    } finally {
      setBusy(false);
    }
  };

  const isAdmin = user?.role === 'admin';

  return (
    <div className="space-y-6">
      <PageHeading title="Settings" subtitle={organization?.name} />

      {error && <ErrorNote>{error}</ErrorNote>}
      {message && (
        <p className="rounded-lg bg-positive/10 px-3 py-2 text-sm text-[#0f7a55] ring-1 ring-inset ring-positive/20">
          {message}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Overtime rules" subtitle="Defaults for every new upload in this organisation">
          <form onSubmit={saveRules} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="daily">
                  Daily (h)
                </label>
                <input
                  id="daily"
                  type="number"
                  min={0}
                  max={24}
                  step={0.5}
                  className="input tnum"
                  value={rules.dailyThreshold}
                  onChange={(e) => setRules({ ...rules, dailyThreshold: e.target.value })}
                  disabled={!isAdmin}
                />
              </div>
              <div>
                <label className="label" htmlFor="weekly">
                  Weekly (h)
                </label>
                <input
                  id="weekly"
                  type="number"
                  min={0}
                  max={168}
                  className="input tnum"
                  value={rules.weeklyThreshold}
                  onChange={(e) => setRules({ ...rules, weeklyThreshold: e.target.value })}
                  disabled={!isAdmin}
                />
              </div>
              <div>
                <label className="label" htmlFor="mult">
                  Multiplier
                </label>
                <input
                  id="mult"
                  type="number"
                  min={1}
                  max={5}
                  step={0.1}
                  className="input tnum"
                  value={rules.multiplier}
                  onChange={(e) => setRules({ ...rules, multiplier: e.target.value })}
                  disabled={!isAdmin}
                />
              </div>
            </div>
            {isAdmin && (
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy && <Spinner />}
                Save rules
              </button>
            )}
          </form>
        </Card>

        <Card title="Engine" subtitle="How this deployment is wired up">
          {ops ? (
            <dl className="space-y-2.5 text-sm">
              <Row label="Database" value={ops.engine.dbDriver} />
              <Row label="Queue" value={ops.engine.queueDriver} />
              <Row label="Worker concurrency" value={num(ops.engine.workerConcurrency)} />
              <Row label="Simulated row cost" value={`${num(ops.engine.rowDelayMs)}ms`} />
              <Row label="Row retry attempts" value={num(ops.engine.rowMaxAttempts)} />
            </dl>
          ) : (
            <Spinner />
          )}
        </Card>
      </div>

      {ops && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Jobs processed" value={num(ops.jobs.completed)} hint={`${num(ops.jobs.total)} total`} />
          <StatTile
            label="Job failure rate"
            value={pct(ops.jobs.failureRatePct)}
            tone={ops.jobs.failed > 0 ? 'danger' : 'default'}
            hint={`${num(ops.jobs.failed)} failed`}
          />
          <StatTile
            label="Avg row processing"
            value={`${num(ops.rows.avgWallClockMsPerRow)}ms`}
            hint={`${num(ops.rows.avgCpuMsPerRow)}ms CPU · ${num(ops.rows.retries)} retries`}
          />
          <StatTile label="Avg job duration" value={duration(ops.jobs.avgDurationMs)} hint={`max ${duration(ops.jobs.maxDurationMs)}`} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Team" subtitle={`${num(users.length)} accounts`} bodyClass="p-0">
          <table className="w-full">
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">Name</th>
                <th className="th">Role</th>
                <th className="th">Employee ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="td">
                    <span className="font-medium">{u.name}</span>
                    <p className="text-xs text-ink-muted">{u.email}</p>
                  </td>
                  <td className="td capitalize text-ink-soft">{u.role}</td>
                  <td className="td font-mono text-xs text-ink-soft">{u.employee_code ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {isAdmin && (
          <Card title="Add a team member" subtitle="Link an employee ID to give someone their own payslip view">
            <form onSubmit={addUser} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="u-name">
                    Name
                  </label>
                  <input id="u-name" required className="input" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="u-email">
                    Email
                  </label>
                  <input id="u-email" type="email" required className="input" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="u-pass">
                    Temporary password
                  </label>
                  <input id="u-pass" type="password" required minLength={8} className="input" value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="u-role">
                    Role
                  </label>
                  <select id="u-role" className="input" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                    <option value="employee">Employee — own payslip only</option>
                    <option value="hr">HR — upload and view everyone</option>
                    <option value="admin">Admin — full access</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label" htmlFor="u-code">
                  Employee ID {invite.role === 'employee' ? '(required for payslip access)' : '(optional)'}
                </label>
                <input id="u-code" className="input" placeholder="EMP-101" value={invite.employeeCode} onChange={(e) => setInvite({ ...invite, employeeCode: e.target.value })} />
              </div>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy && <Spinner />}
                Create account
              </button>
            </form>
          </Card>
        )}
      </div>

      <Card title="Recent system events" subtitle="Structured log entries across the organisation" bodyClass="p-0">
        <ol className="divide-y divide-surface-line">
          {logs.map((log) => (
            <li key={log.id} className="flex flex-wrap items-baseline gap-x-3 px-5 py-2.5 text-sm">
              <span className="tnum w-40 shrink-0 text-xs text-ink-muted">{dateTime(log.created_at)}</span>
              <span
                className={`w-12 shrink-0 text-xs font-semibold uppercase ${
                  log.level === 'error' ? 'text-[#a92f2e]' : log.level === 'warn' ? 'text-[#8a5f00]' : 'text-ink-muted'
                }`}
              >
                {log.level}
              </span>
              <span className="w-48 shrink-0 font-mono text-xs text-brand-600">{log.event}</span>
              <span className="min-w-0 flex-1 text-ink">{log.message}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}
