import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorNote, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  const useDemo = () => {
    setEmail('admin@demo.io');
    setPassword('password123');
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-500 text-base font-bold text-white">
            P
          </span>
          <div>
            <h1 className="text-base font-semibold text-ink">Timesheet &amp; Payroll</h1>
            <p className="text-xs text-ink-muted">Sign in to your organisation</p>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          {error && <ErrorNote>{error}</ErrorNote>}

          <div>
            <label className="label" htmlFor="email">
              Work email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy && <Spinner />}
            Sign in
          </button>

          <button type="button" className="btn-ghost w-full text-xs" onClick={useDemo}>
            Use the seeded demo account
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-ink-soft">
          New here?{' '}
          <Link to="/signup" className="font-medium text-brand-600 hover:text-brand-700">
            Create an organisation
          </Link>
        </p>
      </div>
    </div>
  );
}
