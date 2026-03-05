import { useState, FormEvent } from 'react';
import { Server, Lock, User, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';

export default function Login() {
  const [creds, setCreds]   = useState({ username: '', password: '' });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    const res = await api.post<{ message: string }>('/auth/login', creds);
    if (res.success) {
      window.location.href = '/dashboard';
      return;
    }
    setLoading(false);
    setError(res.error ?? 'Invalid credentials');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#080810] relative overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[500px] rounded-full opacity-[0.06]"
          style={{ background: 'radial-gradient(circle, #8b5cf6 0%, transparent 70%)' }} />
        <div className="absolute left-1/4 bottom-1/4 h-[300px] w-[300px] rounded-full opacity-[0.04]"
          style={{ background: 'radial-gradient(circle, #3b82f6 0%, transparent 70%)' }} />
      </div>

      <div className="relative w-full max-w-md px-6">
        {/* Logo */}
        <div className="flex flex-col items-center mb-10">
          <div className="h-14 w-14 rounded-2xl flex items-center justify-center mb-5 shadow-lg shadow-violet-500/20"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', border: '1px solid rgba(139,92,246,0.3)' }}>
            <Server size={26} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">ServerPanel</h1>
          <p className="text-sm text-gray-500 mt-1.5">Self-hosted deployment platform</p>
        </div>

        {/* Card */}
        <div className="glass p-8"
          style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.05), 0 24px 48px -12px rgba(0,0,0,0.6)' }}>
          <h2 className="text-base font-semibold text-white mb-6">Sign in to your panel</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Username</label>
              <div className="relative">
                <User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
                <input
                  className="input pl-10"
                  placeholder="Enter username"
                  value={creds.username}
                  onChange={(e) => setCreds({ ...creds, username: e.target.value })}
                  autoFocus
                  autoComplete="username"
                />
              </div>
            </div>

            <div>
              <label className="label">Password</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-600 pointer-events-none" />
                <input
                  type={showPw ? 'text' : 'password'}
                  className="input pl-10 pr-10"
                  placeholder="Enter password"
                  value={creds.password}
                  onChange={(e) => setCreds({ ...creds, password: e.target.value })}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full justify-center mt-2"
              disabled={loading || !creds.username || !creds.password}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Signing in...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Sign in <ArrowRight size={15} />
                </span>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-700 mt-6">
          ServerPanel &mdash; Self-hosted deployment platform
        </p>
      </div>
    </div>
  );
}
