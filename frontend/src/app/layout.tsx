import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Panel — Server Control',
  description: 'Self-hosted Next.js deployment panel',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
