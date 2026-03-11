import { Routes, Route, Navigate } from 'react-router-dom';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';

import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Apps from '@/pages/Apps';
import AppDetail from '@/pages/AppDetail';
import Domains from '@/pages/Domains';
import SSL from '@/pages/SSL';
import Databases from '@/pages/Databases';
import Redis from '@/pages/Redis';
import Files from '@/pages/Files';
import Logs from '@/pages/Logs';
import Services from '@/pages/Services';
import Settings from '@/pages/Settings';
import AuditLog from '@/pages/AuditLog';
import NotFound from '@/pages/NotFound';

// ── Auth Context ────────────────────────────────────────────────────────────

interface AuthState {
  authed: boolean | null;
  username: string | null;
  revalidate: () => void;
}

const AuthContext = createContext<AuthState>({
  authed: null,
  username: null,
  revalidate: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState(0);

  const checkAuth = useCallback(async (force = false) => {
    // Skip if we checked recently and not forcing
    if (!force && authed !== null && Date.now() - lastCheck < AUTH_CACHE_TTL) {
      return;
    }

    try {
      const res = await api.get<{ username: string }>('/auth/me');
      if (res.success && res.data) {
        setAuthed(true);
        setUsername(res.data.username);
      } else {
        setAuthed(false);
        setUsername(null);
      }
    } catch {
      // Network error — keep current auth state if we had one, otherwise mark as not authed
      if (authed === null) {
        setAuthed(false);
      }
    }
    setLastCheck(Date.now());
  }, [authed, lastCheck]);

  useEffect(() => {
    checkAuth(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider value={{ authed, username, revalidate: () => checkAuth(true) }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Protected Route ─────────────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { authed } = useAuth();

  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080810]">
        <span className="h-5 w-5 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
      </div>
    );
  }

  if (!authed) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/apps" element={<ProtectedRoute><Apps /></ProtectedRoute>} />
        <Route path="/apps/:name" element={<ProtectedRoute><AppDetail /></ProtectedRoute>} />
        <Route path="/domains" element={<ProtectedRoute><Domains /></ProtectedRoute>} />
        <Route path="/ssl" element={<ProtectedRoute><SSL /></ProtectedRoute>} />
        <Route path="/databases" element={<ProtectedRoute><Databases /></ProtectedRoute>} />
        <Route path="/redis" element={<ProtectedRoute><Redis /></ProtectedRoute>} />
        <Route path="/services" element={<ProtectedRoute><Services /></ProtectedRoute>} />
        <Route path="/files" element={<ProtectedRoute><Files /></ProtectedRoute>} />
        <Route path="/logs" element={<ProtectedRoute><Logs /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="/audit" element={<ProtectedRoute><AuditLog /></ProtectedRoute>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
