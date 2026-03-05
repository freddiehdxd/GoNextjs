import Link from 'next/link';
import { Home, FileQuestion } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#080810]">
      <div className="text-center max-w-md px-6">
        <div className="mx-auto mb-6 h-14 w-14 rounded-2xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
          <FileQuestion size={26} className="text-violet-400" />
        </div>
        <h1 className="text-5xl font-bold text-white mb-2">404</h1>
        <h2 className="text-lg font-semibold text-gray-400 mb-2">Page not found</h2>
        <p className="text-sm text-gray-600 mb-8">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link href="/dashboard" className="btn-primary inline-flex">
          <Home size={15} />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
