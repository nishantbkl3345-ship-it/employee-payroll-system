/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#0b0b0b',
          soft: '#52514e',
          muted: '#84837c',
        },
        surface: {
          DEFAULT: '#ffffff',
          sunken: '#f7f7f5',
          line: '#e6e5e0',
        },
        brand: {
          50: '#eff6fe',
          100: '#cde2fb',
          200: '#9ec5f4',
          400: '#3987e5',
          500: '#2a78d6',
          600: '#256abf',
          700: '#1c5cab',
        },
        accent: '#eb6834',
        positive: '#1baf7a',
        danger: '#e34948',
        warn: '#eda100',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(11,11,11,0.04), 0 1px 12px rgba(11,11,11,0.04)',
      },
    },
  },
  plugins: [],
};
