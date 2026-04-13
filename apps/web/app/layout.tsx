import type { Metadata, Viewport } from 'next'
import './globals.css'
import Providers from '@/components/layout/Providers'

export const viewport: Viewport = {
  themeColor: '#1A1A2E',
}

export const metadata: Metadata = {
  title: { default: 'BetIQ — Pronósticos Inteligentes', template: '%s | BetIQ' },
  description: 'Plataforma de inteligencia artificial para pronósticos deportivos. NBA, Fútbol y Tenis con modelos ML y gestión de presupuesto.',
  keywords: ['pronósticos deportivos', 'apuestas IA', 'NBA predictions', 'bet intelligence'],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
