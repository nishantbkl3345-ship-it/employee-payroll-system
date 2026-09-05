import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useJobStream } from '../lib/useJobStream';

const NAV = [
  { to: '/', label: 'Dashboard', end: true, manage: false },
  { to: '/upload', label: 'Upload', end: false, manage: true },
  { to: '/jobs', label: 'Pay runs', end: false, manage: false },
  { to: '/employees', label: 'Employees', end: false, manage: false },
  { to: '/my-payslip', label: 'My payslip', end: false, manage: false },
  { to: '/settings', label: 'Settings', end: false, manage: true },
];

function LiveDot({ live }: { live: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted" title={live ? 'Live updates connected' : 'Polling for updates'}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-positive' : 'bg-warn'}`}
        aria-hidden="true"
      />
      {live ? 'Live' : 'Polling'}
    </span>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, organization, logout } = useAuth();
  const navigate = useNavigate();
  const { live } = useJobStream();
  const [open, setOpen] = useState(false);

  const canManage = user?.role === 'admin' || user?.role === 'hr';
  const items = NAV.filter((item) => {
    if (item.manage && !canManage) return false;
    if (item.to === '/my-payslip' && canManage) return false;
    return true;
  });

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-surface-sunken hover:text-ink'
    }`;

  return (
    <div className="min-h-screen">
      <header className="no-print sticky top-0 z-20 border-b border-surface-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3 sm:px-6">
          <button
            type="button"
            className="btn-ghost -ml-2 px-2 lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z" />
            </svg>
          </button>

          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-sm font-bold text-white">
              P
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-ink">{organization?.name ?? 'Payroll'}</p>
              <p className="text-xs text-ink-muted">Timesheet &amp; payroll</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-4">
            <LiveDot live={live} />
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium text-ink">{user?.name}</p>
              <p className="text-xs capitalize text-ink-muted">
                {user?.role}
                {user?.employeeCode ? ` · ${user.employeeCode}` : ''}
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1400px] gap-6 px-4 py-6 sm:px-6">
        <nav
          className={`no-print w-52 shrink-0 lg:block ${open ? 'block' : 'hidden'} ${
            open ? 'fixed inset-x-4 top-16 z-20 rounded-xl border border-surface-line bg-white p-2 shadow-card lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none' : ''
          }`}
        >
          <ul className="space-y-1 lg:sticky lg:top-20">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end} className={linkClass} onClick={() => setOpen(false)}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
