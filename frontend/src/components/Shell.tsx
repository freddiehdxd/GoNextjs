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
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 ml-56 min-h-screen p-8 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
