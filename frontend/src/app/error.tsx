'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="text-center max-w-md px-6">
        <div className="mx-auto mb-6 h-14 w-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
          <AlertTriangle size={26} className="text-red-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Something went wrong</h2>
        <p className="text-sm text-gray-500 mb-6">
          {error.message || 'An unexpected error occurred. Please try again.'}
        </p>
        <button onClick={reset} className="btn-primary">
          <RotateCcw size={15} />
          Try again
        </button>
      </div>
    </div>
  );
}
