/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#1A1A2E',
        surface: '#16213E',
        'surface-2': '#0F3460',
        accent: '#E94560',
        'accent-hover': '#c73652',
        text: '#F0F4F8',
        'text-muted': '#8892A4',
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
        'nba-blue': '#1D428A',
        'football-green': '#27AE60',
        'tennis-orange': '#E67E22',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'accent-gradient': 'linear-gradient(135deg, #E94560 0%, #c73652 100%)',
        'card-gradient': 'linear-gradient(145deg, #16213E 0%, #0F3460 100%)',
      },
      boxShadow: {
        card: '0 4px 20px rgba(0,0,0,0.4)',
        accent: '0 4px 20px rgba(233,69,96,0.3)',
        glow: '0 0 30px rgba(233,69,96,0.2)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
      },
    },
  },
  plugins: [],
}
