import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import Dashboard from './pages/Dashboard';
import EmployeeDetail from './pages/EmployeeDetail';
import Employees from './pages/Employees';
import JobDetail from './pages/JobDetail';
import Jobs from './pages/Jobs';
import Login from './pages/Login';
import MyPayslip from './pages/MyPayslip';
import Settings from './pages/Settings';
import Signup from './pages/Signup';
import Upload from './pages/Upload';

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center text-ink-soft">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

function Protected({ children, manageOnly = false }: { children: ReactElement; manageOnly?: boolean }) {
  const { user, loading, canManage } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (manageOnly && !canManage) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={loading ? <FullPageSpinner /> : user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={loading ? <FullPageSpinner /> : user ? <Navigate to="/" replace /> : <Signup />} />

      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/upload" element={<Protected manageOnly><Upload /></Protected>} />
      <Route path="/jobs" element={<Protected><Jobs /></Protected>} />
      <Route path="/jobs/:id" element={<Protected><JobDetail /></Protected>} />
      <Route path="/employees" element={<Protected><Employees /></Protected>} />
      <Route path="/employees/:code" element={<Protected><EmployeeDetail /></Protected>} />
      <Route path="/my-payslip" element={<Protected><MyPayslip /></Protected>} />
      <Route path="/settings" element={<Protected manageOnly><Settings /></Protected>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
