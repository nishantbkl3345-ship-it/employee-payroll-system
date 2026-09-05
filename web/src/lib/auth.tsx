import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: 'admin' | 'hr' | 'employee';
  employeeCode: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ot_daily_threshold: number;
  ot_weekly_threshold: number;
  ot_multiplier: number;
}

interface AuthState {
  user: User | null;
  organization: Organization | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: {
    organizationName: string;
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  canManage: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setOrganization(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get<{ user: User; organization: Organization }>('/api/auth/me');
      setUser(data.user);
      setOrganization(data.organization);
    } catch {
      setToken(null);
      setUser(null);
      setOrganization(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      setUser(null);
      setOrganization(null);
    };
    window.addEventListener('payroll:unauthorized', onUnauthorized);
    return () => window.removeEventListener('payroll:unauthorized', onUnauthorized);
  }, [refresh]);

  const apply = (data: { token: string; user: User; organization: Organization }) => {
    setToken(data.token);
    setUser(data.user);
    setOrganization(data.organization);
    setLoading(false);
  };

  const value = useMemo<AuthState>(
    () => ({
      user,
      organization,
      loading,
      canManage: user?.role === 'admin' || user?.role === 'hr',
      login: async (email, password) => {
        apply(await api.post('/api/auth/login', { email, password }));
      },
      signup: async (input) => {
        apply(await api.post('/api/auth/signup', input));
      },
      logout: () => {
        setToken(null);
        setUser(null);
        setOrganization(null);
      },
      refresh,
    }),
    [user, organization, loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
