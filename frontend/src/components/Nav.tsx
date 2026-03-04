'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearToken } from '@/lib/api';
import {
  LayoutDashboard, Server, Globe, Shield, Database,
  FolderOpen, FileText, Cpu, LogOut,
} from 'lucide-react';

const links = [
  { href: '/dashboard',  label: 'Dashboard',  icon: LayoutDashboard },
  { href: '/apps',       label: 'Apps',        icon: Server },
  { href: '/domains',    label: 'Domains',     icon: Globe },
  { href: '/ssl',        label: 'SSL',         icon: Shield },
  { href: '/databases',  label: 'Databases',   icon: Database },
  { href: '/redis',      label: 'Redis',       icon: Cpu },
  { href: '/files',      label: 'Files',       icon: FolderOpen },
  { href: '/logs',       label: 'Logs',        icon: FileText },
];

export default function Nav() {
  const pathname = usePathname();
  const router   = useRouter();

  function logout() {
    clearToken();
    router.push('/login');
  }

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-gray-800 bg-gray-900 fixed left-0 top-0">
      <div className="flex h-16 items-center px-5 border-b border-gray-800">
        <span className="text-lg font-bold text-white tracking-tight">Panel</span>
      </div>
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors
                ${active
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'}`}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>
      <button
        onClick={logout}
        className="flex items-center gap-3 px-6 py-4 text-sm text-gray-500 hover:text-red-400 transition-colors border-t border-gray-800"
      >
        <LogOut size={16} /> Sign out
      </button>
    </aside>
  );
}
