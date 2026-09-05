import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Card, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * The employee-role landing page. It resolves the signed-in user's linked
 * employee record, then reuses the same detail view HR sees for one person.
 */
export default function MyPayslip() {
  const { user } = useAuth();
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.employeeCode) {
      setState('none');
      return;
    }
    api
      .get('/api/me/payslip')
      .then(() => setState('ready'))
      .catch((e) => {
        setError(e.message);
        setState('none');
      });
  }, [user?.employeeCode]);

  if (state === 'loading')
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );

  if (state === 'none') {
    return (
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        <Card>
          <EmptyState
            title="No payslip available yet"
            description={
              user?.employeeCode
                ? 'Your organisation has not processed a payroll run that includes you yet.'
                : 'Your account is not linked to an employee record. Ask an admin to link your employee ID.'
            }
          />
        </Card>
      </div>
    );
  }

  return <Navigate to={`/employees/${encodeURIComponent(user!.employeeCode!)}`} replace />;
}
