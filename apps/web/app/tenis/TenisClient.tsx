'use client'

import { useState, useEffect } from 'react'
import { Dumbbell, Clock, BarChart2, Layers, Hash, Activity, Trophy, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// ---- Types ------------------------------------------------------------------
type AnalysisView = 'ganador' | 'sets' | 'juegos'

interface TennisPrediction {
  p1_win_prob: number
  p2_win_prob: number
  predicted_winner: 'p1' | 'p2'
  winner_confidence: 'alta' | 'media' | 'baja'
  elo_p1: number
  elo_p2: number
  elo_diff: number
  surface_advantage: 'p1' | 'p2' | 'neutral'
  p_straight_sets: number
  p_three_sets: number
  exp_sets: number
  most_likely_result: '2-0' | '2-1'
  exp_total_games: number
  p_over_22_5: number
  p_under_22_5: number
  p_handicap_p1: number
  p_firstset_p1: number
}

interface MappedMatch {
  id: string
  tour: string
  tournament: string
  surface: string
  round: string
  date: string
  player1: string
  player2: string
  pred: TennisPrediction
}

// ---- Config -----------------------------------------------------------------
const TOURS = [
  { key: 'all', label: 'Todos',    color: 'text-text' },
  { key: 'ATP', label: 'ATP Tour', color: 'text-blue-400' },
  { key: 'WTA', label: 'WTA Tour', color: 'text-pink-400' },
]

const SURFACES = [
  { key: 'all',    label: 'Todas',  bgColor: 'bg-surface-2 text-text-muted' },
  { key: 'hard',   label: 'Hard',   bgColor: 'bg-blue-500/20 text-blue-400' },
  { key: 'clay',   label: 'Clay',   bgColor: 'bg-orange-500/20 text-orange-400' },
  { key: 'grass',  label: 'Grass',  bgColor: 'bg-green-500/20 text-green-400' },
  { key: 'indoor', label: 'Indoor', bgColor: 'bg-purple-500/20 text-purple-400' },
]

// ---- Helpers ----------------------------------------------------------------
function surfaceSlug(m: any): string {
  const raw = (m.surface || '').toLowerCase()
  if (raw && raw !== 'unknown') return raw
  const t = (m.tournament || m.round || '').toLowerCase()
  if (t.includes('clay') || t.includes('monte') || t.includes('madrid') || t.includes('rome') || t.includes('roland') || t.includes('barcelona')) return 'clay'
  if (t.includes('wimbledon') || t.includes('grass') || t.includes('queen') || t.includes('halle')) return 'grass'
  return 'hard'
}

function ConfidenceBadge({ level }: { level: 'alta' | 'media' | 'baja' }) {
  const map = {
    alta:  { cls: 'badge badge-success', label: 'Confianza Alta' },
    media: { cls: 'badge badge-warning', label: 'Confianza Media' },
    baja:  { cls: 'badge badge-danger',  label: 'Confianza Baja' },
  }
  const { cls, label } = map[level]
  return <span className={cls}>{label}</span>
}

function SurfaceAdvantageBadge({ adv, p1, p2 }: { adv: 'p1' | 'p2' | 'neutral'; p1: string; p2: string }) {
  if (adv === 'neutral') return <span className="badge badge-blue">Superficie: Neutral</span>
  const name = adv === 'p1' ? p1 : p2
  return <span className="badge badge-warning">Ventaja superficie: {name}</span>
}

function ProbBar({ label, prob, highlight, accentColor = 'bg-tennis-orange' }: {
  label: string; prob: number; highlight: boolean; accentColor?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 p-2.5 rounded-lg border', highlight ? 'bg-tennis-orange/10 border-tennis-orange/30' : 'bg-surface-2/30 border-transparent')}>
      <div className="flex justify-between items-center text-xs">
        <span className={cn('font-semibold', highlight ? 'text-tennis-orange' : 'text-text-muted')}>{label}</span>
        <span className={cn('font-bold', highlight ? 'text-tennis-orange' : 'text-text')}>{(prob * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-700', highlight ? accentColor : 'bg-surface-2')}
          style={{ width: `${prob * 100}%`, backgroundColor: highlight ? undefined : 'rgb(var(--color-text-muted) / 0.3)' }}
        />
      </div>
    </div>
  )
}

// ---- Main component ---------------------------------------------------------
export default function TenisClient() {
  const [activeTour,    setActiveTour]    = useState('all')
  const [activeSurface, setActiveSurface] = useState('all')
  const [activeView,    setActiveView]    = useState<AnalysisView>('ganador')
  const [liveMatches,   setLiveMatches]   = useState<MappedMatch[]>([])
  const [isLoading,     setIsLoading]     = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      try {
        const res = await fetch('/api/tennis/matches')
        if (res.ok) {
          const data = await res.json()
          if (data.matches && data.matches.length > 0) {
            const mapped: MappedMatch[] = data.matches.map((m: any) => {
              const pred = m.prediction || {}
              const p1Win = pred.p1_win_prob ?? 0.50
              return {
                id: m.id,
                tour: (m.league || 'ATP').toUpperCase().includes('WTA') ? 'WTA' : 'ATP',
                tournament: m.tournament || m.round || 'Tournament',
                surface: surfaceSlug(m),
                round: m.round || 'Round',
                date: new Date(m.match_date).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
                player1: m.home_team?.name || 'Player 1',
                player2: m.away_team?.name || 'Player 2',
                pred: {
                  p1_win_prob:        p1Win,
                  p2_win_prob:        pred.p2_win_prob ?? (1 - p1Win),
                  predicted_winner:   pred.predicted_winner ?? 'p1',
                  winner_confidence:  pred.winner_confidence ?? 'baja',
                  elo_p1:             pred.elo_p1 ?? 2000,
                  elo_p2:             pred.elo_p2 ?? 2000,
                  elo_diff:           pred.elo_diff ?? 0,
                  surface_advantage:  pred.surface_advantage ?? 'neutral',
                  p_straight_sets:    pred.p_straight_sets ?? 0.45,
                  p_three_sets:       pred.p_three_sets ?? 0.55,
                  exp_sets:           pred.exp_sets ?? 2.5,
                  most_likely_result: pred.most_likely_result ?? '2-1',
                  exp_total_games:    pred.exp_total_games ?? 22,
                  p_over_22_5:        pred.p_over_22_5 ?? 0.50,
                  p_under_22_5:       pred.p_under_22_5 ?? 0.50,
                  p_handicap_p1:      pred.p_handicap_p1 ?? 0.50,
                  p_firstset_p1:      pred.p_firstset_p1 ?? 0.50,
                },
              }
            })
            setLiveMatches(mapped)
          }
        }
      } catch (err) {
        console.error('Tennis fetch error', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchMatches()
  }, [])

  const filtered = liveMatches.filter(m => {
    if (activeTour    !== 'all' && m.tour    !== activeTour)    return false
    if (activeSurface !== 'all' && m.surface !== activeSurface) return false
    return true
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text flex items-center gap-3">
            <Dumbbell className="w-6 h-6 text-tennis-orange" />
            Tenis — Análisis Estadístico
          </h2>
          <p className="text-text-muted text-sm mt-1">
            ATP/WTA · Modelos Elo por superficie · Probabilidades de sets y juegos
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted bg-surface-2 px-3 py-2 rounded-lg">
          <Clock className="w-3.5 h-3.5" />
          Actualizado hace 12 min
        </div>
      </div>

      {/* Tour + Surface filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1 bg-surface-2/40 rounded-xl p-1.5 w-max">
          {TOURS.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTour(t.key)}
              className={cn(
                'px-4 py-1.5 rounded-lg text-sm font-semibold transition-all',
                activeTour === t.key ? 'bg-surface text-text shadow-md' : 'text-text-muted hover:text-text'
              )}
            >
              <span className={activeTour === t.key ? t.color : ''}>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {SURFACES.map(s => (
            <button
              key={s.key}
              onClick={() => setActiveSurface(s.key)}
              className={cn(
                'px-3 py-1 text-xs font-semibold rounded-md transition-all',
                activeSurface === s.key ? s.bgColor : 'bg-surface-2 text-text-muted hover:text-text'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Analysis view selector */}
      <div className="flex items-center gap-1 bg-surface-2 rounded-lg p-1 w-max">
        {([
          ['ganador', 'Ganador', BarChart2],
          ['sets',    'Sets',    Layers],
          ['juegos',  'Juegos',  Hash],
        ] as [AnalysisView, string, React.ElementType][]).map(([val, label, Icon]) => (
          <button
            key={val}
            onClick={() => setActiveView(val)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
              activeView === val ? 'bg-tennis-orange/80 text-white' : 'text-text-muted hover:text-text'
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Match grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3" />
            <p>Cargando predicciones de tenis...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="col-span-full text-center py-12 text-text-muted">
            <Dumbbell className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No hay partidos disponibles con los filtros actuales</p>
          </div>
        ) : filtered.map(match => {
          const p = match.pred
          const surfConf = SURFACES.find(s => s.key === match.surface)
          const isP1Winner = p.predicted_winner === 'p1'

          return (
            <div key={match.id} className="card space-y-4">
              {/* Header: tournament + surface + round */}
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('text-xs font-bold capitalize px-2 py-0.5 rounded', surfConf?.bgColor)}>
                      {match.surface}
                    </span>
                    <span className="text-xs text-text-muted font-medium">{match.tour} · {match.tournament}</span>
                  </div>
                  <div className="text-xs text-text-muted flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {match.date} · {match.round}
                  </div>
                </div>
              </div>

              {/* Players with Elo */}
              <div className="flex items-center bg-surface-2/30 rounded-lg border border-surface-2 overflow-hidden">
                <div className={cn('flex-1 text-center p-3', isP1Winner ? 'bg-tennis-orange/10' : '')}>
                  <div className={cn('font-bold text-sm', isP1Winner ? 'text-tennis-orange' : 'text-text')}>
                    {match.player1}
                  </div>
                  <div className="text-xs text-text-muted flex items-center justify-center gap-1 mt-0.5">
                    <Activity className="w-3 h-3 text-tennis-orange" /> Elo: {p.elo_p1}
                  </div>
                </div>
                <div className="px-3 text-xs text-text-muted font-bold shrink-0">VS</div>
                <div className={cn('flex-1 text-center p-3', !isP1Winner ? 'bg-tennis-orange/10' : '')}>
                  <div className={cn('font-bold text-sm', !isP1Winner ? 'text-tennis-orange' : 'text-text')}>
                    {match.player2}
                  </div>
                  <div className="text-xs text-text-muted flex items-center justify-center gap-1 mt-0.5">
                    <Activity className="w-3 h-3 text-tennis-orange" /> Elo: {p.elo_p2}
                  </div>
                </div>
              </div>

              {/* Surface advantage badge */}
              <div className="flex flex-wrap gap-2">
                <SurfaceAdvantageBadge adv={p.surface_advantage} p1={match.player1} p2={match.player2} />
              </div>

              {/* ── Ganador view ── */}
              {activeView === 'ganador' && (
                <div className="space-y-2">
                  <ProbBar label={match.player1} prob={p.p1_win_prob} highlight={isP1Winner} />
                  <ProbBar label={match.player2} prob={p.p2_win_prob} highlight={!isP1Winner} />
                  <ConfidenceBadge level={p.winner_confidence} />
                  <p className="text-xs text-text-muted">
                    Ganador proyectado:{' '}
                    <span className="text-tennis-orange font-semibold">
                      {isP1Winner ? match.player1 : match.player2}
                    </span>
                  </p>
                </div>
              )}

              {/* ── Sets view ── */}
              {activeView === 'sets' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Resultado más probable</span>
                    <span className="badge badge-blue">{p.most_likely_result}</span>
                  </div>
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Sets esperados</span>
                    <span className="text-lg font-black text-tennis-orange">{p.exp_sets.toFixed(1)}</span>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Escenarios</p>
                    <ProbBar label="Sets directos (2-0)" prob={p.p_straight_sets} highlight={p.p_straight_sets > p.p_three_sets} />
                    <ProbBar label="Tres sets (2-1)"    prob={p.p_three_sets}    highlight={p.p_three_sets > p.p_straight_sets} />
                  </div>
                </div>
              )}

              {/* ── Juegos view ── */}
              {activeView === 'juegos' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between bg-surface-2/60 rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">Juegos totales esperados</span>
                    <span className="text-xl font-black text-tennis-orange">{p.exp_total_games.toFixed(0)}</span>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs text-text-muted font-semibold uppercase tracking-wide">Línea 22.5 juegos</p>
                    <div className={cn('flex flex-col gap-1 p-2.5 rounded-lg border', p.p_over_22_5 > p.p_under_22_5 ? 'bg-tennis-orange/10 border-tennis-orange/30' : 'bg-surface-2/30 border-transparent')}>
                      <div className="flex justify-between items-center text-xs">
                        <span className={cn('font-semibold', p.p_over_22_5 > p.p_under_22_5 ? 'text-tennis-orange' : 'text-text-muted')}>Más de 22.5</span>
                        <span className={cn('font-bold', p.p_over_22_5 > p.p_under_22_5 ? 'text-tennis-orange' : 'text-text')}>{(p.p_over_22_5 * 100).toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                        <div className="h-full bg-tennis-orange rounded-full transition-all duration-700" style={{ width: `${p.p_over_22_5 * 100}%` }} />
                      </div>
                    </div>
                    <div className={cn('flex flex-col gap-1 p-2.5 rounded-lg border', p.p_under_22_5 > p.p_over_22_5 ? 'bg-tennis-orange/10 border-tennis-orange/30' : 'bg-surface-2/30 border-transparent')}>
                      <div className="flex justify-between items-center text-xs">
                        <span className={cn('font-semibold', p.p_under_22_5 > p.p_over_22_5 ? 'text-tennis-orange' : 'text-text-muted')}>Menos de 22.5</span>
                        <span className={cn('font-bold', p.p_under_22_5 > p.p_over_22_5 ? 'text-tennis-orange' : 'text-text')}>{(p.p_under_22_5 * 100).toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                        <div className="h-full bg-tennis-orange rounded-full transition-all duration-700" style={{ width: `${p.p_under_22_5 * 100}%` }} />
                      </div>
                    </div>
                  </div>
                  <div className="bg-surface-2/60 rounded-lg px-3 py-2 flex items-center justify-between">
                    <span className="text-xs text-text-muted">1er set — {match.player1}</span>
                    <span className="text-sm font-bold text-text">{(p.p_firstset_p1 * 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Info note */}
      <div className="card bg-tennis-orange/5 border-tennis-orange/10 flex items-start gap-3">
        <Trophy className="w-5 h-5 text-tennis-orange flex-shrink-0 mt-0.5" />
        <div className="text-sm text-text-muted">
          <span className="text-text font-semibold">Ventaja del modelo:</span>{' '}
          Los rankings ATP/WTA tradicionales no reflejan el nivel real por superficie.
          El modelo ajusta el Elo de cada jugador según su rendimiento histórico en la superficie del torneo,
          combinándolo con análisis Machine Learning de tendencias recientes.
        </div>
      </div>
    </div>
  )
}
