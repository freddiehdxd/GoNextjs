'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Nav from './Nav';

export default function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    if (!localStorage.getItem('panel_token')) router.replace('/login');
  }, [router]);

  return (
    <div className="flex min-h-screen bg-[#080810]">
      <Nav />
      <main className="flex-1 ml-60 min-h-screen overflow-y-auto">
        <div className="max-w-7xl mx-auto px-8 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
