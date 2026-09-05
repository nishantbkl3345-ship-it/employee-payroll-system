import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorNote, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ organizationName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signup({ ...form, email: form.email.trim() });
      navigate('/upload');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-base font-semibold text-ink">Create your organisation</h1>
          <p className="mt-1 text-sm text-ink-soft">
            You become the admin. Timesheets and payroll stay private to this organisation.
          </p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          {error && <ErrorNote>{error}</ErrorNote>}

          <div>
            <label className="label" htmlFor="org">
              Organisation name
            </label>
            <input id="org" required className="input" value={form.organizationName} onChange={set('organizationName')} placeholder="Northwind Labs" />
          </div>

          <div>
            <label className="label" htmlFor="name">
              Your name
            </label>
            <input id="name" required className="input" value={form.name} onChange={set('name')} placeholder="Alex Admin" />
          </div>

          <div>
            <label className="label" htmlFor="email">
              Work email
            </label>
            <input id="email" type="email" required className="input" value={form.email} onChange={set('email')} placeholder="you@company.com" />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="input"
              value={form.password}
              onChange={set('password')}
              placeholder="At least 8 characters"
            />
          </div>

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy && <Spinner />}
            Create organisation
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-soft">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
