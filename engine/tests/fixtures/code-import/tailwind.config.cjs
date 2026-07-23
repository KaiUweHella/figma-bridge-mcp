module.exports = {
  theme: {
    colors: {
      transparent: 'transparent',
      blue: { 50: '#eff6ff', 500: '#3b82f6', 900: '#1e3a8a' },
      white: '#ffffff',
    },
    borderRadius: { sm: '0.125rem', md: '0.375rem', full: '9999px' },
    spacing: { 1: '0.25rem', 4: '1rem' },
    fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['SF Mono'] },
    fontSize: { sm: ['14px', { lineHeight: '20px' }], base: '16px' },
    extend: {
      colors: { brand: '#0969da' },
    },
  },
};
