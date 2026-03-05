'use client';
import Nav from './Nav';

export default function Shell({ children }: { children: React.ReactNode }) {
  // Auth is now handled server-side by Next.js middleware (checks HttpOnly cookie).
  // No client-side localStorage check needed.
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
