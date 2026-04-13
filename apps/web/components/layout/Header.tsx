'use client'

import { Bell, User } from 'lucide-react'
import { useUserStore } from '@/lib/store'
import { formatCOP } from '@/lib/utils'

interface HeaderProps {
  userEmail?: string
}

export default function Header({ userEmail }: HeaderProps) {
  const { weeklyBudgetCOP, fixedPct, parlayPct } = useUserStore()

  return (
    <header className="h-16 border-b border-surface-2 bg-surface/50 backdrop-blur-sm flex items-center justify-between px-6 sticky top-0 z-40">
      {/* Budget indicator */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3 bg-surface-2 rounded-lg px-4 py-2">
          <div className="text-xs text-text-muted font-medium">PRESUPUESTO SEMANA</div>
          <div className="text-sm font-bold text-text">{formatCOP(weeklyBudgetCOP)}</div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="badge badge-blue">FIJA {fixedPct}%</span>
          <span className="badge badge-orange">PARLAY {parlayPct}%</span>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        <button className="relative w-9 h-9 rounded-lg bg-surface-2 hover:bg-accent/20 flex items-center justify-center transition-colors">
          <Bell className="w-4 h-4 text-text-muted" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-accent rounded-full" />
        </button>
        <div className="flex items-center gap-2 bg-surface-2 rounded-lg px-3 py-2">
          <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center">
            <User className="w-3.5 h-3.5 text-white" />
          </div>
          {userEmail && (
            <span className="text-xs text-text-muted hidden md:block max-w-32 truncate">
              {userEmail}
            </span>
          )}
        </div>
      </div>
    </header>
  )
}
