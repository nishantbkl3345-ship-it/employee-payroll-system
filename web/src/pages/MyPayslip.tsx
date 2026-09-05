import { Navigate } from 'react-router-dom';
import { Card, EmptyState } from '../components/ui';
import { useAuth } from '../lib/auth';

/**
 * Landing page for the employee role. Their payslip is the same detail view HR
 * sees for one person, so this only resolves which employee that is.
 */
export default function MyPayslip() {
  const { user } = useAuth();

  if (user?.employeeCode) {
    return <Navigate to={`/employees/${encodeURIComponent(user.employeeCode)}`} replace />;
  }

  return (
    <Card>
      <EmptyState
        title="No payslip available yet"
        description="This account is not linked to an employee record. Ask an admin to add your employee ID."
      />
    </Card>
  );
}
