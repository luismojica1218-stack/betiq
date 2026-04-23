'use client'

import { useState, useEffect } from 'react'
import { Trophy, Clock, BarChart2, Activity, Users, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'

// ---- Types ------------------------------------------------------------------
type FilterDate   = 'today' | 'tomorrow' | '7days'
type AnalysisView = 'ganador' | 'puntos' | 'estadisticas'

interface PointsRange {
  under_210: number
  p_210_225: number
  p_225_240: number
  over_240: number
}

interface NbaPrediction {
  home_win_prob: number
  away_win_prob: number
  predicted_winner: 'home' | 'away'
  winner_confidence: 'alta' | 'media' | 'baja'
  model_source: string
  exp_total_points: number
  home_proj_pts: number
  away_proj_pts: number
  home_proj_reb: number
  away_proj_reb: number
  home_proj_ast: number
  away_proj_ast: number
  points_range: PointsRange
  top_scoring_team: 'home' | 'away'
  pace: 'rapido' | 'moderado' | 'lento'
  blowout_probability: number
}

interface MappedMatch {
  id: string
  homeTeam: string
  awayTeam: string
  date: string
  rawDate: string
  pred: NbaPrediction
}

// ---- Helpers ----------------------------------------------------------------
function ConfidenceBadge({ level }: { level: 'alta' | 'media' | 'baja' }) {
  const map = {
    alta:  { cls: 'badge badge-success', label: 'Confianza Alta' },
    media: { cls: 'badge badge-warning', label: 'Confianza Media' },
    baja:  { cls: 'badge badge-danger',  label: 'Confianza Baja' },
  }
  const { cls, label } = map[level]
  return <span className={cls}>{label}</span>
}

function PaceBadge({ pace }: { pace: 'rapido' | 'moderado' | 'lento' }) {
  const map = {
    rapido:   { cls: 'badge badge-danger',   label: 'Ritmo: Rápido' },
    moderado: { cls: 'badge badge-warning',  label: 'Ritmo: Moderado' },
    lento:    { cls: 'badge badge-blue',     label: 'Ritmo: Lento' },
  }
  const { cls, label } = map[pace]
  return <span className={cls}>{label}</span>
}

function WinProbBar({ label, prob, highlight }: { label: string; prob: number; highlight: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1 p-2.5 rounded-lg border', highlight ? 'bg-blue-400/10 border-blue-400/30' : 'bg-surface-2/30 border-transparent')}>
      <div className="flex justify-between items-center text-xs">
        <span className={cn('font-semibold', highlight ? 'text-blue-400' : 'text-text-muted')}>{label}</span>
        <span className={cn('font-bold', highlight ? 'text-blue-400' : 'text-text')}>{(prob * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${prob * 100}%`,
            backgroundColor: highlight ? 'rgb(96 165 250)' : 'rgb(var(--color-text-muted) / 0.3)',
          }}
        />
      </div>
    </div>
  )
}

function MiniDistBar({ label, prob }: { label: string; prob: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
        <div className="h-full bg-blue-400/70 rounded-full transition-all duration-700" style={{ width: `${prob * 100}%` }} />
      </div>
      <span className="text-xs font-bold text-text w-8 text-right">{(prob * 100).toFixed(0)}%</span>
    </div>
  )
}

function mapMatches(rawMatches: any[]): MappedMatch[] {
  return rawMatches.map((m: any) => {
    const pred = m.prediction || {}
    return {
      id: m.id,
      homeTeam: m.home_team?.name || 'Local',
      awayTeam: m.away_team?.name || 'Visitante',
      date: new Date(m.match_date).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      rawDate: m.match_date,
      pred: {
        home_win_prob:      pred.home_win_prob ?? 0.50,
        away_win_prob:      pred.away_win_prob ?? 0.50,
        predicted_winner:   pred.predicted_winner ?? 'home',
        winner_confidence:  pred.winner_confidence ?? 'baja',
        model_source:       pred.model_source ?? 'Pythagorean',
        exp_total_points:   pred.exp_total_points ?? 220,
        home_proj_pts:      pred.home_proj_pts ?? 110,
        away_proj_pts:      pred.away_proj_pts ?? 110,
        home_proj_reb:      pred.home_proj_reb ?? 44,
        away_proj_reb:      pred.away_proj_reb ?? 44,
        home_proj_ast:      pred.home_proj_ast ?? 25,
        away_proj_ast:      pred.away_proj_ast ?? 25,
        points_range:       pred.points_range ?? { under_210: 0.20, p_210_225: 0.40, p_225_240: 0.30, over_240: 0.10 },
        top_scoring_team:   pred.top_scoring_team ?? 'home',
        pace:               pred.pace ?? 'moderado',
        blowout_probability: pred.blowout_probability ?? 0.18,
      },
    }
  })
}

// ---- Main component ---------------------------------------------------------
export default function NBAClient() {
  const [filterDate,   setFilterDate]   = useState<FilterDate>('7days')
  const [activeView,   setActiveView]   = useState<AnalysisView>('ganador')
  const [liveMatches,  setLiveMatches]  = useState<MappedMatch[]>([])
  const [isLoading,    setIsLoading]    = useState(true)

  async function fetchAndSet() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/nba/matches')
      if (res.ok) {
        const data = await res.json()
        if (data.matches?.length > 0) setLiveMatches(mapMatches(data.matches))
      }
    } catch (err) {
      console.error('NBA fetch error', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { fetchAndSet() }, [])

  const filtered = liveMatches.filter(m => {
    if (filterDate === 'today') {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const mDate = new Date(m.rawDate); mDate.setHours(0, 0, 0, 0)
      if (mDate.getTime() !== today.getTime()) return false
    }
    if (filterDate === 'tomorrow') {
      const tom = new Date(); tom.setDate(tom.getDate() + 1); tom.setHours(0, 0, 0, 0)
      const mDate = new Date(m.rawDate); mDate.setHours(0, 0, 0, 0)
      if (mDate.getTime() !== tom.getTime()) return false
    }
    return true
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text flex items-center gap-3">
            <Trophy className="w-6 h-6 text-blue-400" />
            NBA — Análisis Estadístico
          </h2>
          <p className="text-text-muted text-sm mt-1">
            Probabilidades de victoria · Proyecciones de puntos · Estadísticas de equipo
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAndSet}
            className="flex items-center gap-1 text-xs px-2.5 py-2 rounded-lg bg-surface-2 text-text-muted hover:text-text transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Actualizar
          </button>
          <div className="flex items-center gap-2 text-xs bg-surface-2 text-text-muted px-3 py-2 rounded-lg">
            <Clock className="w-3.5 h-3.5" />
            Datos en tiempo real
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card py-4 flex flex-wrap items-center gap-4">
        {/* Date filter */}
        <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
          {([['today', 'Hoy'], ['tomorrow', 'Mañana'], ['7days', '7 Días']] as [FilterDate, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilterDate(val)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                filterDate === val ? 'bg-blue-400/80 text-white' : 'text-text-muted hover:text-text'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Analysis view selector */}
        <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1">
          {([
            ['ganador',       'Ganador',     BarChart2],
            ['puntos',        'Puntos',      Activity],
            ['estadisticas',  'Estadísticas', Users],
          ] as [AnalysisView, string, React.ElementType][]).map(([val, label, Icon]) => (
            <button
              key={val}
              onClick={() => setActiveView(val)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                activeView === val ? 'bg-blue-400/80 text-white' : 'text-text-muted hover:text-text'
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Match grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
            <p>Cargando predicciones NBA...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Trophy className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No hay partidos con los filtros actuales</p>
          </div>
        ) : filtered.map(match => {
          const p = match.pred
          const isHomeWinner = p.predicted_winner === 'home'

          return (
            <div key={match.id} className="card space-y-4">
              {/* Card header: teams + date */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-text-muted flex items-center gap-1">
                    <Clock className="w-3 h-3" />{match.date}
                  </span>
                  <span className="text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">
                    {p.model_source}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={cn('font-bold text-sm', isHomeWinner ? 'text-blue-400' : 'text-text')}>
                    {match.homeTeam}
                  </span>
                  <span className="text-text-muted text-xs px-2">vs</span>
                  <span className={cn('font-bold text-sm text-right', !isHomeWinner ? 'text-blue-400' : 'text-text')}>
                    {match.awayTeam}
                  </span>
                </div>
              </div>

              {/* ── Ganador view ── */}
              {activeView === 'ganador' && (
                <div className="space-y-3">
                  <WinProbBar label={`Local — ${match.homeTeam}`} prob={p.home_win_prob} highlight={isHomeWinner} />
                  <WinProbBar label={`Visitante — ${match.awayTeam}`} prob={p.away_win_prob} highlight={!isHomeWinner} />
                  <div className="flex flex-wrap gap-2">
                    <ConfidenceBadge level={p.winner_confidence} />
                    <PaceBadge pace={p.pace} />
                  </div>
                  <div className="bg-surface-2/60 rounded-lg px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-text-muted">Probabilidad de paliza (&gt;15pts)</span>
                    <span className="text-sm font-bold text-text">{(p.blowout_probability * 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}

              {/* ── Puntos view ── */}
              {activeView === 'puntos' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Total puntos esperado</span>
                    <span className="text-xl font-black text-blue-400">{p.exp_total_points.toFixed(1)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className={cn('rounded-lg px-3 py-2 text-center', p.top_scoring_team === 'home' ? 'bg-blue-400/10 border border-blue-400/30' : 'bg-surface-2/60')}>
                      <div className="text-xs text-text-muted truncate">{match.homeTeam}</div>
                      <div className={cn('text-lg font-black', p.top_scoring_team === 'home' ? 'text-blue-400' : 'text-text')}>
                        {p.home_proj_pts.toFixed(0)}
                      </div>
                      <div className="text-xs text-text-muted">pts proy.</div>
                    </div>
                    <div className={cn('rounded-lg px-3 py-2 text-center', p.top_scoring_team === 'away' ? 'bg-blue-400/10 border border-blue-400/30' : 'bg-surface-2/60')}>
                      <div className="text-xs text-text-muted truncate">{match.awayTeam}</div>
                      <div className={cn('text-lg font-black', p.top_scoring_team === 'away' ? 'text-blue-400' : 'text-text')}>
                        {p.away_proj_pts.toFixed(0)}
                      </div>
                      <div className="text-xs text-text-muted">pts proy.</div>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Distribución de puntos</p>
                    <MiniDistBar label="Menos de 210" prob={p.points_range.under_210} />
                    <MiniDistBar label="210–225"      prob={p.points_range.p_210_225} />
                    <MiniDistBar label="225–240"      prob={p.points_range.p_225_240} />
                    <MiniDistBar label="Más de 240"   prob={p.points_range.over_240} />
                  </div>
                </div>
              )}

              {/* ── Estadísticas view ── */}
              {activeView === 'estadisticas' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-4 gap-0 text-xs font-semibold text-text-muted border-b border-surface-2 pb-1">
                    <span></span>
                    <span className="text-center">PTS</span>
                    <span className="text-center">REB</span>
                    <span className="text-center">AST</span>
                  </div>
                  {/* Home row */}
                  <div className="grid grid-cols-4 gap-0 items-center">
                    <span className={cn('text-xs font-semibold truncate', p.top_scoring_team === 'home' ? 'text-blue-400' : 'text-text')}>
                      {match.homeTeam.split(' ').pop()}
                    </span>
                    <span className={cn('text-sm font-bold text-center', p.top_scoring_team === 'home' ? 'text-blue-400' : 'text-text')}>
                      {p.home_proj_pts.toFixed(0)}
                    </span>
                    <span className="text-sm font-bold text-center text-text">{p.home_proj_reb.toFixed(0)}</span>
                    <span className="text-sm font-bold text-center text-text">{p.home_proj_ast.toFixed(0)}</span>
                  </div>
                  {/* Away row */}
                  <div className="grid grid-cols-4 gap-0 items-center">
                    <span className={cn('text-xs font-semibold truncate', p.top_scoring_team === 'away' ? 'text-blue-400' : 'text-text')}>
                      {match.awayTeam.split(' ').pop()}
                    </span>
                    <span className={cn('text-sm font-bold text-center', p.top_scoring_team === 'away' ? 'text-blue-400' : 'text-text')}>
                      {p.away_proj_pts.toFixed(0)}
                    </span>
                    <span className="text-sm font-bold text-center text-text">{p.away_proj_reb.toFixed(0)}</span>
                    <span className="text-sm font-bold text-center text-text">{p.away_proj_ast.toFixed(0)}</span>
                  </div>
                  {p.top_scoring_team && (
                    <p className="text-xs text-text-muted">
                      Mayor anotador proyectado:{' '}
                      <span className="text-blue-400 font-semibold">
                        {p.top_scoring_team === 'home' ? match.homeTeam : match.awayTeam}
                      </span>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <ConfidenceBadge level={p.winner_confidence} />
                    <PaceBadge pace={p.pace} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Info note */}
      <div className="card bg-blue-400/5 border-blue-400/10 flex items-start gap-3">
        <Trophy className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-text-muted">
          <span className="text-text font-semibold">Modelo Pythagorean + ML.</span>{' '}
          Las proyecciones combinan eficiencia ofensiva/defensiva histórica con ajustes de ritmo de juego.
          Los porcentajes representan probabilidades del modelo, no resultados garantizados.
        </div>
      </div>
    </div>
  )
}
