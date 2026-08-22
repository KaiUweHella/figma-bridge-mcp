import forms from '@tailwindcss/forms';

export default {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  plugins: [forms],
  theme: {
    colors: {
      'esm-brand': '#123456',
    },
  },
};
