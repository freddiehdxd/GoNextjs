import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      colors: {
        panel: { bg: '#080810', surface: '#0f0f1a' },
      },
      boxShadow: {
        'glow-violet': '0 0 40px -8px rgba(139,92,246,0.35)',
        'glow-emerald': '0 0 40px -8px rgba(52,211,153,0.25)',
        'glow-red':    '0 0 40px -8px rgba(239,68,68,0.25)',
        'modal':       '0 25px 60px rgba(0,0,0,0.8)',
      },
    },
  },
  plugins: [],
};

export default config;
