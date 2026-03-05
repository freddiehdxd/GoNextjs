import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'ServerPanel',
    template: '%s | ServerPanel',
  },
  description: 'Self-hosted Next.js deployment panel',
  themeColor: '#080810',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <head>
        <meta name="color-scheme" content="dark" />
      </head>
      <body>{children}</body>
    </html>
  );
}
