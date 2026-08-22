import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'ts-brand': '#654321',
      },
      spacing: {
        safe: '1.5rem',
      },
    },
  },
} satisfies Config;
