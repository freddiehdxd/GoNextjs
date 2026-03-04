'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

export default function LoginPage() {
  const router   = useRouter();
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    const res = await api.post<{ token: string }>('/auth/login', creds);
    setLoading(false);
    if (res.success && res.data?.token) {
      setToken(res.data.token);
      router.replace('/dashboard');
    } else {
      setError(res.error ?? 'Login failed');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm card">
        <h1 className="mb-6 text-xl font-bold text-center text-white">Panel Login</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input
              className="input"
              value={creds.username}
              onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={creds.password}
              onChange={(e) => setCreds({ ...creds, password: e.target.value })}
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" className="btn-primary w-full justify-center" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
