'use client'

import { useState, useEffect } from 'react'
import { TrendingUp, Target, Activity, Globe, Trophy, Dumbbell, Loader2, ChevronRight, BarChart2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

const COLORS = {
  success: '#10B981',
  nba: '#3B82F6',
  football: '#10B981',
  tennis: '#F97316',
}

interface SportSummary {
  name: string
  href: string
  icon: typeof Globe
  color: string
  accent: string
  count: number
  topMatch: { home: string; away: string; confidence: string; winner: string } | null
  loading: boolean
}

function ConfidenceBadge({ level }: { level: string }) {
  return (
    <span className={cn(
      'text-xs font-semibold px-2 py-0.5 rounded-full',
      level === 'alta'  ? 'bg-success/15 text-success' :
      level === 'media' ? 'bg-warning/15 text-warning' :
                          'bg-surface-2 text-text-muted'
    )}>
      {level === 'alta' ? 'Alta' : level === 'media' ? 'Media' : 'Baja'}
    </span>
  )
}

function ProbBar({ label, prob, color, active }: { label: string; prob: number; color: string; active: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('text-xs w-20 truncate', active ? 'text-text font-semibold' : 'text-text-muted')}>{label}</span>
      <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${prob * 100}%`, backgroundColor: active ? color : '#334155' }}
        />
      </div>
      <span className={cn('text-xs tabular-nums w-8 text-right', active ? 'text-text font-semibold' : 'text-text-muted')}>
        {(prob * 100).toFixed(0)}%
      </span>
    </div>
  )
}

export default function DashboardClient() {
  const [footballMatches, setFootballMatches] = useState<any[]>([])
  const [nbaMatches,      setNbaMatches]      = useState<any[]>([])
  const [tennisMatches,   setTennisMatches]   = useState<any[]>([])
  const [loading,         setLoading]         = useState(true)

  useEffect(() => {
    async function loadAll() {
      try {
        const [fb, nb, tn] = await Promise.all([
          fetch('/api/football/matches').then(r => r.ok ? r.json() : { matches: [] }),
          fetch('/api/nba/matches').then(r => r.ok ? r.json() : { matches: [] }),
          fetch('/api/tennis/matches').then(r => r.ok ? r.json() : { matches: [] }),
        ])
        setFootballMatches(fb.matches || [])
        setNbaMatches(nb.matches || [])
        setTennisMatches(tn.matches || [])
      } catch (e) {
        console.error('Dashboard load error', e)
      } finally {
        setLoading(false)
      }
    }
    loadAll()
  }, [])

  // Sort each sport by confidence: alta > media > baja
  const confidenceOrder = { alta: 0, media: 1, baja: 2 }
  const topFootball = [...footballMatches].sort((a, b) =>
    (confidenceOrder[a.prediction?.winner_confidence as keyof typeof confidenceOrder] ?? 2) -
    (confidenceOrder[b.prediction?.winner_confidence as keyof typeof confidenceOrder] ?? 2)
  ).slice(0, 4)

  const topNba = [...nbaMatches].sort((a, b) =>
    (confidenceOrder[a.prediction?.winner_confidence as keyof typeof confidenceOrder] ?? 2) -
    (confidenceOrder[b.prediction?.winner_confidence as keyof typeof confidenceOrder] ?? 2)
  ).slice(0, 4)

  const topTennis = [...tennisMatches].sort((a, b) =>
    (confidenceOrder[a.prediction?.winner_confidence as keyof typeof confidenceOrder] ?? 2) -
    (confidenceOrder[b.prediction?.winner_confidence as keyof typeof confidenceOrder] ?? 2)
  ).slice(0, 4)

  const stats = [
    { label: 'Partidos Fútbol', value: footballMatches.length, icon: Globe,   color: 'text-football-green', bg: 'bg-football-green/10' },
    { label: 'Partidos NBA',    value: nbaMatches.length,      icon: Trophy,  color: 'text-blue-400',       bg: 'bg-blue-400/10' },
    { label: 'Partidos Tenis',  value: tennisMatches.length,   icon: Dumbbell,color: 'text-tennis-orange',  bg: 'bg-tennis-orange/10' },
    {
      label: 'Confianza Alta',
      value: [
        ...footballMatches, ...nbaMatches, ...tennisMatches
      ].filter(m => m.prediction?.winner_confidence === 'alta').length,
      icon: Target,
      color: 'text-success',
      bg: 'bg-success/10',
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text">Dashboard</h1>
        <p className="text-text-muted text-sm mt-1">Análisis estadístico de partidos próximos</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(s => (
          <div key={s.label} className="card">
            <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center mb-3', s.bg)}>
              <s.icon className={cn('w-5 h-5', s.color)} />
            </div>
            {loading ? (
              <div className="h-8 w-12 bg-surface-2 rounded animate-pulse mb-1" />
            ) : (
              <div className="text-2xl font-bold text-text mb-0.5">{s.value}</div>
            )}
            <div className="text-xs text-text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-text-muted">
          <Loader2 className="w-8 h-8 animate-spin mr-3" />
          Cargando análisis...
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Football */}
          <SportSection
            title="Fútbol"
            href="/futbol"
            icon={Globe}
            color="text-football-green"
            accent="#10B981"
            matches={topFootball}
            renderMatch={(m) => {
              const p = m.prediction || {}
              const home = m.home_team?.name || 'Local'
              const away = m.away_team?.name || 'Visitante'
              const winner = p.predicted_winner === 'home' ? home : p.predicted_winner === 'away' ? away : 'Empate'
              return (
                <div key={m.id} className="p-3 rounded-lg bg-surface-2/40 border border-surface-2/60 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-muted truncate">{m.league}</span>
                    <ConfidenceBadge level={p.winner_confidence || 'baja'} />
                  </div>
                  <div className="text-sm font-semibold text-text truncate">{home} vs {away}</div>
                  <div className="space-y-1">
                    <ProbBar label={home} prob={p.p_home || 0} color="#10B981" active={p.predicted_winner === 'home'} />
                    <ProbBar label="Empate" prob={p.p_draw || 0} color="#10B981" active={p.predicted_winner === 'draw'} />
                    <ProbBar label={away} prob={p.p_away || 0} color="#10B981" active={p.predicted_winner === 'away'} />
                  </div>
                  <div className="text-xs text-text-muted">Goles esp: <span className="text-text font-medium">{p.exp_goals}</span> · Marcador: <span className="text-text font-medium">{p.most_likely_score}</span></div>
                </div>
              )
            }}
          />

          {/* NBA */}
          <SportSection
            title="NBA"
            href="/nba"
            icon={Trophy}
            color="text-blue-400"
            accent="#3B82F6"
            matches={topNba}
            renderMatch={(m) => {
              const p = m.prediction || {}
              const home = m.home_team?.name || 'Local'
              const away = m.away_team?.name || 'Visitante'
              return (
                <div key={m.id} className="p-3 rounded-lg bg-surface-2/40 border border-surface-2/60 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-muted">NBA</span>
                    <ConfidenceBadge level={p.winner_confidence || 'baja'} />
                  </div>
                  <div className="text-sm font-semibold text-text truncate">{home} vs {away}</div>
                  <div className="space-y-1">
                    <ProbBar label={home} prob={p.home_win_prob || 0} color="#3B82F6" active={p.predicted_winner === 'home'} />
                    <ProbBar label={away} prob={p.away_win_prob || 0} color="#3B82F6" active={p.predicted_winner === 'away'} />
                  </div>
                  <div className="text-xs text-text-muted">
                    Total pts: <span className="text-text font-medium">{p.exp_total_points}</span>
                    {p.pace && <> · Ritmo: <span className="text-text font-medium capitalize">{p.pace}</span></>}
                  </div>
                </div>
              )
            }}
          />

          {/* Tennis */}
          <SportSection
            title="Tenis ATP/WTA"
            href="/tenis"
            icon={Dumbbell}
            color="text-tennis-orange"
            accent="#F97316"
            matches={topTennis}
            renderMatch={(m) => {
              const p = m.prediction || {}
              const p1 = m.home_team?.name || 'P1'
              const p2 = m.away_team?.name || 'P2'
              return (
                <div key={m.id} className="p-3 rounded-lg bg-surface-2/40 border border-surface-2/60 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-muted">{m.league} · {m.surface}</span>
                    <ConfidenceBadge level={p.winner_confidence || 'baja'} />
                  </div>
                  <div className="text-sm font-semibold text-text truncate">{p1} vs {p2}</div>
                  <div className="space-y-1">
                    <ProbBar label={p1} prob={p.p1_win_prob || 0} color="#F97316" active={p.predicted_winner === 'p1'} />
                    <ProbBar label={p2} prob={p.p2_win_prob || 0} color="#F97316" active={p.predicted_winner === 'p2'} />
                  </div>
                  <div className="text-xs text-text-muted">
                    Sets: <span className="text-text font-medium">{p.most_likely_result || '2-1'}</span>
                    {p.exp_total_games && <> · Juegos: <span className="text-text font-medium">{p.exp_total_games}</span></>}
                  </div>
                </div>
              )
            }}
          />
        </div>
      )}
    </div>
  )
}

function SportSection({
  title, href, icon: Icon, color, matches, renderMatch
}: {
  title: string; href: string; icon: typeof Globe; color: string; accent: string; matches: any[];
  renderMatch: (m: any) => React.ReactNode
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon className={cn('w-5 h-5', color)} />
          <h3 className="font-bold text-text">{title}</h3>
          <span className="text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded-full">{matches.length}</span>
        </div>
        <Link href={href} className={cn('flex items-center gap-1 text-xs font-semibold hover:underline', color)}>
          Ver todos <ChevronRight className="w-3 h-3" />
        </Link>
      </div>
      {matches.length === 0 ? (
        <div className="text-center py-8 text-text-muted text-sm">
          <BarChart2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
          No hay partidos próximos
        </div>
      ) : (
        <div className="space-y-3">
          {matches.map(renderMatch)}
        </div>
      )}
    </div>
  )
}
