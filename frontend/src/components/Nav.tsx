import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearToken } from '@/lib/api';
import {
  LayoutDashboard, Server, Globe, ShieldCheck, Database,
  FolderOpen, FileText, Cpu, LogOut, Search, ChevronRight,
  Zap, X, Command, Settings, Wrench, ScrollText,
} from 'lucide-react';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard',  icon: LayoutDashboard, color: 'text-violet-400'  },
  { href: '/apps',      label: 'Apps',        icon: Server,           color: 'text-blue-400'    },
  { href: '/domains',   label: 'Domains',     icon: Globe,            color: 'text-cyan-400'    },
  { href: '/ssl',       label: 'SSL',         icon: ShieldCheck,      color: 'text-emerald-400' },
  { href: '/databases', label: 'Databases',   icon: Database,         color: 'text-amber-400'   },
  { href: '/redis',     label: 'Redis',       icon: Cpu,              color: 'text-red-400'     },
  { href: '/services',  label: 'Services',    icon: Wrench,           color: 'text-teal-400'    },
  { href: '/files',     label: 'Files',       icon: FolderOpen,       color: 'text-orange-400'  },
  { href: '/logs',      label: 'Logs',        icon: FileText,         color: 'text-pink-400'    },
  { href: '/audit',     label: 'Audit Log',   icon: ScrollText,       color: 'text-sky-400'     },
  { href: '/settings',  label: 'Settings',    icon: Settings,         color: 'text-gray-400'    },
];

export default function Nav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [search,     setSearch]     = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') { setShowSearch(false); setSearch(''); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const filtered = NAV_LINKS.filter((l) =>
    l.label.toLowerCase().includes(search.toLowerCase())
  );

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* best effort */ }
    clearToken();
    navigate('/login');
  }
  function goTo(href: string) { setShowSearch(false); setSearch(''); navigate(href); }

  return (
    <>
      <aside className="fixed left-0 top-0 h-screen w-60 flex flex-col z-40"
        style={{ background: 'rgba(8,8,16,0.97)', borderRight: '1px solid rgba(255,255,255,0.06)', backdropFilter: 'blur(20px)' }}>

        {/* Logo */}
        <div className="flex items-center gap-3 px-5 h-16 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 shadow-lg" style={{ boxShadow: '0 0 20px rgba(139,92,246,0.4)' }}>
            <Zap size={16} className="text-white" />
          </div>
          <div>
            <span className="text-sm font-bold text-white tracking-tight">ServerPanel</span>
            <span className="block text-[10px] text-gray-500 leading-none mt-0.5">Control Center</span>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pt-4 pb-2 shrink-0">
          <button
            onClick={() => { setShowSearch(true); setTimeout(() => searchRef.current?.focus(), 50); }}
            className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs text-gray-400 hover:text-gray-200 transition-all duration-200"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <Search size={13} />
            <span className="flex-1 text-left">Search...</span>
            <span className="flex items-center gap-0.5 text-[10px] font-mono opacity-50">
              <Command size={9} />K
            </span>
          </button>
        </div>

        {/* Links */}
        <nav className="flex-1 overflow-y-auto px-3 py-1 space-y-0.5">
          <p className="px-3 pt-3 pb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Menu</p>
          {NAV_LINKS.map(({ href, label, icon: Icon, color }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link key={href} to={href}
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150
                  ${active ? 'text-white' : 'text-gray-300 hover:text-white'}`}
                style={active ? {
                  background: 'rgba(139,92,246,0.12)',
                  border: '1px solid rgba(139,92,246,0.2)',
                } : {
                  border: '1px solid transparent',
                }}
              >
                <Icon size={15} className={active ? 'text-violet-400' : `${color} opacity-80 group-hover:opacity-100 transition-opacity`} />
                <span className="flex-1">{label}</span>
                {active && <ChevronRight size={11} className="text-violet-500/50" />}
              </Link>
            );
          })}
        </nav>

        {/* User */}
        <div className="shrink-0 p-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-3 px-3 py-2.5 mb-0.5 rounded-xl">
            <div className="h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold text-violet-400 shrink-0"
              style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)' }}>A</div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-300 truncate">Admin</p>
              <p className="text-[10px] text-gray-500">Super User</p>
            </div>
          </div>
          <button onClick={logout}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2 text-xs text-gray-400 hover:text-red-400 transition-all duration-200 hover:bg-red-500/5">
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </aside>

      {/* Search modal */}
      {showSearch && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" onClick={() => { setShowSearch(false); setSearch(''); }}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div className="relative w-full max-w-md mx-4 animate-slide-up rounded-2xl overflow-hidden"
            style={{ background: '#0d0d1a', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 30px 80px rgba(0,0,0,0.9)' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <Search size={15} className="text-gray-500 shrink-0" />
              <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search pages..." className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-600 focus:outline-none" />
              <button onClick={() => { setShowSearch(false); setSearch(''); }} className="text-gray-600 hover:text-gray-400 transition-colors">
                <X size={14} />
              </button>
            </div>
            <div className="p-2 max-h-72 overflow-y-auto">
              {filtered.length === 0
                ? <p className="text-center text-sm text-gray-600 py-10">No results found</p>
                : filtered.map(({ href, label, icon: Icon, color }) => (
                  <button key={href} onClick={() => goTo(href)}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-gray-400 hover:bg-white/[0.04] hover:text-gray-100 transition-all duration-150 text-left">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <Icon size={15} />
                    </div>
                    <span className="font-medium flex-1">{label}</span>
                    <ChevronRight size={13} className="text-gray-700" />
                  </button>
                ))}
            </div>
            <div className="px-4 py-2.5 flex items-center gap-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <span className="text-[10px] text-gray-700"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5 mr-1">&crarr;</kbd>select</span>
              <span className="text-[10px] text-gray-700"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5 mr-1">esc</kbd>close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
