'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Trophy, Globe, Dumbbell, Activity,
  Ticket, Wallet, Settings, LogOut, Zap, ChevronRight
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'

const navItems = [
  { href: '/dashboard',      label: 'Dashboard',      icon: LayoutDashboard },
  { href: '/nba',            label: 'NBA',             icon: Trophy },
  { href: '/futbol',         label: 'Fútbol',          icon: Globe },
  { href: '/tenis',          label: 'Tenis',           icon: Dumbbell },
  { href: '/scraping-hub',   label: 'Scraping Hub',    icon: Activity },
  { href: '/mis-apuestas',   label: 'Mis Apuestas',    icon: Ticket },
  { href: '/parlay',         label: 'Parlays',         icon: Zap },
  { href: '/budget',         label: 'Presupuesto',     icon: Wallet },
  { href: '/settings',       label: 'Configuración',   icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-surface border-r border-surface-2 flex flex-col z-50">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-surface-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center shadow-accent">
            <Zap className="w-5 h-5 text-white" fill="white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text tracking-tight">BetIQ</h1>
            <p className="text-xs text-text-muted">Predictions Engine</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group',
                active
                  ? 'bg-accent text-white shadow-accent'
                  : 'text-text-muted hover:text-text hover:bg-surface-2'
              )}
            >
              <Icon className={cn('w-4 h-4 flex-shrink-0', active ? 'text-white' : 'text-text-muted group-hover:text-text')} />
              <span className="flex-1">{label}</span>
              {active && <ChevronRight className="w-3 h-3 text-white/70" />}
            </Link>
          )
        })}
      </nav>

      {/* Sign out */}
      <div className="p-3 border-t border-surface-2">
        <button
          onClick={handleSignOut}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium
                     text-text-muted hover:text-danger hover:bg-danger/10 transition-all duration-200"
        >
          <LogOut className="w-4 h-4" />
          Cerrar Sesión
        </button>
      </div>
    </aside>
  )
}
